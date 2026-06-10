#!/usr/bin/env node
// ------------------------------------------------------------------
// Throughline — Node HTTP server. The orange-device backend.
//
// Serves the same public/ SPA as the Cloudflare Worker and exposes the same
// API (GET/PUT /api/state, POST /api/atomize), so the front-end is byte-for-
// byte identical against either backend. State lives in one JSON file
// (THROUGHLINE_DB) — set that to a OneDrive shared-folder path on orange.
//
// Boots at 127.0.0.1:8787 by default (override via PORT). Node 20+.
// Run with `node --env-file=.env server.js` (or `npm start`).
// ------------------------------------------------------------------

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { readState, writeState, dbPath, readStateAt } from './lib/store.js';
import { loadFederated, saveFederated } from './lib/federation.js';
import { discoverCircles, circleById } from './lib/circles.js';
import { maybeAutoBackup, listBackups, readBackupContent, restoreBackup, writeBackup, BACKUP_RE } from './lib/backups.js';
import { listFolder, openFile } from './lib/files.js';
import { setupStatus, listSetupFolder, bindFolder, dbInfo } from './lib/setup.js';
import { atomizeEntry, atomizeOpts } from './shared/atomize.js';
import { classifyProject } from './shared/classify.js';
import { consultTurn } from './shared/consult.js';
import {
  createJob, getJob, listJobs, dismissJob,
  createSession, getSession, updateSession, appendSessionTurn, listSessions,
  configureRunner, sweepOnBoot,
} from './lib/jobs.js';
import { makeLLMCall, describeLLM } from './shared/llm.js';
import { getAuthStatus, initiateDeviceCode, signOut, acquireTokenSilentOrNull } from './lib/graph-client.js';
import { listLoopFiles, loopToMarkdown } from './lib/loop.js';
import { loopHtmlToMarkdown } from './lib/loop-html.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  const isBuf = typeof body === 'string' || Buffer.isBuffer(body);
  const payload = isBuf ? body : JSON.stringify(body);
  const ct = headers['content-type'] || (isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
  res.writeHead(status, { ...headers, 'content-type': ct });
  res.end(payload);
}

