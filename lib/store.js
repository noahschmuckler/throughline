// ------------------------------------------------------------------
// Throughline — Node store. Reads/writes the single state document as a JSON
// file. This is the orange-device backend: point THROUGHLINE_DB at a file
// inside a OneDrive shared folder and the dyad shares one project DB.
//
// Mirrors atom_sandbox/lib/store.js in spirit (tmp+rename atomic-ish writes),
// but Throughline's whole world is one document, so there's just one file.
// ------------------------------------------------------------------

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// THROUGHLINE_DB may be absolute (a OneDrive path on orange) or relative to the
// repo root (the local default).
export function dbPath() {
  const p = process.env.THROUGHLINE_DB || './data/state.json';
  return resolve(REPO_ROOT, p);
}

export function emptyState() {
  return { schema_version: 3, containers: [], entries: [], atoms: [], people_meta: {} };
}

// Defensive normalize — tolerates v1/v2 docs (no people_meta, no v2/v3 container
// fields) and never drops unknown keys on the way through. Container inner-fields
// (incl. the v3 program_id/framework/rag) pass through the array untouched; the
// front-end defaults any missing ones on read.
export function normalizeState(d) {
  const o = d && typeof d === 'object' ? d : {};
  return {
    ...o,
    schema_version: 3,
    containers: Array.isArray(o.containers) ? o.containers : [],
    entries: Array.isArray(o.entries) ? o.entries : [],
    atoms: Array.isArray(o.atoms) ? o.atoms : [],
    people_meta: o.people_meta && typeof o.people_meta === 'object' ? o.people_meta : {},
    // M3 circles: each state.json self-declares its workspace identity. id is
    // minted once + persisted by lib/circles.js (stable + portable across the
    // boxes that sync this folder); name defaults to the folder name there.
    // Defaulted here (NOT minted — minting needs a write) so readers can rely on
    // the shape.
    workspace: (o.workspace && typeof o.workspace === 'object') ? o.workspace : { id: null, name: '' },
  };
}

// Read a state document from an explicit path (M3: one file per circle). ENOENT
// → empty state (a not-yet-written circle).
export async function readStateAt(path) {
  try {
    const txt = await readFile(path, 'utf8');
    return normalizeState(JSON.parse(txt));
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
}

export async function readState() {
  return readStateAt(dbPath());
}

// OneDrive's sync engine can briefly lock the target during upload, making
// the rename transiently EPERM/EBUSY/EACCES even when the path is right (T2).
// Retry with backoff; injectable for tests.
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES']);
export async function renameWithRetry(tmp, path, {
  delays = [50, 250, 1000],
  renameFn = rename,
  sleep = (ms) => new Promise(r => setTimeout(r, ms)),
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try { await renameFn(tmp, path); return { atomic: true }; }
    catch (err) {
      if (!TRANSIENT.has(err.code)) throw err; // real failure — don't mask it
      lastErr = err;
      if (attempt < delays.length) await sleep(delays[attempt]);
    }
  }
  return { atomic: false, error: lastErr }; // caller falls back to direct write
}

// Write a state document to an explicit path (M3: one file per circle).
export async function writeStateAt(state, path) {
  const next = normalizeState(state);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const body = JSON.stringify(next, null, 2) + '\n';
  await writeFile(tmp, body, 'utf8');
  const r = await renameWithRetry(tmp, path);
  if (!r.atomic) {
    // Sync lock outlasted the retries: a direct (non-atomic) write beats a
    // dropped save. The tmp file is left behind as a recovery copy.
    console.warn(`[store] rename kept failing (${r.error?.code}); falling back to direct write`);
    await writeFile(path, body, 'utf8');
  }
  return next;
}

export async function writeState(state) {
  return writeStateAt(state, dbPath());
}
