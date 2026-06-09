// ------------------------------------------------------------------
// Throughline — circles (M3 federation registry).
//
// A "circle" = a OneDrive shared folder containing `Throughline/state.json` =
// one workspace = one audience (the folder's share IS the permission boundary;
// Throughline writes zero access-control). One user belongs to several circles;
// Throughline federates the ones it can see on disk into one dashboard.
//
// This module discovers circles and returns a registry the server uses to route
// reads/writes per file. Local-Node only (the Worker has no filesystem and
// treats its single state as one circle).
// ------------------------------------------------------------------

import { readFile, writeFile, mkdir, stat, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rootDir, listUnder } from './files.js';
import { dbPath } from './store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Where to scan for sibling circle folders. Default = the PARENT of
// ONEDRIVE_ROOT — i.e. the OneDrive top level holding the user's shared folders
// (incl. "shared-with-me" shortcuts, which listUnder reparse-resolves). Override
// with THROUGHLINE_CIRCLES_ROOT.
export function circlesRoot() {
  const explicit = process.env.THROUGHLINE_CIRCLES_ROOT;
  if (explicit) return resolve(REPO_ROOT, explicit);
  return dirname(rootDir());
}

// Discovery is enabled only when THROUGHLINE_CIRCLES_ROOT is set OR the parent
// scan finds >1 circle. A plain single-folder install (today's shape) returns a
// one-entry registry and behaves exactly as before.
export function federationEnabled() {
  return !!process.env.THROUGHLINE_CIRCLES_ROOT;
}

// Ensure a state.json has a stable, persisted workspace.id. Mints one (+ a
// name defaulting to the folder name) and writes it back the first time only —
// the id must live INSIDE the synced file, not be derived from the path, because
// the same shared folder has different absolute paths / shortcut names on each
// box. Returns { id, name }. `mintId` is injectable for tests.
async function ensureWorkspaceIdentity(statePath, folderAbs, { mintId = randomUUID } = {}) {
  let doc = null;
  try { doc = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (err) { if (err.code !== 'ENOENT') throw err; }

  const ws = (doc && doc.workspace && typeof doc.workspace === 'object') ? { ...doc.workspace } : {};
  let changed = false;
  if (!ws.id) { ws.id = mintId(); changed = true; }
  if (!ws.name) { ws.name = basename(folderAbs); changed = true; }

  if (changed && doc) {
    // Persist into the EXISTING doc (preserve everything else) so the id sticks.
    doc.workspace = ws;
    await mkdir(dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp`;
    await writeFile(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    try { await rename(tmp, statePath); }
    catch { await writeFile(statePath, JSON.stringify(doc, null, 2) + '\n', 'utf8'); }
  }
  return { id: ws.id, name: ws.name };
}

// Discover the circles visible on this box. Always includes the PRIMARY bound
// circle (ONEDRIVE_ROOT + THROUGHLINE_DB), even if its file doesn't exist yet
// (fresh install). When federation is enabled, also scans circlesRoot's
// immediate subfolders for `<folder>/Throughline/state.json`.
//
// Returns: [{ id, name, statePath(abs), root(abs), primary }]  (deduped by statePath).
export async function discoverCircles(opts = {}) {
  const registry = [];
  const seenPaths = new Set();

  const add = async (folderAbs, statePath, primary) => {
    const key = resolve(statePath);
    if (seenPaths.has(key)) return;
    seenPaths.add(key);
    const { id, name } = await ensureWorkspaceIdentity(statePath, folderAbs, opts);
    registry.push({ id, name, statePath: key, root: resolve(folderAbs), primary });
  };

  // 1) Primary bound circle.
  const primaryRoot = rootDir();
  const primaryState = dbPath();
  // The primary folder is the parent of the state.json's `Throughline/` dir if
  // it follows the convention, else ONEDRIVE_ROOT itself. Use ONEDRIVE_ROOT as
  // the circle root (lens bindings are relative to it).
  await add(primaryRoot, primaryState, true);

  // 2) Sibling circles under circlesRoot (only when federation is on).
  if (federationEnabled()) {
    const base = circlesRoot();
    let listing;
    try { listing = await listUnder(base, '.', 'circles'); }
    catch { listing = { folders: [] }; }
    for (const f of listing.folders) {
      const folderAbs = join(base, f.name);
      const statePath = join(folderAbs, 'Throughline', 'state.json');
      try { await stat(statePath); } catch { continue; } // only folders that ARE circles
      await add(folderAbs, statePath, false);
    }
  }

  return registry;
}

// Look up a circle by id in a registry; falls back to the primary (or the first)
// so a write for an unknown/blank circle never lands nowhere.
export function circleById(registry, id) {
  return registry.find(c => c.id === id)
    || registry.find(c => c.primary)
    || registry[0]
    || null;
}