function sendJson(res, status, obj) {
  send(res, status, obj, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  if (p.includes('..')) return send(res, 400, 'bad path');
  try {
    const data = await readFile(join(PUBLIC_DIR, p));
    return send(res, 200, data, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
  } catch {
    return send(res, 404, 'not found');
  }
}

const llmCall = makeLLMCall(process.env);

async function handleState(req, res) {
  // M3 federation: GET unions every circle (tagged by origin); PUT splits back
  // by `_circle`, 3-way merges each circle vs disk (M1), and returns the merged
  // federated doc + any auto-resolved conflicts. A single-folder install yields a
  // one-circle registry, so behavior is unchanged there.
  if (req.method === 'GET') {
    return sendJson(res, 200, await loadFederated());
  }
  if (req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
    if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body must be an object' });
    const { state, conflicts } = await saveFederated(body, { onCircleWritten: maybeAutoBackup });
    return sendJson(res, 200, { ok: true, saved_at: new Date().toISOString(), state, conflicts });
  }
  return sendJson(res, 405, { error: `${req.method} not allowed` });
}

async function handleAtomize(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const entry = body?.entry || {};
  const projects = Array.isArray(body?.projects) ? body.projects : [];
  try {
    const result = await atomizeEntry(entry, { projects, llmCall, ...atomizeOpts(process.env) });
    // llm = the model the provider WOULD use (null = heuristic-only config);
    // result.source says whether it actually produced this draft (T8);
    // result.fail says WHY the model path degraded, when it did (T20).
    if (result.fail) console.warn(`[atomize] model path failed: ${result.fail}`);
    return sendJson(res, 200, { ...result, llm: describeLLM(process.env, result.tier || atomizeOpts(process.env).tier) });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}

async function handleClassify(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const input = {
    description: typeof body?.description === 'string' ? body.description : '',
    excerpt: typeof body?.excerpt === 'string' ? body.excerpt : '',
    answers: body?.answers && typeof body.answers === 'object' ? body.answers : {},
  };
  try {
    const result = await classifyProject(input, { llmCall });
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}

// Native consult chat (T13): bundle + message history → one stateless
// gpt-5.4 (tier `escalate`) turn. NO fallback — errors surface to the chat UI.
async function handleConsult(req, res) {
  // GET = engine info only (T25): lets the chat header name the model before
  // the first reply. Provider-agnostic — whatever the escalate tier maps to.
  if (req.method === 'GET') return sendJson(res, 200, { llm: describeLLM(process.env, 'escalate') });
  if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const bundle = body?.bundle && typeof body.bundle === 'object' ? body.bundle : {};
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  try {
    const { reply } = await consultTurn(bundle, messages, { llmCall });
    return sendJson(res, 200, { reply, llm: describeLLM(process.env, 'escalate') });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}

// ---- async jobs + consult sessions (T16/T26, Node-only) -------------
// Long model runs become machine-local background jobs (lib/jobs.js): the
// browser submits, polls, navigates away freely; results land in the
// dashboard's Results strip. The Worker 501s all of this and the front-end
// falls back to the synchronous /api/atomize + /api/consult paths.

configureRunner({
  runners: {
    atomize: async (job) => {
      const { entry_snapshot = {}, projects = [] } = job.input || {};
      const opts = atomizeOpts(process.env);
      const result = await atomizeEntry(entry_snapshot, { projects, llmCall, ...opts });
      if (result.fail) console.warn(`[jobs] atomize ${job.id}: model path failed: ${result.fail}`);
      return { ...result, llm: describeLLM(process.env, result.tier || opts.tier) };
    },
    consult_turn: async (job, { getSession: getS, appendSessionTurn: appendS }) => {
      const s = await getS(job.input?.session_id);
      if (!s) throw new Error('session not found');
      const { reply } = await consultTurn(s.bundle, s.messages, { llmCall });
      // Persist the assistant turn on the session — the job result is a copy
      // (the inbox/chat read the session; the job is the completion signal).
      await appendS(s.id, 'assistant', reply);
      return { reply, llm: describeLLM(process.env, 'escalate') };
    },
  },
});

async function handleJobs(req, res, url) {
  if (req.method === 'GET') {
    const q = url.searchParams;
    const jobs = await listJobs({ since: q.get('since'), status: q.get('status'), kind: q.get('kind') });
    return sendJson(res, 200, { jobs });
  }
  if (req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
    const kind = String(body?.kind || '');
    if (kind !== 'atomize' && kind !== 'consult_turn') return sendJson(res, 400, { error: `unknown job kind "${kind}"` });
    try {
      const job = await createJob({ kind, title: String(body?.title || ''), input: body?.input || {} });
      return sendJson(res, 201, { job });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }
  return sendJson(res, 405, { error: `${req.method} not allowed` });
}

async function handleJobById(req, res, pathname) {
  const m = pathname.match(/^\/api\/jobs\/([^/]+)(\/dismiss)?$/);
  if (!m) return sendJson(res, 404, { error: 'not found' });
  if (m[2]) {
    if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
    const job = await dismissJob(m[1]);
    return job ? sendJson(res, 200, { job }) : sendJson(res, 404, { error: 'no such job' });
  }
  if (req.method !== 'GET') return sendJson(res, 405, { error: `${req.method} not allowed` });
  const job = await getJob(m[1]);
  return job ? sendJson(res, 200, { job }) : sendJson(res, 404, { error: 'no such job' });
}

async function handleSessions(req, res) {
  if (req.method === 'GET') {
    return sendJson(res, 200, { sessions: await listSessions() });
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const session = await createSession({
    entry_id: body?.entry_id ?? null,
    new_container_ids: Array.isArray(body?.new_container_ids) ? body.new_container_ids : [],
    bundle: body?.bundle && typeof body.bundle === 'object' ? body.bundle : {},
  });
  return sendJson(res, 201, { session });
}

async function handleSessionById(req, res, pathname) {
  const id = decodeURIComponent(pathname.slice('/api/sessions/'.length));
  if (req.method === 'GET') {
    const session = await getSession(id);
    return session ? sendJson(res, 200, { session }) : sendJson(res, 404, { error: 'no such session' });
  }
  if (req.method === 'PATCH') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
    const session = await updateSession(id, body || {});
    return session ? sendJson(res, 200, { session }) : sendJson(res, 404, { error: 'no such session' });
  }
  return sendJson(res, 405, { error: `${req.method} not allowed` });
}

// Attachments live in an `attachments/<container_id>/` tree beside the state
// JSON (so on orange they sit in the same OneDrive folder, legible to anyone).
// The server only handles file BYTES; the client owns state and records the
// attachment in container.attachments[] itself (avoids state races).
const ATTACH_DIR = join(dirname(dbPath()), 'attachments');
const safeName = (s) => basename(String(s || 'file')).replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'file';
const MAX_ATTACH_BYTES = 15 * 1024 * 1024;

async function handleAttachmentUpload(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const cid = safeName(body?.container_id);
  const filename = safeName(body?.filename);
  const b64 = String(body?.data || '').replace(/^data:[^;]*;base64,/, '');
  if (!body?.container_id || !filename || !b64) return sendJson(res, 400, { error: 'container_id, filename, data required' });
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_ATTACH_BYTES) return sendJson(res, 413, { error: 'file too large (max 15MB)' });
  try {
    const dir = join(ATTACH_DIR, cid);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), buf);
    return sendJson(res, 200, {
      id: filename,
      filename,
      mime: typeof body.mime === 'string' ? body.mime : 'application/octet-stream',
      added_at: new Date().toISOString(),
      url: `/api/attachments/${encodeURIComponent(cid)}/${encodeURIComponent(filename)}`,
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}

async function serveAttachment(req, res, pathname) {
  const parts = pathname.split('/').slice(3).map(decodeURIComponent); // after /api/attachments/
  const cid = safeName(parts[0]); const name = safeName(parts[1]);
  if (!cid || !name) return sendJson(res, 404, { error: 'not found' });
  try {
    const buf = await readFile(join(ATTACH_DIR, cid, name));
    const mime = MIME[extname(name).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime, 'content-disposition': `inline; filename="${name}"` });
    return res.end(buf);
  } catch {
    return sendJson(res, 404, { error: 'not found' });
  }
}

// Folder-lens (Epic E1) — LOCAL ONLY. The Worker 501s these (no filesystem in
// the cloud). Every path is root-relative and validated inside ONEDRIVE_ROOT by
// lib/files.js before any disk access; an escape attempt → 400, missing → 404.
// M3: resolve a circle's lens root from its id (its bindings are relative to it).
// No id / unknown id → the default ONEDRIVE_ROOT (single-circle behavior).
async function circleRootFor(circleId) {
  if (!circleId) return undefined;
  const reg = await discoverCircles();
  return (circleById(reg, circleId) || {}).root;
}

async function handleFsList(req, res, url) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: `${req.method} not allowed` });
  const rel = url.searchParams.get('path') || '';
  try {
    const root = await circleRootFor(url.searchParams.get('circle'));
    return sendJson(res, 200, await listFolder(rel, root || undefined));
  } catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'folder not found' });
    if (/escapes ONEDRIVE_ROOT|absolute path not allowed|must be a string/.test(err.message)) {
      return sendJson(res, 400, { error: err.message });
    }
    if (err.code === 'ENOTDIR') return sendJson(res, 400, { error: 'not a folder' });
    return sendJson(res, 500, { error: err.message });
  }
}

