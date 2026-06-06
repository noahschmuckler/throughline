// Tests for lib/setup.js — the first-run onboarding seam.
// Run: node --test test/   (or: node test/setup.test.mjs)
//
// The security-critical assertions mirror files.test.mjs but for the HOME-rooted
// setup browse + bind: a fresh user must not be able to bind or browse outside
// their own profile, and writing .env must never clobber unrelated config.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

// bindFolder requires the target to live under HOME (that's where OneDrive is),
// so the fixture tree must be under homedir(), not /tmp.
const HOME = homedir();
const FIX = await mkdtemp(join(HOME, '.tl-setup-test-'));
await mkdir(join(FIX, 'OneDrive - Optum', 'Throughline', 'sub'), { recursive: true });
await writeFile(join(FIX, 'OneDrive - Optum', 'Throughline', 'note.txt'), 'hi');

// Point .env writes at a throwaway file so we never touch the real repo .env.
const ENV_FILE = join(await mkdtemp(join(tmpdir(), 'tl-env-')), '.env');
process.env.THROUGHLINE_ENV_FILE = ENV_FILE;
process.env.THROUGHLINE_OPEN_DRYRUN = '1'; // never actually run schtasks

const {
  resolveWithinHome, listSetupFolder, writeEnvVars, bindFolder, dbInfo,
  restartServerTask, envFilePath,
} = await import('../lib/setup.js');

test('resolveWithinHome accepts in-home paths and tolerates leading slash', () => {
  assert.equal(resolveWithinHome(''), HOME);
  assert.equal(resolveWithinHome('/x'), join(HOME, 'x'));
});

test('resolveWithinHome REJECTS ../ escapes above HOME', () => {
  assert.throws(() => resolveWithinHome('../../etc/passwd'), /escapes home/);
  assert.throws(() => resolveWithinHome('a/../../../root'), /escapes home/);
});

test('resolveWithinHome rejects non-string input', () => {
  assert.throws(() => resolveWithinHome(null), /must be a string/);
});

test('listSetupFolder lists under HOME and returns an absPath', async () => {
  const relFix = FIX.slice(HOME.length).replace(/^[/\\]+/, '');
  const r = await listSetupFolder(join(relFix, 'OneDrive - Optum', 'Throughline'));
  assert.ok(r.absPath.endsWith(join('OneDrive - Optum', 'Throughline')));
  assert.deepEqual(r.folders, [{ name: 'sub' }]);
  assert.deepEqual(r.files.map((f) => f.name), ['note.txt']);
});

test('writeEnvVars PRESERVES unrelated keys and comments, replaces owned keys', async () => {
  await writeFile(
    ENV_FILE,
    '# header comment\nPORT=8787\nLLM_PROVIDER=cdsapi\n\n# trailing comment\nONEDRIVE_ROOT=/old/path\n',
    'utf8',
  );
  await writeEnvVars({ ONEDRIVE_ROOT: '/new/root', THROUGHLINE_DB: '/new/root/state.json' });
  const out = await readFile(ENV_FILE, 'utf8');
  assert.match(out, /# header comment/);
  assert.match(out, /^PORT=8787$/m);
  assert.match(out, /^LLM_PROVIDER=cdsapi$/m);
  assert.match(out, /# trailing comment/);
  // owned key replaced in place (no duplicate)
  assert.match(out, /^ONEDRIVE_ROOT=\/new\/root$/m);
  assert.equal(out.match(/^ONEDRIVE_ROOT=/gm).length, 1);
  // new key appended
  assert.match(out, /^THROUGHLINE_DB=\/new\/root\/state\.json$/m);
});

test('writeEnvVars creates a fresh .env when none exists', async () => {
  await rm(ENV_FILE, { force: true });
  await writeEnvVars({ ONEDRIVE_ROOT: '/r', THROUGHLINE_DB: '/r/state.json' });
  const out = await readFile(ENV_FILE, 'utf8');
  assert.match(out, /^ONEDRIVE_ROOT=\/r$/m);
  assert.match(out, /^THROUGHLINE_DB=\/r\/state\.json$/m);
});

test('bindFolder defaults THROUGHLINE_DB to the Throughline subfolder', async () => {
  const folder = join(FIX, 'OneDrive - Optum');
  const res = await bindFolder(folder);
  assert.equal(res.onedriveRoot, folder);
  assert.equal(res.dbPath, join(folder, 'Throughline', 'state.json'));
  const out = await readFile(ENV_FILE, 'utf8');
  assert.ok(out.includes(`ONEDRIVE_ROOT=${folder}`));
  assert.ok(out.includes(`THROUGHLINE_DB=${join(folder, 'Throughline', 'state.json')}`));
});

test('bindFolder honors an explicit dbAbsPath inside the chosen folder', async () => {
  const folder = join(FIX, 'OneDrive - Optum');
  const db = join(folder, 'Throughline', 'state.json');
  const res = await bindFolder(folder, db);
  assert.equal(res.dbPath, db);
});

test('bindFolder rejects a dbAbsPath outside the chosen folder', async () => {
  const folder = join(FIX, 'OneDrive - Optum');
  await assert.rejects(() => bindFolder(folder, join(FIX, 'elsewhere', 'state.json')), /inside the chosen folder/);
});

test('dbInfo reports candidates and reuses an existing workspace with counts', async () => {
  const folder = join(FIX, 'OneDrive - Optum');
  // Seed an existing workspace in the Throughline subfolder.
  await mkdir(join(folder, 'Throughline'), { recursive: true });
  await writeFile(
    join(folder, 'Throughline', 'state.json'),
    JSON.stringify({ containers: [
      { type: 'project' }, { type: 'project' }, { type: 'program' }, { type: 'reference_file' },
    ] }),
  );
  const info = await dbInfo(folder);
  assert.equal(info.default, join(folder, 'Throughline', 'state.json'));
  const tl = info.candidates.find((c) => c.rel === 'Throughline/state.json');
  assert.ok(tl.recommended && tl.exists);
  assert.deepEqual(tl.summary, { projects: 2, programs: 1, references: 1 });
  const rootCand = info.candidates.find((c) => c.rel === 'state.json');
  assert.equal(rootCand.exists, false);
});

test('bindFolder REJECTS a path outside the user profile', async () => {
  await assert.rejects(() => bindFolder('/etc'), /inside your user profile/);
  await assert.rejects(() => bindFolder('relative/not/absolute'), /absolute/);
  await assert.rejects(() => bindFolder(''), /required/);
});

test('bindFolder rejects a missing folder and a file', async () => {
  await assert.rejects(() => bindFolder(join(FIX, 'nope')), (e) => e.code === 'ENOENT');
  await assert.rejects(
    () => bindFolder(join(FIX, 'OneDrive - Optum', 'Throughline', 'note.txt')),
    /not a folder/,
  );
});

test('restartServerTask is dry-run aware: returns the command, spawns nothing', () => {
  const r = restartServerTask('ThroughlineServer');
  assert.equal(r.dryRun, true);
  assert.equal(r.command, 'cmd');
  assert.ok(r.args.join(' ').includes('schtasks /End /TN "ThroughlineServer"'));
  assert.ok(r.args.join(' ').includes('schtasks /Run /TN "ThroughlineServer"'));
});

test('envFilePath honors the THROUGHLINE_ENV_FILE override', () => {
  assert.equal(envFilePath(), ENV_FILE);
});

test.after(async () => {
  await rm(FIX, { recursive: true, force: true });
  await rm(envFilePath(), { force: true }).catch(() => {});
});
