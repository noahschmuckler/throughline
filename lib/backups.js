// ------------------------------------------------------------------
// Throughline — per-circle backup & restore engine (Node-only).
//
// Every circle's data lives in a single state.json (OneDrive-synced). That's
// one file with no history. This writes timestamped COPIES of it to two places:
//
//   • LOCAL (always):    <THROUGHLINE_BACKUPS>/<circleId>/         (machine-local, gitignored)
//   • ONEDRIVE (best-effort): <dir(statePath)>/backups/<host>/     (rides enterprise sync)
//
// The OneDrive copy is namespaced by os.hostname() so the two dyad members who
// sync the same circle folder keep separate backup sets (no overwrite) — and can
// see + restore each other's snapshots.
//
// SAFETY — a backup can NEVER be loaded as a live state.json:
//   1. Structural: circle discovery (lib/circles.js) only ever looks for
//      `<folder>/Throughline/state.json`; it never recurses into `backups/`.
//   2. Naming: files are `throughline-backup--<stamp>--<host>.bak.json`, never
//      `state.json`. Belt-and-suspenders on top of (1).
//
// Auto-backup is throttled-on-change (hooked into the federation save path).
// Retention is usage-relative tiered thinning (see planThinning) — an idle
// stretch of months never purges history.
// ------------------------------------------------------------------