// Open a bound-tree file in its native app. Validates within ONEDRIVE_ROOT
// before spawning the opener; never writes/deletes. Worker → 501.
async function handleFsOpen(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const rel = typeof body?.path === 'string' ? body.path : '';
  if (!rel) return sendJson(res, 400, { error: 'path required' });
  try {
    const root = await circleRootFor(typeof body?.circle === 'string' ? body.circle : '');
    return sendJson(res, 200, await openFile(rel, root || undefined));
  } catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'file not found' });
    if (/escapes ONEDRIVE_ROOT|absolute path not allowed|must be a string|not a file/.test(err.message)) {
      return sendJson(res, 400, { error: err.message });
    }
    return sendJson(res, 500, { error: err.message });
  }
}

// Backups & restore — LOCAL ONLY (need a filesystem; the Worker 501s these).
// Resolve a circle object by id; null → primary (so a single-folder install works
// with no id). Backups are written next to each circle's state.json + machine-local.
async function circleObjFor(circleId) {
  const reg = await discoverCircles();
  return circleById(reg, circleId || '');
}

// GET  /api/backups?circle=<id>  → list snapshots (newest-first, both locations).
// POST /api/backups?circle=<id>  → take a manual snapshot NOW (force, both dests).
async function handleBackups(req, res, url) {
  const circle = await circleObjFor(url.searchParams.get('circle'));
  if (!circle) return sendJson(res, 404, { error: 'circle not found' });
  if (req.method === 'GET') {
    try { return sendJson(res, 200, { circle: { id: circle.id, name: circle.name }, backups: await listBackups(circle) }); }
    catch (e) { return sendJson(res, 500, { error: e.message }); }
  }
  if (req.method === 'POST') {
    // Manual snapshot of the circle's CURRENT live state. Refuse if its file is
    // malformed (would otherwise record an empty backup of real-but-unreadable data).
    let current;
    try { current = await readStateAt(circle.statePath); }
    catch (e) { return sendJson(res, 422, { error: `circle file unreadable, refusing to back up: ${e.message}` }); }
    try {
      const r = await writeBackup(circle, current, 'manual');
      return sendJson(res, 200, { ok: true, ...r });
    } catch (e) { return sendJson(res, 500, { error: e.message }); }
  }
  return sendJson(res, 405, { error: `${req.method} not allowed` });
}

