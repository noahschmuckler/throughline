// ------------------------------------------------------------------
// Throughline — async ingestion jobs + consult sessions (T16/T26).
//
// MACHINE-LOCAL on purpose: the jobs doc lives under the local install
// (default ./data/jobs.json), NOT beside THROUGHLINE_DB — state.json is
// OneDrive-synced between the dyad's machines and last-write-wins; two
// operators' in-flight jobs and chat sessions must never clobber or leak
// into each other. Same isolation stance as /api/fs/* and attachments.
// The Worker has no jobs store: it 501s and the front-end falls back to
// the synchronous /api/atomize + /api/consult paths.
//
// One doc, two arrays: { jobs:[], sessions:[] }. A consult_turn job points
// at its session, so "turn finished → transcript updated" is one atomic
// write. Writes mirror lib/store.js (tmp+rename) under an in-process
// promise-chain mutex — single Node process, no cross-process locking.
//
// The runner is INJECTED (configureRunner) so this module stays model-free
// and the state machine is unit-testable with fake runners.
// ------------------------------------------------------------------

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

export function jobsPath() {
  const p = process.env.THROUGHLINE_JOBS || './data/jobs.json';
  return resolve(REPO_ROOT, p);
}

const KEEP_TERMINAL = 50;                       // pruned oldest-first past this
const SESSION_MAX_AGE_MS = 7 * 24 * 3600 * 1000; // un-committed sessions expire

export function emptyJobsDoc() {
  return { jobs: [], sessions: [] };
}

export function normalizeJobsDoc(d) {
  const o = d && typeof d === 'object' ? d : {};
  return {
    ...o,
    jobs: Array.isArray(o.jobs) ? o.jobs : [],
    sessions: Array.isArray(o.sessions) ? o.sessions : [],
  };
}

// ---- store (mutex'd read-modify-write) ------------------------------