import { readFile, writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

import { readStateAt, writeStateAt, normalizeState } from './store.js';
import { readSnapshot, writeSnapshot } from './snapshots.js';
import { contentKey } from './federation.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const META_KEY = '_backup_meta';
const THROTTLE_MS = parseInt(process.env.THROUGHLINE_BACKUP_THROTTLE_MS || '', 10) || 15 * 60 * 1000;

// ---------- naming ----------------------------------------------------------

export function sanitizeHost(h = os.hostname()) {
  return (String(h || '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'host';
}

// 2026-06-10T14:30:00.123Z -> 20260610t143000123z  (sortable, unique, pure UTC).
export function backupStamp(date = new Date()) {
  return date.toISOString().replace(/[-:.]/g, '').replace('T', 't').replace('Z', 'z').toLowerCase();
}

export function backupFilename(host, stamp) {
  return `throughline-backup--${stamp}--${sanitizeHost(host)}.bak.json`;
}

// The path-safety allowlist for any caller-supplied `file`: no separators, no
// '.'-sequences, can't spell `state.json`. Combined with the basename check in
// resolveBackupFile() this makes traversal impossible.
export const BACKUP_RE = /^throughline-backup--(\d{8}t\d{9}z)--([A-Za-z0-9_-]+)\.bak\.json$/;

export function parseBackupName(name) {
  const m = BACKUP_RE.exec(name || '');
  if (!m) return null;
  const s = m[1]; // 20260610t143000123z
  const iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}.${s.slice(15, 18)}Z`;
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? null : { ts, host: m[2], iso };
}

// ---------- directories -----------------------------------------------------

function backupsRoot() {
  return resolve(REPO_ROOT, process.env.THROUGHLINE_BACKUPS || 'data/backups');
}
export function localBackupsDir(circleId) {
  return join(backupsRoot(), encodeURIComponent(String(circleId)));
}
// OneDrive backups live next to the circle's actual state.json (so they ride the
// same shared-folder sync), under backups/<host>/. Derive from dirname(statePath),
// NOT circle.root — the primary circle's dbPath isn't always <root>/Throughline/state.json.
export function onedriveBackupsDir(circle, host = sanitizeHost()) {
  return join(dirname(circle.statePath), 'backups', sanitizeHost(host));
}

// Validate a caller-supplied file name and resolve it inside `dir` (containment
// belt on top of the regex). Throws on anything that isn't a clean backup name.
function resolveBackupFile(dir, file) {
  if (typeof file !== 'string' || !BACKUP_RE.test(file) || basename(file) !== file) {
    throw new Error(`invalid backup filename: ${file}`);
  }
  return join(dir, file);
}

// ---------- the ledger (throttle state) -------------------------------------
// Machine-local: { [circleId]: { lastTs, lastContentKey } }. Read-modify-write;
// the per-box write rate is low enough that a mutex isn't worth it.

function ledgerPath() { return join(backupsRoot(), '.ledger.json'); }
async function readLedger() {
  try { return JSON.parse(await readFile(ledgerPath(), 'utf8')); } catch { return {}; }
}
async function writeLedger(led) {
  await mkdir(backupsRoot(), { recursive: true });
  await writeFile(ledgerPath(), JSON.stringify(led, null, 2), 'utf8');
}

// ---------- writing a backup ------------------------------------------------

function stripMeta(state) {
  if (!state || typeof state !== 'object') return state;
  const { [META_KEY]: _drop, ...rest } = state;
  return rest;
}

// Write one backup of `state` to LOCAL (always) + ONEDRIVE (best-effort). Embeds
// fresh _backup_meta (stripping any stale copy first). Returns { file, locations[] }.
// After each successful write, thins that directory. NEVER throws on a OneDrive
// failure — local is written first so at least one copy always lands.
export async function writeBackup(circle, state, reason = 'auto', { host = sanitizeHost(), now = new Date() } = {}) {
  const stamp = backupStamp(now);
  const file = backupFilename(host, stamp);
  const doc = {
    ...stripMeta(state),
    [META_KEY]: {
      created_at: now.toISOString(),
      host: sanitizeHost(host),
      circle_id: circle.id,
      circle_name: circle.name || '',
      reason,
    },
  };
  const body = JSON.stringify(doc, null, 2) + '\n';
  const locations = [];

  // LOCAL first — machine-local, essentially never fails.
  const localDir = localBackupsDir(circle.id);
  try {
    await mkdir(localDir, { recursive: true });
    await writeFile(join(localDir, file), body, 'utf8');
    locations.push('local');
    await thinDir(localDir);
  } catch (e) {
    console.warn(`[backups] local write failed for "${circle.name}": ${e.message}`);
  }

  // ONEDRIVE — best-effort; offline / unwritable must not break the save.
  const odDir = onedriveBackupsDir(circle, host);
  try {
    await mkdir(odDir, { recursive: true });
    await writeFile(join(odDir, file), body, 'utf8');
    locations.push('onedrive');
    await thinDir(odDir);
  } catch (e) {
    console.warn(`[backups] OneDrive write skipped for "${circle.name}": ${e.message}`);
  }

  return { file, locations };
}

// The throttled-on-change auto hook. Called from saveFederated's onCircleWritten.
export async function maybeAutoBackup({ circle, merged, changed }, { now = new Date() } = {}) {
  if (!changed) return null;
  const key = contentKey(merged);
  const led = await readLedger();
  const prev = led[circle.id] || {};
  if (prev.lastContentKey === key) return null;                 // identical content already backed up
  if (prev.lastTs && (now.getTime() - prev.lastTs) < THROTTLE_MS) return null; // within the throttle window
  const res = await writeBackup(circle, merged, 'auto', { now });
  led[circle.id] = { lastTs: now.getTime(), lastContentKey: key };
  try { await writeLedger(led); } catch (e) { console.warn(`[backups] ledger write failed: ${e.message}`); }
  return res;
}

// ---------- retention: usage-relative tiered thinning -----------------------
// PURE. Input: [{ file, ts }]. Anchored to the NEWEST backup (not Date.now()),
// so an idle period never prunes — thinning only ever runs when a new backup is
// added. Keep ALL within 48h of newest, 1/day to 30d, 1/week beyond; ALWAYS keep
// the most-recent `recentFloor` and the single oldest; never thin a bucket to zero.

const HOUR = 3600e3, DAY = 24 * HOUR, WEEK = 7 * DAY;

export function planThinning(backups, {
  recentFloor = 10,
  allWindowMs = 48 * HOUR,
  dailyWindowMs = 30 * DAY,
} = {}) {
  const items = [...backups].filter(b => Number.isFinite(b.ts)).sort((a, b) => a.ts - b.ts);
  const keep = new Set();
  if (items.length <= recentFloor + 1) {
    for (const b of items) keep.add(b.file);
    return { keep, drop: [] };
  }
  const T = items[items.length - 1].ts;             // newest = anchor
  // Floor: the single oldest + the most-recent recentFloor.
  keep.add(items[0].file);
  for (const b of items.slice(-recentFloor)) keep.add(b.file);

  // Bucket the rest, keep the newest per bucket.
  const buckets = new Map();
  for (const b of items) {
    if (keep.has(b.file)) continue;
    const age = T - b.ts;
    let bucket;
    if (age <= allWindowMs) { keep.add(b.file); continue; }   // keep all recent
    else if (age <= dailyWindowMs) bucket = `d${Math.floor(age / DAY)}`;
    else bucket = `w${Math.floor(age / WEEK)}`;
    const cur = buckets.get(bucket);
    if (!cur || b.ts > cur.ts) buckets.set(bucket, b);        // newest-in-bucket wins
  }
  for (const b of buckets.values()) keep.add(b.file);

  const drop = items.filter(b => !keep.has(b.file)).map(b => b.file);
  return { keep, drop };
}

// List a directory's backup files as [{ file, ts }] (ignores non-backup names).
async function listDirBackups(dir) {
  let names;
  try { names = await readdir(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const p = parseBackupName(name);
    if (p) out.push({ file: name, ts: p.ts });
  }
  return out;
}

// Thin ONE directory (one host's set). Never throws out of the save path.
async function thinDir(dir) {
  try {
    const items = await listDirBackups(dir);
    const { drop } = planThinning(items);
    for (const f of drop) {
      try { await unlink(join(dir, f)); }
      catch (e) { console.warn(`[backups] prune failed for ${f}: ${e.message}`); }
    }
  } catch (e) {
    console.warn(`[backups] thinning skipped for ${dir}: ${e.message}`);
  }
}

// ---------- listing / reading / restoring -----------------------------------

// Full view for a circle: this box's local set + every host's OneDrive set,
// merged by <host>/<file> (so a file that exists both local and onedrive shows
// both locations). Newest-first.
export async function listBackups(circle) {
  const byKey = new Map();
  const add = (host, file, ts, location) => {
    const key = `${host}/${file}`;
    if (!byKey.has(key)) byKey.set(key, { file, host, ts, locations: [] });
    const item = byKey.get(key);
    if (!item.locations.includes(location)) item.locations.push(location);
  };

  // Local (this box only).
  for (const { file, ts } of await listDirBackups(localBackupsDir(circle.id))) {
    add(parseBackupName(file).host, file, ts, 'local');
  }
  // OneDrive: every host subdir under backups/.
  const odBase = join(dirname(circle.statePath), 'backups');
  let hosts = [];
  try { hosts = (await readdir(odBase, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name); }
  catch { /* no backups dir yet */ }
  for (const host of hosts) {
    for (const { file, ts } of await listDirBackups(join(odBase, host))) {
      add(parseBackupName(file).host, file, ts, 'onedrive');
    }
  }

  // Enrich with parsed meta + size (best-effort).
  const items = [];
  for (const it of byKey.values()) {
    let reason = null, created_at = parseBackupName(it.file)?.iso || null, size = null;
    const probe = it.locations.includes('local')
      ? join(localBackupsDir(circle.id), it.file)
      : join(odBase, it.host, it.file);
    try {
      const st = await stat(probe); size = st.size;
      const doc = JSON.parse(await readFile(probe, 'utf8'));
      if (doc && doc[META_KEY]) { reason = doc[META_KEY].reason || null; created_at = doc[META_KEY].created_at || created_at; }
    } catch { /* ignore — keep filename-derived fields */ }
    items.push({ file: it.file, host: it.host, ts: it.ts, created_at, reason, size, locations: it.locations });
  }
  items.sort((a, b) => b.ts - a.ts);
  return items;
}

function dirForLocation(circle, file, location) {
  if (location === 'local') return localBackupsDir(circle.id);
  const host = parseBackupName(file)?.host || sanitizeHost();
  return join(dirname(circle.statePath), 'backups', host); // onedrive (host derived from filename)
}

export async function readBackupContent(circle, file, location = 'local') {
  const p = resolveBackupFile(dirForLocation(circle, file, location), file);
  const doc = JSON.parse(await readFile(p, 'utf8'));
  return doc;
}

// Restore a backup as the circle's live state. CRITICAL ORDER:
//   1. back up CURRENT state (reason:'pre-restore') so restore is reversible
//   2. read chosen backup, strip _backup_meta, normalize
//   3. write it to the live statePath
//   4. UPDATE THE MERGE-BASE SNAPSHOT to the restored content — without this the
//      next 3-way merge (base=pre-restore, theirs=restored) would resurrect the
//      data the restore removed (shared/merge.js delete-edit branch).
export async function restoreBackup(circle, file, location = 'local', { now = new Date() } = {}) {
  // 1. pre-restore safety backup of what's live right now.
  let current;
  try { current = await readStateAt(circle.statePath); }
  catch (e) { current = null; console.warn(`[backups] could not read current state for pre-restore: ${e.message}`); }
  let preRestore = null;
  if (current) preRestore = await writeBackup(circle, current, 'pre-restore', { now });

  // 2. read + clean the chosen backup.
  const raw = await readBackupContent(circle, file, location);
  const restored = normalizeState(stripMeta(raw));

  // 3. write live.
  await writeStateAt(restored, circle.statePath);
  // 4. reset the merge base so the next save is a clean no-op, not a resurrection.
  await writeSnapshot(circle.id, restored);

  return { restored: file, pre_restore: preRestore?.file || null };
}