// GET /api/backups/content?circle=<id>&file=<name>&location=local|onedrive
async function handleBackupContent(req, res, url) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: `${req.method} not allowed` });
  const file = url.searchParams.get('file') || '';
  if (!BACKUP_RE.test(file)) return sendJson(res, 400, { error: 'invalid backup filename' });
  const circle = await circleObjFor(url.searchParams.get('circle'));
  if (!circle) return sendJson(res, 404, { error: 'circle not found' });
  const location = url.searchParams.get('location') === 'onedrive' ? 'onedrive' : 'local';
  try { return sendJson(res, 200, { content: await readBackupContent(circle, file, location) }); }
  catch (e) {
    if (e.code === 'ENOENT') return sendJson(res, 404, { error: 'backup not found' });
    return sendJson(res, 500, { error: e.message });
  }
}

// POST /api/backups/restore  { circle, file, location }
async function handleBackupRestore(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const file = typeof body?.file === 'string' ? body.file : '';
  if (!BACKUP_RE.test(file)) return sendJson(res, 400, { error: 'invalid backup filename' });
  const circle = await circleObjFor(typeof body?.circle === 'string' ? body.circle : '');
  if (!circle) return sendJson(res, 404, { error: 'circle not found' });
  const location = body?.location === 'onedrive' ? 'onedrive' : 'local';
  try {
    const r = await restoreBackup(circle, file, location);
    return sendJson(res, 200, { ok: true, ...r });
  } catch (e) {
    if (e.code === 'ENOENT') return sendJson(res, 404, { error: 'backup not found' });
    return sendJson(res, 500, { error: e.message });
  }
}

// First-run onboarding (Epic E1.5) — LOCAL ONLY, like the lens. The wizard
// browses from the user's HOME (not the not-yet-set ONEDRIVE_ROOT) so they can
// find + pick the shared OneDrive folder; /api/setup/bind writes .env and
// restarts the server task. The Worker has no filesystem and never serves these.
async function handleSetupStatus(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: `${req.method} not allowed` });
  return sendJson(res, 200, await setupStatus());
}

async function handleSetupBrowse(req, res, url) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: `${req.method} not allowed` });
  const rel = url.searchParams.get('path') || '';
  try {
    return sendJson(res, 200, await listSetupFolder(rel));
  } catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'folder not found' });
    if (/escapes home|absolute path not allowed|must be a string/.test(err.message)) {
      return sendJson(res, 400, { error: err.message });
    }
    if (err.code === 'ENOTDIR') return sendJson(res, 400, { error: 'not a folder' });
    return sendJson(res, 500, { error: err.message });
  }
}

// Candidate workspace-DB locations for a chosen lens root (Throughline subfolder
// vs root), with existing-workspace detection so the wizard can default + reuse.
async function handleSetupDbInfo(req, res, url) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: `${req.method} not allowed` });
  const folder = url.searchParams.get('folder') || '';
  try {
    return sendJson(res, 200, await dbInfo(folder));
  } catch (err) {
    if (/inside your user profile|absolute path/.test(err.message)) return sendJson(res, 400, { error: err.message });
    return sendJson(res, 500, { error: err.message });
  }
}

