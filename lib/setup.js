// ------------------------------------------------------------------
// Throughline — first-run setup seam (onboarding wizard backend).
//
// The chicken-and-egg: at first run ONEDRIVE_ROOT isn't configured yet, and the
// folder-lens browser (/api/fs/list) is deliberately confined to ONEDRIVE_ROOT.
// So onboarding needs a SEPARATE browse rooted at the user's HOME directory —
// where `OneDrive - <org>` lives — so they can navigate in and pick the shared
// folder. This module is that home-rooted seam. It reuses the same containment
// gate as the lens (resolveWithin / listUnder from lib/files.js) but anchored at
// homedir, and it is the ONLY place that WRITES config (.env) — the lens never
// does. Once a folder is bound, the env only takes effect at boot, so bind also
// restarts the ThroughlineServer scheduled task.
// ------------------------------------------------------------------

import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveWithin, listUnder } from './files.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// The setup-mode browse base: the user's home dir (holds `OneDrive - <org>`).
export function setupRoot() {
  return homedir();
}

// Containment gate rooted at HOME (mirrors resolveWithinRoot, different base).
export function resolveWithinHome(rel) {
  return resolveWithin(setupRoot(), rel, 'home');
}

// The .env the running server loads. The installed server runs
// `node --env-file=.env server.js` from the install dir, so .env sits at
// REPO_ROOT/.env. THROUGHLINE_ENV_FILE overrides it (used by tests).
export function envFilePath() {
  return process.env.THROUGHLINE_ENV_FILE || join(REPO_ROOT, '.env');
}

// List one folder's children under HOME (for the wizard's folder picker). Adds
// `absPath` (the resolved absolute path) so the front end can bind it.
export async function listSetupFolder(rel = '') {
  const r = await listUnder(setupRoot(), rel, 'home');
  return { path: r.path, absPath: r.abs, folders: r.folders, files: r.files };
}

// Is ONEDRIVE_ROOT already configured AND present on disk? This is the
// first-run signal the wizard and installer key off. ONEDRIVE_ROOT is resolved
// the same way lib/files.js rootDir() does (absolute or repo-root-relative).
export async function setupStatus() {
  const root = process.env.ONEDRIVE_ROOT;
  let configured = false;
  if (root) {
    const st = await stat(resolve(REPO_ROOT, root)).catch(() => null);
    configured = !!(st && st.isDirectory());
  }
  return {
    configured,
    onedriveRoot: root || null,
    dbPath: process.env.THROUGHLINE_DB || null,
    homedir: setupRoot(),
  };
}

// Read the current .env text ('' if none yet).
export async function readEnvFile() {
  try {
    return await readFile(envFilePath(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

// Merge `updates` (e.g. {ONEDRIVE_ROOT, THROUGHLINE_DB}) into .env, PRESERVING
// every unrelated key, comment, and blank line. Replace-in-place for keys we own,
// append the rest. Atomic tmp+rename, mirroring lib/store.js.
export async function writeEnvVars(updates) {
  const cur = await readEnvFile();
  const lines = cur.length ? cur.split(/\r?\n/) : [];
  const seen = new Set();
  const out = lines.map((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
      seen.add(m[1]);
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });
  // Trim trailing blank lines so appended keys don't gain a gap, then append any
  // keys that weren't already present.
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  for (const k of Object.keys(updates)) {
    if (!seen.has(k)) out.push(`${k}=${updates[k]}`);
  }
  const text = out.join('\n') + '\n';
  const p = envFilePath();
  const tmp = `${p}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, p);
  return text;
}

// Validate a chosen absolute folder and write it into .env as ONEDRIVE_ROOT +
// THROUGHLINE_DB (=<folder>/state.json). This is the one entry point that accepts
// an absolute path from the client, so it self-gates: must be absolute AND live
// under the user's home (they can only bind inside their own profile, where
// OneDrive lives — never C:\Windows). Returns the bound paths + a soft warning
// if the shared state.json looks online-only (OneDrive Files-On-Demand).
export async function bindFolder(folderAbsPath) {
  if (typeof folderAbsPath !== 'string' || !folderAbsPath) {
    throw new Error('folderAbsPath required');
  }
  if (!isAbsolute(folderAbsPath)) {
    throw new Error('folderAbsPath must be an absolute path');
  }
  const home = setupRoot();
  const relToHome = relative(home, folderAbsPath);
  if (relToHome.startsWith('..') || isAbsolute(relToHome)) {
    throw new Error('folder must be inside your user profile');
  }
  const st = await stat(folderAbsPath).catch(() => null);
  if (!st) {
    const e = new Error('folder not found');
    e.code = 'ENOENT';
    throw e;
  }
  if (!st.isDirectory()) throw new Error('not a folder');

  const db = join(folderAbsPath, 'state.json');
  await writeEnvVars({ ONEDRIVE_ROOT: folderAbsPath, THROUGHLINE_DB: db });

  // Apply to the RUNNING process immediately. rootDir() and dbPath() read
  // process.env at call time, so this takes effect with no task restart — which
  // matters on Windows, where a detached `schtasks /End` would kill the very
  // process meant to run `/Run`. .env is still written for the next boot.
  process.env.ONEDRIVE_ROOT = folderAbsPath;
  process.env.THROUGHLINE_DB = db;

  let warning;
  const dbStat = await stat(db).catch(() => null);
  if (dbStat && dbStat.isFile() && dbStat.size === 0) {
    warning =
      'The shared state.json looks empty — if it is an online-only OneDrive file, ' +
      'right-click the folder in File Explorer → "Always keep on this device".';
  }
  return { onedriveRoot: folderAbsPath, dbPath: db, warning };
}

// Restart the ThroughlineServer scheduled task so the new .env takes effect (the
// server reads env only at boot). One detached cmd does End-then-Run so that
// ending our own task (which kills this process) doesn't abort the Run. The
// caller MUST have already flushed the HTTP response. DRYRUN-aware so Linux/
// sandbox verification can assert the command without launching anything.
// NB: the exact Windows process-tree semantics here are validated on the orange
// box, not on Linux.
export function restartServerTask(taskName = 'ThroughlineServer') {
  const command = 'cmd';
  const args = ['/c', `schtasks /End /TN "${taskName}" & schtasks /Run /TN "${taskName}"`];
  if (process.env.THROUGHLINE_OPEN_DRYRUN === '1') {
    return { ok: true, dryRun: true, command, args };
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return { ok: true, command, args };
  } catch (err) {
    return { ok: false, error: err.message, command, args };
  }
}
