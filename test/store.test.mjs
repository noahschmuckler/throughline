// Tests for lib/store.js hardening (T1/T2): renameWithRetry's transient-code
// retry + fallback contract, and a normal write round-trip in a temp dir.
// Run: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renameWithRetry, writeState, readState, emptyState } from '../lib/store.js';

const errWith = (code) => Object.assign(new Error(code), { code });
const noSleep = () => Promise.resolve();

test('renameWithRetry: succeeds first try → atomic, one call', async () => {
  let calls = 0;
  const r = await renameWithRetry('a.tmp', 'a', { renameFn: async () => { calls++; }, sleep: noSleep });
  assert.deepEqual(r, { atomic: true });
  assert.equal(calls, 1);
});

test('renameWithRetry: transient EPERM/EBUSY retry until success', async () => {
  let calls = 0;
  const renameFn = async () => { calls++; if (calls < 3) throw errWith(calls === 1 ? 'EPERM' : 'EBUSY'); };
  const r = await renameWithRetry('a.tmp', 'a', { renameFn, sleep: noSleep });
  assert.equal(r.atomic, true);
  assert.equal(calls, 3);
});

test('renameWithRetry: transient forever → exhausts attempts, returns non-atomic with the error', async () => {
  let calls = 0;
  const renameFn = async () => { calls++; throw errWith('EACCES'); };
  const r = await renameWithRetry('a.tmp', 'a', { delays: [1, 1], renameFn, sleep: noSleep });
  assert.equal(r.atomic, false);
  assert.equal(r.error.code, 'EACCES');
  assert.equal(calls, 3); // initial + 2 retries
});

test('renameWithRetry: non-transient codes throw immediately (never masked)', async () => {
  let calls = 0;
  const renameFn = async () => { calls++; throw errWith('EISDIR'); };
  await assert.rejects(() => renameWithRetry('a.tmp', 'a', { renameFn, sleep: noSleep }), /EISDIR/);
  assert.equal(calls, 1);
});

test('writeState/readState: round-trips in a temp dir; unknown keys survive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tl-store-'));
  const prev = process.env.THROUGHLINE_DB;
  process.env.THROUGHLINE_DB = join(dir, 'state.json');
  try {
    const doc = { ...emptyState(), atoms: [{ id: 'a1', kind: 'action', body: 'x', queued: true }], custom_top: { keep: 1 } };
    await writeState(doc);
    const back = await readState();
    assert.equal(back.atoms[0].queued, true);
    assert.deepEqual(back.custom_top, { keep: 1 });
    // The atomic path leaves no stray tmp file behind.
    const txt = await readFile(join(dir, 'state.json'), 'utf8');
    assert.ok(txt.endsWith('\n'));
  } finally {
    if (prev === undefined) delete process.env.THROUGHLINE_DB; else process.env.THROUGHLINE_DB = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