async function handleSetupBind(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const folderAbsPath = typeof body?.folderAbsPath === 'string' ? body.folderAbsPath : '';
  const dbAbsPath = typeof body?.dbAbsPath === 'string' ? body.dbAbsPath : '';
  let result;
  try {
    result = await bindFolder(folderAbsPath, dbAbsPath);
  } catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'folder not found' });
    return sendJson(res, 400, { error: err.message });
  }
  // bindFolder applied the binding to process.env live (no task restart needed),
  // so the server is configured the moment this returns.
  return sendJson(res, 200, { ok: true, configured: true, ...result });
}

// T27 — Dethreader (M365 COM pathway). Runs the bundled `dethreader.ps1`
// AS-IS: it drives Outlook via COM to export the currently-selected email's
// conversation thread to Desktop\email-exports\<subject>_<ts>\ (a Markdown file
// + an attachments\ subfolder), printing the paths to stdout. We parse the
// Markdown path from stdout, read the file, and return its text so the
// front-end can drop it straight into a new "email" entry.
//
// LOCAL + WINDOWS ONLY (needs Outlook desktop COM). The Worker 501s it. Set
// THROUGHLINE_DETHREADER_DRYRUN=1 to skip the spawn and return a canned sample
// (so the front-end flow is verifiable off-Windows).
const DETHREADER_SCRIPT = process.env.THROUGHLINE_DETHREADER_SCRIPT || join(__dirname, 'dethreader.ps1');

function dethreaderDryRunMarkdown() {
  return '# Acme Payroll renewal vs. Gusto switch\n\n'
    + '- Exported from selected Outlook conversation\n- Message count: 2\n\n'
    + '---\n\n## RE: Acme Payroll renewal\n\n- **From:** Natalia Peden\n- **To:** Noah Schmuckler\n'
    + '- **Date:** 2026-06-08 14:12\n\nConfirming the 06-30 auto-renew deadline. See attached quote.\n\n'
    + '**Attachments for this message:**\n- [Acme_quote.pdf](attachments/Acme_quote.pdf)\n';
}

async function handleDethreader(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });

  if (process.env.THROUGHLINE_DETHREADER_DRYRUN) {
    const md = dethreaderDryRunMarkdown();
    return sendJson(res, 200, { markdown: md, subject: 'Acme Payroll renewal vs. Gusto switch', mdPath: '(dry-run)', folder: '(dry-run)', dryRun: true });
  }

  if (process.platform !== 'win32') {
    return sendJson(res, 501, { error: 'Dethreader runs on the local Windows install (it drives Outlook via COM).' });
  }

  try { await stat(DETHREADER_SCRIPT); }
  catch { return sendJson(res, 500, { error: `dethreader.ps1 not found at ${DETHREADER_SCRIPT}` }); }

  let stdout = '', stderr = '';
  const code = await new Promise((resolve) => {
    const ps = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', DETHREADER_SCRIPT], { windowsHide: true });
    const timer = setTimeout(() => { try { ps.kill(); } catch {} }, 180000); // 3-min cap
    ps.stdout.on('data', d => { stdout += d.toString(); });
    ps.stderr.on('data', d => { stderr += d.toString(); });
    ps.on('error', (e) => { clearTimeout(timer); stderr += String(e.message || e); resolve(-1); });
    ps.on('close', (c) => { clearTimeout(timer); resolve(c); });
  });

  if (code !== 0) {
    // The script throws plain messages (e.g. "Please select a single email in Outlook…"); surface them.
    const msg = (stderr.trim() || stdout.trim() || `dethreader.ps1 exited with code ${code}`).split('\n').slice(0, 6).join(' ').trim();
    return sendJson(res, 500, { error: msg });
  }

  const mdPath = (stdout.match(/^Markdown:\s*(.+)$/m)?.[1] || '').trim();
  const folder = (stdout.match(/^Folder:\s*(.+)$/m)?.[1] || '').trim();
  if (!mdPath) return sendJson(res, 500, { error: 'Could not find the exported Markdown path in the script output.' });

  let markdown;
  try { markdown = await readFile(mdPath, 'utf8'); }
  catch (e) { return sendJson(res, 500, { error: `Export ran but the Markdown could not be read: ${e.message}` }); }
  if (markdown.charCodeAt(0) === 0xFEFF) markdown = markdown.slice(1); // strip UTF-8 BOM the script writes

  const subject = (markdown.match(/^#\s+(.+?)\s*$/m)?.[1] || '').trim();
  return sendJson(res, 200, { markdown, subject, mdPath, folder });
}

// ---- Loop (Deloop) intake — Microsoft Graph render + device-code auth -------
// Ported from loop_de_loop (Graph client + turndown converter only). A raw
// .loop file is a Fluid container, not text — Graph renders it to HTML
// (?format=html), which we convert to Markdown for the intake. LOCAL/Node only;
// the Worker 501s /api/loop/*. THROUGHLINE_LOOP_DEMO=1 stubs the whole flow
// (demo code → success; fixture list; fixture conversion) for off-Graph verify.
const LOOP_DEMO = !!process.env.THROUGHLINE_LOOP_DEMO;
let _loopDemoSignedIn = false;   // demo only: flips true after the demo sign-in, so the wizard path is exercised

function loopDemoList() {
  return [
    { id: 'DEMO001', driveId: 'demo-drive', name: 'Dr. Otto Quarterly Review.loop', created: '2026-04-27T08:00:31Z', modified: '2026-04-27T08:11:29Z', path: '/drive/root:/Atom', webUrl: 'https://loop.cloud.microsoft/p/demo-1', size: 6519 },
    { id: 'DEMO002', driveId: 'demo-drive', name: 'IMFP Catchup.loop', created: '2026-04-28T14:00:13Z', modified: '2026-04-28T14:40:13Z', path: '/drive/root:/IMFPUC', webUrl: 'https://loop.cloud.microsoft/p/demo-2', size: 8200 },
  ];
}

async function loopDemoMarkdown(name) {
  try {
    const html = await readFile(join(__dirname, 'test', 'fixtures', 'sample-loop.html'), 'utf8');
    return loopHtmlToMarkdown(html, { source: 'onedrive-loop', original_name: name, pulled_at: new Date().toISOString() });
  } catch {
    return `---\nsource: "onedrive-loop"\noriginal_name: ${JSON.stringify(name)}\n---\n# ${name.replace(/\.loop$/i, '')}\n\n(demo) Loop conversion fixture unavailable.\n`;
  }
}

async function handleLoopAuthStatus(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: `${req.method} not allowed` });
  if (LOOP_DEMO) return sendJson(res, 200, { connected: _loopDemoSignedIn, account: _loopDemoSignedIn ? { name: 'Demo User' } : null, last_signin: null, demo: true });
  return sendJson(res, 200, await getAuthStatus());
}

