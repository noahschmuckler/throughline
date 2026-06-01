// Tests for lib/files.js — the folder-lens file-access seam (Epic E1).
// Run: node --test test/   (or: node test/files.test.mjs)
//
// The security-critical assertions are the path-traversal refusals: a web UI
// must never be able to make the server read a path outside ONEDRIVE_ROOT.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Build an isolated fixture tree and point ONEDRIVE_ROOT at it BEFORE importing
// the module (rootDir() reads the env at call time, so order is not critical,
// but we set it up front for clarity).
const ROOT = await mkdtemp(join(tmpdir(), 'tl-onedrive-'));
process.env.ONEDRIVE_ROOT = ROOT;

await mkdir(join(ROOT, 'CRM Cutover', 'analytics'), { recursive: true });
await writeFile(join(ROOT, 'CRM Cutover', 'master.xlsx'), 'x'.repeat(42));
await writeFile(join(ROOT, 'CRM Cutover', 'notes.docx'), 'doc');
await writeFile(join(ROOT, 'CRM Cutover', '.hidden'), 'secret');
await writeFile(join(ROOT, 'top.txt'), 'top');
// A sibling OUTSIDE the root, to prove traversal can't reach it.
await writeFile(join(ROOT, '..', 'tl-outside-secret.txt'), 'do not read me');

const { resolveWithinRoot, listFolder, statSafe, toRootRel, rootDir, openFile, openCommandFor } =
  await import('../lib/files.js');

test('rootDir resolves to the configured ONEDRIVE_ROOT', () => {
  assert.equal(rootDir(), ROOT);
});

test('resolveWithinRoot accepts in-tree paths', () => {
  assert.equal(resolveWithinRoot(''), ROOT);
  assert.equal(resolveWithinRoot('CRM Cutover'), join(ROOT, 'CRM Cutover'));
  assert.equal(resolveWithinRoot('CRM Cutover/master.xlsx'), join(ROOT, 'CRM Cutover', 'master.xlsx'));
  // leading-slash root-relative form is tolerated
  assert.equal(resolveWithinRoot('/CRM Cutover'), join(ROOT, 'CRM Cutover'));
});

test('resolveWithinRoot REJECTS ../ traversal escapes', () => {
  assert.throws(() => resolveWithinRoot('../tl-outside-secret.txt'), /escapes ONEDRIVE_ROOT/);
  assert.throws(() => resolveWithinRoot('CRM Cutover/../../tl-outside-secret.txt'), /escapes ONEDRIVE_ROOT/);
  assert.throws(() => resolveWithinRoot('a/b/../../../etc/passwd'), /escapes ONEDRIVE_ROOT/);
});

test('absolute / odd inputs never resolve outside the root', () => {
  // A POSIX-absolute input: leading slashes are stripped, so it is RE-ANCHORED
  // under the root rather than escaping — '/etc/passwd' becomes <root>/etc/passwd.
  // The guarantee is "never outside the root", which holds here.
  assert.equal(resolveWithinRoot('/etc/passwd'), join(ROOT, 'etc', 'passwd'));
  // On a posix host a Windows-style drive path is not "absolute" and backslashes
  // aren't separators, so it stays in-tree as a (harmless) literal name — the
  // containment check confirms it never climbs out of the root.
  const abs = resolveWithinRoot('C:\\Windows\\system32');
  assert.ok(abs.startsWith(ROOT));
});

test('resolveWithinRoot rejects non-string input', () => {
  assert.throws(() => resolveWithinRoot(null), /must be a string/);
  assert.throws(() => resolveWithinRoot(42), /must be a string/);
});

test('listFolder returns the fixture tree, sorted, dotfiles skipped', async () => {
  const root = await listFolder('');
  assert.equal(root.path, '');
  assert.deepEqual(root.folders, [{ name: 'CRM Cutover' }]);
  assert.deepEqual(root.files.map(f => f.name), ['top.txt']); // .hidden is at sub, top has only top.txt

  const sub = await listFolder('CRM Cutover');
  assert.equal(sub.path, 'CRM Cutover');
  assert.deepEqual(sub.folders, [{ name: 'analytics' }]);
  // dotfile skipped; files sorted; shape carries size/mtime/ext
  assert.deepEqual(sub.files.map(f => f.name), ['master.xlsx', 'notes.docx']);
  const master = sub.files.find(f => f.name === 'master.xlsx');
  assert.equal(master.ext, 'xlsx');
  assert.equal(master.size, 42);
  assert.ok(typeof master.mtime === 'string' && master.mtime.includes('T'));
});

test('listFolder throws on an escaping path (caller maps to 400)', async () => {
  await assert.rejects(() => listFolder('../'), /escapes ONEDRIVE_ROOT/);
});

test('listFolder lets ENOENT bubble (caller maps to 404)', async () => {
  await assert.rejects(() => listFolder('no/such/folder'), (e) => e.code === 'ENOENT');
});

test('statSafe returns null for missing/escaping, a stat for real files', async () => {
  assert.equal(await statSafe('../tl-outside-secret.txt'), null);
  assert.equal(await statSafe('nope.txt'), null);
  const st = await statSafe('top.txt');
  assert.ok(st && st.isFile());
});

test('toRootRel round-trips an absolute path back to root-relative', () => {
  assert.equal(toRootRel(join(ROOT, 'CRM Cutover', 'master.xlsx')), 'CRM Cutover/master.xlsx');
  assert.equal(toRootRel(ROOT), '');
});

test('openCommandFor builds the right opener per platform', () => {
  assert.deepEqual(openCommandFor('/x/a.xlsx', 'win32'), { command: 'cmd', args: ['/c', 'start', '', '/x/a.xlsx'] });
  assert.deepEqual(openCommandFor('/x/a.xlsx', 'darwin'), { command: 'open', args: ['/x/a.xlsx'] });
  assert.deepEqual(openCommandFor('/x/a.xlsx', 'linux'), { command: 'xdg-open', args: ['/x/a.xlsx'] });
});

test('openFile validates within root and constructs the command (dry-run)', async () => {
  process.env.THROUGHLINE_OPEN_DRYRUN = '1'; // never actually launch a GUI in the sandbox
  const res = await openFile('CRM Cutover/master.xlsx');
  assert.equal(res.ok, true);
  assert.equal(res.path, 'CRM Cutover/master.xlsx');
  // the constructed command points at the validated ABSOLUTE in-tree path
  assert.equal(res.args[res.args.length - 1], join(ROOT, 'CRM Cutover', 'master.xlsx'));
  assert.ok(['xdg-open', 'open', 'cmd'].includes(res.command));
});

test('openFile REFUSES a traversal escape (before any spawn)', async () => {
  await assert.rejects(() => openFile('../tl-outside-secret.txt'), /escapes ONEDRIVE_ROOT/);
});

test('openFile rejects a folder and a missing file', async () => {
  await assert.rejects(() => openFile('CRM Cutover'), /not a file/);
  await assert.rejects(() => openFile('CRM Cutover/nope.xlsx'), (e) => e.code === 'ENOENT');
});

test.after(async () => {
  await rm(ROOT, { recursive: true, force: true });
  await rm(join(ROOT, '..', 'tl-outside-secret.txt'), { force: true });
});