let _chain = Promise.resolve();
function withDoc(fn) {
  // Serialize every read-modify-write through one promise chain.
  const run = _chain.then(async () => {
    let doc;
    try {
      doc = normalizeJobsDoc(JSON.parse(await readFile(jobsPath(), 'utf8')));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      doc = emptyJobsDoc();
    }
    const { result, dirty } = await fn(doc);
    if (dirty) {
      const path = jobsPath();
      await mkdir(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      await rename(tmp, path);
    }
    return result;
  });
  // Keep the chain alive even when a step rejects.
  _chain = run.catch(() => {});
  return run;
}

const uid = (prefix) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const nowIso = () => new Date().toISOString();

// Oldest TERMINAL (done/error) jobs beyond the cap fall off; queued/running
// never prune. Dismissed sessions and stale un-committed ones expire too.
export function pruneDoc(doc, now = Date.now()) {
  const terminal = doc.jobs.filter(j => j.status === 'done' || j.status === 'error');
  if (terminal.length > KEEP_TERMINAL) {
    const cut = new Set(
      terminal.sort((a, b) => (a.updated_at || '').localeCompare(b.updated_at || ''))
        .slice(0, terminal.length - KEEP_TERMINAL).map(j => j.id));
    doc.jobs = doc.jobs.filter(j => !cut.has(j.id));
  }
  doc.sessions = doc.sessions.filter(s => {
    if (s.status === 'committed' || s.status === 'abandoned') return false;
    const age = now - Date.parse(s.updated_at || s.created_at || 0);
    return !(Number.isFinite(age) && age > SESSION_MAX_AGE_MS);
  });
  return doc;
}

// ---- jobs ------------------------------------------------------------

export async function createJob({ kind, title = '', input = {} }) {
  const job = {
    id: uid('job'), kind, status: 'queued',
    created_at: nowIso(), updated_at: nowIso(),
    started_at: null, finished_at: null, dismissed: false,
    title, input, result: null, error: null,
  };
  await withDoc(async (doc) => {
    // consult_turn: append the user's turn to the session in the SAME write,
    // so a crash between "user sent" and "job queued" can't lose the message.
    if (kind === 'consult_turn' && input.session_id && typeof input.content === 'string') {
      const s = doc.sessions.find(x => x.id === input.session_id);
      if (!s) throw new Error(`session ${input.session_id} not found`);
      s.messages.push({ role: 'user', content: input.content, at: nowIso() });
      s.updated_at = nowIso();
      job.input = { session_id: input.session_id, awaiting_decision_set: !!input.awaiting_decision_set, turn_index: s.messages.length - 1 };
    }
    doc.jobs.push(job);
    pruneDoc(doc);
    return { result: job, dirty: true };
  });
  schedule();
  return job;
}

export function getJob(id) {
  return withDoc(async (doc) => ({ result: doc.jobs.find(j => j.id === id) || null, dirty: false }));
}

export function listJobs({ since = null, status = null, kind = null } = {}) {
  return withDoc(async (doc) => {
    let out = doc.jobs;
    if (since) out = out.filter(j => (j.updated_at || '') > since);
    if (status) out = out.filter(j => j.status === status);
    if (kind) out = out.filter(j => j.kind === kind);
    return { result: out.slice().sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')), dirty: false };
  });
}

export function dismissJob(id) {
  return withDoc(async (doc) => {
    const j = doc.jobs.find(x => x.id === id);
    if (!j) return { result: null, dirty: false };
    j.dismissed = true;
    j.updated_at = nowIso();
    return { result: j, dirty: true };
  });
}

// ---- sessions (T26) ---------------------------------------------------

export async function createSession({ entry_id = null, new_container_ids = [], bundle = {} }) {
  const session = {
    id: uid('sess'), created_at: nowIso(), updated_at: nowIso(),
    entry_id, new_container_ids, bundle,
    messages: [], status: 'active', last_decision_set: null, review_context: null,
  };
  return withDoc(async (doc) => {
    doc.sessions.push(session);
    pruneDoc(doc);
    return { result: session, dirty: true };
  });
}

export function getSession(id) {
  return withDoc(async (doc) => ({ result: doc.sessions.find(s => s.id === id) || null, dirty: false }));
}

export function listSessions({ status = null } = {}) {
  return withDoc(async (doc) => {
    let out = doc.sessions;
    if (status) out = out.filter(s => s.status === status);
    return { result: out.slice().sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')), dirty: false };
  });
}

// Persist one turn onto a session's transcript (the consult_turn runner's
// way of recording the assistant reply).
export function appendSessionTurn(id, role, content) {
  return withDoc(async (doc) => {
    const s = doc.sessions.find(x => x.id === id);
    if (!s) return { result: null, dirty: false };
    s.messages.push({ role, content, at: nowIso() });
    s.updated_at = nowIso();
    return { result: s, dirty: true };
  });
}

// patch: { status?, message?, last_decision_set?, review_context? }
// `message` appends a user turn (the review's retarget note rides this).
export function updateSession(id, patch = {}) {
  return withDoc(async (doc) => {
    const s = doc.sessions.find(x => x.id === id);
    if (!s) return { result: null, dirty: false };
    if (typeof patch.message === 'string' && patch.message.trim()) {
      s.messages.push({ role: 'user', content: patch.message, at: nowIso() });
    }
    if (patch.status && ['active', 'reviewing', 'committed', 'abandoned'].includes(patch.status)) s.status = patch.status;
    if ('last_decision_set' in patch) s.last_decision_set = patch.last_decision_set;
    if ('review_context' in patch) s.review_context = patch.review_context;
    s.updated_at = nowIso();
    return { result: s, dirty: true };
  });
}

// ---- runner ------------------------------------------------------------

let _runners = {};   // kind -> async (job, helpers) => result object
let _cap = 3;
let _active = 0;

export function configureRunner({ runners = {}, concurrency = null } = {}) {
  _runners = runners;
  _cap = concurrency ?? parseInt(process.env.THROUGHLINE_JOB_CONCURRENCY || '3', 10);
  _active = 0; // fresh world — called at boot (and per-test); a runner orphaned
               // by a previous config must not hold a slot forever
}

async function setJob(id, patch) {
  return withDoc(async (doc) => {
    const j = doc.jobs.find(x => x.id === id);
    if (!j) return { result: null, dirty: false };
    Object.assign(j, patch, { updated_at: nowIso() });
    return { result: j, dirty: true };
  });
}

function schedule() {
  // Fire-and-forget; errors land on the job record, never the caller.
  setTimeout(() => { void pump(); }, 0);
}

async function pump() {
  if (_active >= _cap) return;
  _active++; // reserve the slot BEFORE the async claim — the check+claim must
             // be effectively atomic or N callers race past the cap together
  const next = await withDoc(async (doc) => {
    const j = doc.jobs
      .filter(x => x.status === 'queued')
      .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))[0];
    if (!j) return { result: null, dirty: false };
    j.status = 'running';
    j.started_at = nowIso();
    j.updated_at = nowIso();
    return { result: { ...j }, dirty: true };
  });
  if (!next) { _active--; return; }
  void pump(); // fill remaining slots in parallel
  try {
    const runner = _runners[next.kind];
    if (!runner) throw new Error(`no runner for job kind "${next.kind}"`);
    const result = await runner(next, { updateSession, getSession, appendSessionTurn });
    await setJob(next.id, { status: 'done', finished_at: nowIso(), result });
  } catch (err) {
    await setJob(next.id, { status: 'error', finished_at: nowIso(), error: err?.message || 'unknown error' });
  } finally {
    _active--;
    void pump();
  }
}

// Boot recovery: a `running` job died with the process (the model call is
// gone — fail it visibly); `queued` jobs simply re-enter the pump.
export async function sweepOnBoot() {
  await withDoc(async (doc) => {
    let dirty = false;
    for (const j of doc.jobs) {
      if (j.status === 'running') {
        j.status = 'error';
        j.error = 'server restarted mid-run — re-submit';
        j.finished_at = nowIso();
        j.updated_at = nowIso();
        dirty = true;
      }
    }
    pruneDoc(doc);
    return { result: null, dirty: true }; // one boot write keeps things tidy
  });
  schedule();
}