async function handleLoopAuthSignout(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
  if (LOOP_DEMO) { _loopDemoSignedIn = false; return sendJson(res, 200, { ok: true }); }
  await signOut();
  return sendJson(res, 200, { ok: true });
}

// SSE device-code flow (mirrors loop_de_loop/server.js): emit `code` once MSAL
// has the user code, then `success`/`error` when sign-in completes. The wizard
// front-end consumes this. server.requestTimeout = 0 keeps the long wait alive.
async function handleLoopAuthStart(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const emit = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };
  try {
    if (LOOP_DEMO) {
      emit('code', {
        userCode: 'DEMO-1234',
        verificationUri: 'https://microsoft.com/devicelogin',
        message: 'Demo mode — the real flow shows a Microsoft URL + 8-character code.',
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      });
      await new Promise((r) => setTimeout(r, 2500));
      _loopDemoSignedIn = true;
      emit('success', { account: { username: 'demo@example.invalid', name: 'Demo User' } });
      res.end();
      return;
    }
    const handle = await initiateDeviceCode();
    if (!handle.userCode) {
      emit('success', { account: (await getAuthStatus()).account });
      res.end();
      return;
    }
    emit('code', { userCode: handle.userCode, verificationUri: handle.verificationUri, message: handle.message, expiresAt: handle.expiresAt });
    try {
      await handle.completion;
      emit('success', { account: (await getAuthStatus()).account });
    } catch (err) {
      emit('error', { message: err?.message || String(err) });
    }
  } catch (err) {
    emit('error', { message: err?.message || String(err) });
  } finally {
    try { res.end(); } catch {}
  }
}

async function handleLoopList(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: `${req.method} not allowed` });
  if (LOOP_DEMO) return _loopDemoSignedIn ? sendJson(res, 200, { loops: loopDemoList() }) : sendJson(res, 401, { error: 'not_authed' });
  const token = await acquireTokenSilentOrNull();
  if (!token) return sendJson(res, 401, { error: 'not_authed' });
  try {
    return sendJson(res, 200, { loops: await listLoopFiles(token) });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}

