// ------------------------------------------------------------------
// Throughline — file-access seam (folder-lens, Epic E1).
//
// Throughline is a *lens* over the OneDrive filesystem, not a vault: it reads
// and opens files in a bound folder tree, but never writes or deletes inside
// it. Every path that touches disk is root-relative and validated to live under
// ONEDRIVE_ROOT *before* the disk is touched (path-traversal is the one thing
// that would turn this lens into an arbitrary-file-read hole).
//
// Local-Node only. The Cloudflare Worker has no filesystem and 501s the
// /api/fs/* routes. The local `fs` implementation sits behind a small backend
// interface (`setFsBackend`) so a Microsoft Graph impl can slot in later for
// the hosted multi-user form (VISION §S-track) without changing callers.
// ------------------------------------------------------------------

import { readdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { platform } from 'node:process';
import { dirname, join, resolve, relative, isAbsolute, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dbPath } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// The bound tree's root. ONEDRIVE_ROOT may be absolute (a OneDrive path on
// orange) or relative to the repo root (fixtures / local dev). Defaults to the
// folder that holds THROUGHLINE_DB — so out of the box the lens points at the
// state file's directory.
export function rootDir() {
  const p = process.env.ONEDRIVE_ROOT;
  if (p) return resolve(REPO_ROOT, p);
  return dirname(dbPath());
}

// Resolve a relative path under an arbitrary `base`, REJECTING any escape before
// the caller can touch disk. Accepts the leading-slash base-relative form
// ('/sub/x' == 'sub/x'); rejects absolute inputs and any '..' that climbs out.
// The containment check via path.relative() is the real gate — it catches every
// traversal regardless of how it's spelled. `label` only flavors the error
// message (e.g. 'ONEDRIVE_ROOT' for the lens, 'home' for the setup wizard) so
// callers can map errors precisely.
export function resolveWithin(base, rel, label = 'root') {
  if (typeof rel !== 'string') throw new Error('path must be a string');
  const cleaned = rel.replace(/^[/\\]+/, ''); // tolerate base-relative '/foo'
  if (isAbsolute(cleaned)) throw new Error(`absolute path not allowed: ${rel}`);
  const abs = resolve(base, cleaned);
  const relToBase = relative(base, abs);
  if (relToBase.startsWith('..') || isAbsolute(relToBase)) {
    throw new Error(`path escapes ${label}: ${rel}`);
  }
  return abs;
}

// The lens gate: confine to ONEDRIVE_ROOT. (Thin wrapper — unchanged behavior.)
export function resolveWithinRoot(rel) {
  return resolveWithin(rootDir(), rel, 'ONEDRIVE_ROOT');
}

// Absolute path → its form relative to `base` (forward-slashed, '' for base).
export function toRelUnder(base, abs) {
  return relative(base, abs).split(sep).join('/');
}

// Absolute path → its root-relative form. Bindings are stored in this portable
// form. (Thin wrapper over toRelUnder against the lens root.)
export function toRootRel(abs) {
  return toRelUnder(rootDir(), abs);
}

// Backend seam: the default is local node:fs; a Graph backend can replace it.
const localBackend = {
  readdir: (abs) => readdir(abs, { withFileTypes: true }),
  stat: (abs) => stat(abs),
};
let backend = localBackend;
export function setFsBackend(b) { backend = b || localBackend; }

// stat() that never throws — null on missing / escaping / unreadable.
export async function statSafe(rel) {
  try {
    return await backend.stat(resolveWithinRoot(rel));
  } catch {
    return null;
  }
}

// List one folder's immediate children under an arbitrary `base`. Returns the
// resolved `abs`, the base-relative `path`, plus sorted `folders` (name only)
// and `files` ({name,size,mtime,ext}). Dotfiles are skipped (OneDrive/system
// noise). Throws on an escaping path (caller maps to 400) and lets ENOENT bubble
// (caller maps to 404). `label` flows into the escape error message.
export async function listUnder(base, rel = '', label = 'root') {
  const abs = resolveWithin(base, rel || '.', label);
  const dirents = await backend.readdir(abs);
  const folders = [];
  const files = [];
  for (const d of dirents) {
    if (d.name.startsWith('.')) continue;
    let isDir = d.isDirectory();
    let isFile = d.isFile();
    let st = null;
    // Reparse points — OneDrive cloud-sync roots (IO_REPARSE_TAG_CLOUD) and the
    // legacy Windows compatibility junctions — report as neither dir nor file
    // (Node sees them as symlinks). Follow with stat() to learn the real type so
    // a bound OneDrive folder is browsable. A stat failure (e.g. an ACL-denied
    // junction like "My Documents") drops the entry, which is the right call.
    if (!isDir && !isFile) {
      st = await backend.stat(join(abs, d.name)).catch(() => null);
      if (st) { isDir = st.isDirectory(); isFile = st.isFile(); }
    }
    if (isDir) {
      folders.push({ name: d.name });
    } else if (isFile) {
      let size = 0, mtime = null;
      if (!st) st = await backend.stat(join(abs, d.name)).catch(() => null);
      if (st) { size = st.size; mtime = st.mtime.toISOString(); }
      files.push({ name: d.name, size, mtime, ext: extname(d.name).slice(1).toLowerCase() });
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { abs, path: toRelUnder(base, abs), folders, files };
}

// Lens listing: confined to ONEDRIVE_ROOT, returns the public {path,folders,
// files} shape (drops the internal `abs`). (Thin wrapper — unchanged behavior.)
export async function listFolder(rel = '') {
  const { path, folders, files } = await listUnder(rootDir(), rel, 'ONEDRIVE_ROOT');
  return { path, folders, files };
}

// The platform "open in native app" command. Pure (no side effects) so it can be
// asserted in tests across platforms — the differentiator behavior. Args are an
// array so the spawn layer quotes them; nothing is shell-interpolated.
export function openCommandFor(absPath, plat = platform) {
  if (plat === 'win32') return { command: 'cmd', args: ['/c', 'start', '', absPath] };
  if (plat === 'darwin') return { command: 'open', args: [absPath] };
  return { command: 'xdg-open', args: [absPath] };
}

// Open a bound-tree file in its native app (Excel/Word/etc.). Validates within
// root FIRST, confirms it's a real file (never a folder, never missing), then
// spawns the platform opener detached. Returns the constructed command so the
// caller/test can assert it. Set THROUGHLINE_OPEN_DRYRUN=1 to skip the actual
// spawn (used by automated verification — the GUI can't launch in the sandbox).
export async function openFile(rel) {
  const abs = resolveWithinRoot(rel);
  const st = await backend.stat(abs).catch(() => null);
  if (!st) { const e = new Error('file not found'); e.code = 'ENOENT'; throw e; }
  if (!st.isFile()) throw new Error('not a file');
  const { command, args } = openCommandFor(abs);
  if (process.env.THROUGHLINE_OPEN_DRYRUN !== '1') {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (e) {
      // A missing opener (headless box) is not a server error — the path was
      // valid and we did everything we could; report it but don't 500.
      return { ok: false, path: toRootRel(abs), command, args, error: e.message };
    }
  }
  return { ok: true, path: toRootRel(abs), command, args };
}
