// M3 federation round-trip: discover circles, federate (tagged by origin), route
// writes back to the right file, and 3-way merge an external concurrent edit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFederated, saveFederated } from '../lib/federation.js';

const ENV_KEYS = ['ONEDRIVE_ROOT', 'THROUGHLINE_DB', 'THROUGHLINE_CIRCLES_ROOT', 'THROUGHLINE_SNAPSHOTS'];

async function withTwoCircles(run) {
  const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  const root = await mkdtemp(join(tmpdir(), 'tl-circles-'));
  try {
    const stateOf = async (folder, ws, doc) => {
      const dir = join(root, folder, 'Throughline');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'state.json'),
        JSON.stringify({ schema_version: 3, containers: [], entries: [], atoms: [], people_meta: {}, workspace: ws, ...doc }), 'utf8');
      return join(dir, 'state.json');
    };
    const pathA = await stateOf('circleA', { id: 'A', name: 'Circle A' }, {
      containers: [{ id: 'a_proj', type: 'project', title: 'Alpha', updated_at: '2026-06-01T00:00:00Z' }],
    });
    await stateOf('circleB', { id: 'B', name: 'Circle B' }, {
      containers: [{ id: 'b_proj', type: 'project', title: 'Bravo', updated_at: '2026-06-01T00:00:00Z' }],
    });

    process.env.THROUGHLINE_CIRCLES_ROOT = root;
    process.env.ONEDRIVE_ROOT = join(root, 'circleA');   // primary = circle A
    process.env.THROUGHLINE_DB = pathA;
    process.env.THROUGHLINE_SNAPSHOTS = join(root, '_snapshots');

    await run({ root, pathA, pathB: join(root, 'circleB', 'Throughline', 'state.json') });
  } finally {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await rm(root, { recursive: true, force: true });
  }
}

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

test('loadFederated unions both circles and tags each object by origin', async () => {
  await withTwoCircles(async () => {
    const fed = await loadFederated();
    assert.equal(fed.circles.length, 2);
    const byId = Object.fromEntries(fed.containers.map(c => [c.id, c]));
    assert.equal(byId.a_proj._circle, 'A');
    assert.equal(byId.b_proj._circle, 'B');
    assert.equal(fed.workspace.id, 'A'); // primary
  });
});

test('a new project tagged for circle B is written ONLY to B', async () => {
  await withTwoCircles(async ({ pathA, pathB }) => {
    const fed = await loadFederated();
    fed.containers.push({ id: 'b_new', type: 'project', title: 'New in B', _circle: 'B', updated_at: '2026-06-02T00:00:00Z' });
    const { state } = await saveFederated(fed);
    const a = await readJson(pathA), b = await readJson(pathB);
    assert.ok(b.containers.find(c => c.id === 'b_new'), 'b_new should land in circle B');
    assert.ok(!a.containers.find(c => c.id === 'b_new'), 'b_new must NOT land in circle A');
    // The _circle tag is a runtime marker — never persisted to disk.
    assert.ok(!('_circle' in b.containers.find(c => c.id === 'b_new')));
    // Re-federated result carries it back tagged.
    assert.equal(state.containers.find(c => c.id === 'b_new')._circle, 'B');
  });
});

test('a blank state.json in one circle loads as empty, does NOT blank the others (T38)', async () => {
  await withTwoCircles(async ({ pathB }) => {
    await writeFile(pathB, '', 'utf8');   // user touched an empty file in the new circle
    const fed = await loadFederated();    // must not throw
    assert.ok(fed.containers.find(c => c.id === 'a_proj'), 'circle A still loads');
    assert.equal(fed.circles.length, 2, 'circle B still listed (empty)');
    // The blank circle now has a STABLE minted id (initialized on load).
    const bCircle = fed.circles.find(c => !c.primary);
    assert.ok(bCircle.id, 'blank circle got a stable id');
    assert.ok(JSON.parse(await readFile(pathB, 'utf8')).workspace.id, 'id persisted to the file');
    // Creating a project in the blank circle routes to its file.
    fed.containers.push({ id: 'b_first', type: 'project', title: 'First in B', _circle: bCircle.id, updated_at: '2026-06-09T00:00:00Z' });
    await saveFederated(fed);
    const b = JSON.parse(await readFile(pathB, 'utf8'));
    assert.ok(b.containers.find(c => c.id === 'b_first'), 'project lands in the formerly-blank circle');
  });
});

test('an external concurrent edit to circle B is merged in, not clobbered', async () => {
  await withTwoCircles(async ({ pathB }) => {
    // First save establishes the snapshot baseline for both circles.
    const fed = await loadFederated();
    await saveFederated(fed);

    // Peer edits B's file directly (adds an atom) while we hold an older view.
    const b = await readJson(pathB);
    b.atoms.push({ id: 'peer_atom', entry_id: 'e', kind: 'action', body: 'from peer', updated_at: '2026-06-03T00:00:00Z' });
    await writeFile(pathB, JSON.stringify(b), 'utf8');

    // We save our (stale) federated view `fed` (captured before the peer's edit)
    // with our own change in A — the merge must keep BOTH the peer's atom and ours.
    fed.containers.find(c => c.id === 'a_proj').title = 'Alpha v2';
    fed.containers.find(c => c.id === 'a_proj').updated_at = '2026-06-04T00:00:00Z';
    const { state } = await saveFederated(fed);

    const after = await readJson(pathB);
    assert.ok(after.atoms.find(x => x.id === 'peer_atom'), 'peer atom must survive the concurrent save');
    assert.ok(state.atoms.find(x => x.id === 'peer_atom'), 're-federated view includes the peer atom');
    assert.equal(state.containers.find(c => c.id === 'a_proj').title, 'Alpha v2', 'our edit also kept');
  });
});