async function handleLoopIntake(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const name = typeof body?.name === 'string' ? body.name : 'Loop note';
  if (LOOP_DEMO) return sendJson(res, 200, { markdown: await loopDemoMarkdown(name), name });
  const token = await acquireTokenSilentOrNull();
  if (!token) return sendJson(res, 401, { error: 'not_authed' });
  const driveId = typeof body?.driveId === 'string' ? body.driveId : '';
  const itemId = typeof body?.itemId === 'string' ? body.itemId : '';
  if (!driveId || !itemId) return sendJson(res, 400, { error: 'driveId and itemId are required' });
  try {
    const { markdown } = await loopToMarkdown(token, { id: itemId, driveId, name });
    return sendJson(res, 200, { markdown, name });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/state') return await handleState(req, res);
    if (url.pathname === '/api/dethreader') return await handleDethreader(req, res);
    if (url.pathname === '/api/loop/auth/status') return await handleLoopAuthStatus(req, res);
    if (url.pathname === '/api/loop/auth/start') return await handleLoopAuthStart(req, res);
    if (url.pathname === '/api/loop/auth/signout') return await handleLoopAuthSignout(req, res);
    if (url.pathname === '/api/loop/list') return await handleLoopList(req, res);
    if (url.pathname === '/api/loop/intake') return await handleLoopIntake(req, res);
    if (url.pathname === '/api/atomize') return await handleAtomize(req, res);
    if (url.pathname === '/api/classify') return await handleClassify(req, res);
    if (url.pathname === '/api/consult') return await handleConsult(req, res);
    if (url.pathname === '/api/jobs') return await handleJobs(req, res, url);
    if (url.pathname.startsWith('/api/jobs/')) return await handleJobById(req, res, url.pathname);
    if (url.pathname === '/api/sessions') return await handleSessions(req, res);
    if (url.pathname.startsWith('/api/sessions/')) return await handleSessionById(req, res, url.pathname);
    if (url.pathname === '/api/attachments') return await handleAttachmentUpload(req, res);
    if (url.pathname.startsWith('/api/attachments/')) return await serveAttachment(req, res, url.pathname);
    if (url.pathname === '/api/fs/list') return await handleFsList(req, res, url);
    if (url.pathname === '/api/fs/open') return await handleFsOpen(req, res);
    if (url.pathname === '/api/backups') return await handleBackups(req, res, url);
    if (url.pathname === '/api/backups/content') return await handleBackupContent(req, res, url);
    if (url.pathname === '/api/backups/restore') return await handleBackupRestore(req, res);
    if (url.pathname === '/api/setup/status') return await handleSetupStatus(req, res);
    if (url.pathname === '/api/setup/browse') return await handleSetupBrowse(req, res, url);
    if (url.pathname === '/api/setup/dbinfo') return await handleSetupDbInfo(req, res, url);
    if (url.pathname === '/api/setup/bind') return await handleSetupBind(req, res);
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: err.message });
  }
});

// gpt-5.4 consult turns can outlast Node's 5-minute default requestTimeout
// (gpt-mini alone took ~90 s on an 8 KB dump — T12); don't kill them mid-call.
server.requestTimeout = 0;

// T1: THROUGHLINE_DB pointing at a FOLDER (or missing the filename) used to
// surface as a cryptic EPERM on the first save (rename file→dir). Catch it at
// boot: auto-append state.json, loudly. dbPath() reads env at call time, so
// updating process.env is enough — no restart logic needed.
{
  const raw = process.env.THROUGHLINE_DB || '';
  let isDir = /[\\/]\s*$/.test(raw);
  if (!isDir) { try { isDir = (await stat(dbPath())).isDirectory(); } catch { /* missing file = fine */ } }
  if (isDir) {
    process.env.THROUGHLINE_DB = join(dbPath(), 'state.json');
    console.warn(`[boot] THROUGHLINE_DB pointed at a folder, not a file — using ${dbPath()} instead. Set the full file path in .env to silence this.`);
  }
}

// Recover machine-local jobs from a previous process: running → error
// (the model call died with us), queued → re-scheduled.
await sweepOnBoot();

server.listen(PORT, HOST, () => {
  console.log(`Throughline server → http://${HOST}:${PORT}`);
  console.log(`  DB:       ${dbPath()}`);
  console.log(`  Provider: ${process.env.LLM_PROVIDER || 'heuristic'}`);
});
