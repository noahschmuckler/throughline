// ------------------------------------------------------------------
// Throughline — merge-base snapshots (M1, MACHINE-LOCAL, never OneDrive).
//
// One snapshot per circle = the last state THIS box successfully merged + wrote.
// It is the common ancestor (`base`) for the 3-way mergeStates() in the next PUT
// (shared/merge.js). Extracted out of lib/federation.js so the backup engine
// (lib/backups.js) can update the base on a restore without a circular import.
//
// NB: this is NOT the user-facing backup history (lib/backups.js) — it's a single
// rolling per-circle file used purely for concurrent-edit merging.
// ------------------------------------------------------------------

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

export function snapshotDir() {
  const p = process.env.THROUGHLINE_SNAPSHOTS;
  return p ? resolve(REPO_ROOT, p) : join(REPO_ROOT, 'data', 'circle_snapshots');
}

export function snapshotPath(id) {
  return join(snapshotDir(), encodeURIComponent(String(id)) + '.json');
}

export async function readSnapshot(id) {
  try { return JSON.parse(await readFile(snapshotPath(id), 'utf8')); } catch { return null; }
}

export async function writeSnapshot(id, state) {
  const p = snapshotPath(id);
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await writeFile(tmp, JSON.stringify(state), 'utf8');
  try { await rename(tmp, p); } catch { await writeFile(p, JSON.stringify(state), 'utf8'); }
}
