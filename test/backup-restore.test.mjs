// Restore flow + the merge-base invariant that makes a restore "stick".
//
// The subtle bug this guards: restore overwrites a circle's state.json with an
// older snapshot. If the machine-local merge base (lib/snapshots.js) were left
// pointing at the PRE-restore content, the next 3-way merge would treat the
// restored-away data as a concurrent delete-vs-edit and RESURRECT it. restoreBackup
// must reset the merge base to the restored content; the front-end then reloads so
// `ours` matches disk and the next save is a clean no-op.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { loadFederated, saveFederated } from '../lib/federation.js';
import { writeBackup, restoreBackup, listBackups } from '../lib/backups.js';
import { readSnapshot } from '../lib/snapshots.js';
import { mergeStates } from '../shared/merge.js';

const ENV = ['ONEDRIVE_ROOT', 'THROUGHLINE_DB', 'THROUGHLINE_CIRCLES_ROOT', 'THROUGHLINE_CIRCLES', 'THROUGHLINE_SNAPSHOTS', 'THROUGHLINE_BACKUPS'];

async function withCircle(run) {
  const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
  const root = await mkdtemp(join(tmpdir(), 'tl-restore-'));
  try {
    const statePath = join(root, 'circle', 'Throughline', 'state.json');
    await mkdir(dirname(statePath), { recursive: true });
    const atoms = [{ id: 'a1', body: 'one' }, { id: 'a2', body: 'two' }, { id: 'a3', body: 'three' }];
    await writeFile(statePath, JSON.stringify({
      schema_version: 3, containers: [], entries: [], atoms,
      people_meta: {}, workspace: { id: 'C', name: 'Circle' },
    }), 'utf8');

    delete process.env.THROUGHLINE_CIRCLES_ROOT;          // single-circle install
    process.env.THROUGHLINE_CIRCLES = 'off';              // federation is on by default now; this test exercises the single-circle path
    process.env.ONEDRIVE_ROOT = join(root, 'circle');
    process.env.THROUGHLINE_DB = statePath;
    process.env.THROUGHLINE_SNAPSHOTS = join(root, '_snap');
    process.env.THROUGHLINE_BACKUPS = join(root, '_bk');

    await run({ root, statePath });
  } finally {
    for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await rm(root, { recursive: true, force: true });
  }
}

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));
const circleFor = async (id) => (await (await import('../lib/circles.js')).discoverCircles()).find(c => c.id === id) || (await (await import('../lib/circles.js')).discoverCircles())[0];

test('restore rewinds disk, updates the merge base, and writes a pre-restore safety copy', async () => {
  await withCircle(async ({ statePath }) => {
    const circle = await circleFor('C');
    // A backup of an OLDER state that only had a1 + a2 (a3 came later).
    const older = { schema_version: 3, containers: [], entries: [],
      atoms: [{ id: 'a1', body: 'one' }, { id: 'a2', body: 'two' }], people_meta: {}, workspace: { id: 'C', name: 'Circle' } };
    const { file } = await writeBackup(circle, older, 'manual', { now: new Date('2026-06-01T00:00:00Z') });

    // Prime the merge base to the CURRENT (3-atom) disk via a real save round-trip.
    await saveFederated(await loadFederated());
    assert.equal((await readSnapshot('C')).atoms.length, 3);

    const r = await restoreBackup(circle, file, 'local', { now: new Date('2026-06-02T00:00:00Z') });
    assert.ok(r.pre_restore, 'a pre-restore backup was taken');

    // Disk is rewound to 2 atoms…
    const disk = await readJson(statePath);
    assert.deepEqual(disk.atoms.map(a => a.id).sort(), ['a1', 'a2']);
    // …and the merge base now matches the restored content (THE invariant).
    assert.deepEqual((await readSnapshot('C')).atoms.map(a => a.id).sort(), ['a1', 'a2']);
    // The pre-restore copy preserved the 3-atom state we just overwrote.
    const list = await listBackups(circle);
    assert.ok(list.some(b => b.reason === 'pre-restore'));
  });
});

test('after restore + reload, the next save is a clean no-op (a3 stays gone, no conflicts)', async () => {
  await withCircle(async () => {
    const circle = await circleFor('C');
    const older = { schema_version: 3, containers: [], entries: [],
      atoms: [{ id: 'a1' }, { id: 'a2' }], people_meta: {}, workspace: { id: 'C', name: 'Circle' } };
    const { file } = await writeBackup(circle, older, 'manual', { now: new Date('2026-06-01T00:00:00Z') });
    await saveFederated(await loadFederated());                 // base = 3 atoms

    await restoreBackup(circle, file, 'local', { now: new Date('2026-06-02T00:00:00Z') });

    // Front-end reloads (loadFederated reads the rewound disk) → ours == disk.
    const reloaded = await loadFederated();
    assert.equal(reloaded.atoms.length, 2);
    const { state, conflicts } = await saveFederated(reloaded);
    assert.equal(conflicts.length, 0, 'no spurious conflicts');
    assert.deepEqual(state.atoms.map(a => a.id).sort(), ['a1', 'a2'], 'a3 was not resurrected');
  });
});

// Documents WHY the merge base must be reset: a STALE base + STALE ours (the
// pre-fix behavior) resurrects the deleted atom via the delete-edit branch; the
// fixed shape (base == restored, ours == reloaded) merges cleanly.
test('mergeStates: stale base resurrects, reset base does not', () => {
  const a3v1 = { id: 'a3', body: 'three', updated_at: '2026-06-01T00:00:00Z' };
  const a3v2 = { id: 'a3', body: 'EDITED', updated_at: '2026-06-03T00:00:00Z' };
  const restored = { atoms: [{ id: 'a1' }, { id: 'a2' }] };

  // PRE-FIX: base still has a3, ours is stale and edited a3, disk is restored (no a3).
  const stale = mergeStates(
    { atoms: [{ id: 'a1' }, { id: 'a2' }, a3v1] },   // base (NOT reset — the bug)
    { atoms: [{ id: 'a1' }, { id: 'a2' }, a3v2] },   // ours (stale, edited)
    restored,                                         // theirs (disk, rewound)
  );
  assert.ok(stale.merged.atoms.some(a => a.id === 'a3'), 'stale base resurrects a3');

  // FIXED: base reset to restored, ours reloaded to match disk → clean.
  const fixed = mergeStates(restored, restored, restored);
  assert.equal(fixed.merged.atoms.some(a => a.id === 'a3'), false, 'reset base keeps a3 gone');
  assert.equal(fixed.conflicts.length, 0);
});

test('saveFederated fires onCircleWritten per changed circle; a throwing hook does not break the save', async () => {
  await withCircle(async ({ statePath }) => {
    const fed = await loadFederated();
    fed.atoms.push({ id: 'a4', body: 'four', _circle: 'C', updated_at: '2026-06-05T00:00:00Z' });

    const calls = [];
    await saveFederated(fed, { onCircleWritten: (info) => { calls.push(info); throw new Error('boom'); } });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].changed, true);
    assert.equal(calls[0].circle.id, 'C');
    // Despite the throwing hook, the save persisted.
    const disk = await readJson(statePath);
    assert.ok(disk.atoms.some(a => a.id === 'a4'), 'disk written even though the hook threw');
  });
});
