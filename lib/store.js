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
  return { schema_version: 2, containers: [], entries: [], atoms: [], people_meta: {} };
}

// Defensive normalize — tolerates v1 docs (no people_meta, no v2 container
// fields) and never drops unknown keys on the way through.
export function normalizeState(d) {
  const o = d && typeof d === 'object' ? d : {};
  return {
    ...o,
    schema_version: 2,
    containers: Array.isArray(o.containers) ? o.containers : [],
    entries: Array.isArray(o.entries) ? o.entries : [],
    atoms: Array.isArray(o.atoms) ? o.atoms : [],
    people_meta: o.people_meta && typeof o.people_meta === 'object' ? o.people_meta : {},
  };
}

export async function readState() {
  try {
    const txt = await readFile(dbPath(), 'utf8');
    return normalizeState(JSON.parse(txt));
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
}

export async function writeState(state) {
  const next = normalizeState(state);
  const path = dbPath();
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  await rename(tmp, path); // atomic on the same filesystem
  return next;
}
