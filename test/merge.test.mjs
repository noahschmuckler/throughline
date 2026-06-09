// M1 3-way merge engine (shared/merge.js). The reliability core for two people
// editing one circle concurrently — disjoint changes must combine losslessly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeStates } from '../shared/merge.js';

const c = (id, extra = {}) => ({ id, type: 'project', title: id, updated_at: '2026-06-01T00:00:00Z', ...extra });
const atom = (id, extra = {}) => ({ id, entry_id: 'e1', kind: 'action', body: id, updated_at: '2026-06-01T00:00:00Z', ...extra });
const st = (o = {}) => ({ schema_version: 3, containers: [], entries: [], atoms: [], people_meta: {}, workspace: { id: 'w1', name: 'C' }, ...o });

test('disjoint additions merge with zero loss', () => {
  const base = st({ containers: [c('p0')] });
  const ours = st({ containers: [c('p0'), c('p1')] });     // we added p1
  const theirs = st({ containers: [c('p0'), c('p2')] });   // they added p2
  const { merged, conflicts } = mergeStates(base, ours, theirs);
  const ids = merged.containers.map(x => x.id).sort();
  assert.deepEqual(ids, ['p0', 'p1', 'p2']);
  assert.equal(conflicts.length, 0);
});

test('one-sided delete is honored when the other side did not touch it', () => {
  const base = st({ atoms: [atom('a1'), atom('a2')] });
  const ours = st({ atoms: [atom('a1')] });               // we deleted a2
  const theirs = st({ atoms: [atom('a1'), atom('a2')] });  // they left it
  const { merged, conflicts } = mergeStates(base, ours, theirs);
  assert.deepEqual(merged.atoms.map(a => a.id), ['a1']);
  assert.equal(conflicts.length, 0);
});

test('disjoint field edits on the same object both survive', () => {
  const base = st({ containers: [c('p1', { title: 'Old', goal_or_purpose: 'G' })] });
  const ours = st({ containers: [c('p1', { title: 'New title', goal_or_purpose: 'G', updated_at: '2026-06-02T00:00:00Z' })] });
  const theirs = st({ containers: [c('p1', { title: 'Old', goal_or_purpose: 'New goal', updated_at: '2026-06-03T00:00:00Z' })] });
  const { merged, conflicts } = mergeStates(base, ours, theirs);
  const p = merged.containers.find(x => x.id === 'p1');
  assert.equal(p.title, 'New title');        // our field
  assert.equal(p.goal_or_purpose, 'New goal'); // their field
  assert.equal(conflicts.length, 0);
});

test('same-field conflict resolves to newer updated_at and is recorded', () => {
  const base = st({ containers: [c('p1', { title: 'Old' })] });
  const ours = st({ containers: [c('p1', { title: 'Ours', updated_at: '2026-06-02T00:00:00Z' })] });
  const theirs = st({ containers: [c('p1', { title: 'Theirs', updated_at: '2026-06-05T00:00:00Z' })] }); // newer
  const { merged, conflicts } = mergeStates(base, ours, theirs);
  const p = merged.containers.find(x => x.id === 'p1');
  assert.equal(p.title, 'Theirs');           // newer wins
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].field, 'title');
  assert.equal(conflicts[0].kept, 'Theirs');
  assert.equal(conflicts[0].dropped, 'Ours');
});

test('delete-vs-edit keeps the edit (no silent loss) and records it', () => {
  const base = st({ atoms: [atom('a1', { body: 'orig' })] });
  const ours = st({ atoms: [] });                                  // we deleted a1
  const theirs = st({ atoms: [atom('a1', { body: 'edited', updated_at: '2026-06-04T00:00:00Z' })] }); // they edited it
  const { merged, conflicts } = mergeStates(base, ours, theirs);
  assert.deepEqual(merged.atoms.map(a => a.id), ['a1']);
  assert.equal(merged.atoms[0].body, 'edited');
  assert.equal(conflicts[0].kind, 'delete-edit');
});

test('people_meta merges per key; both-changed flags a conflict', () => {
  const base = st({ people_meta: { Noah: { title: 'MD' } } });
  const ours = st({ people_meta: { Noah: { title: 'MD' }, Amanda: { title: 'Ops' } } }); // added Amanda
  const theirs = st({ people_meta: { Noah: { title: 'Director' } } });                   // changed Noah
  const { merged, conflicts } = mergeStates(base, ours, theirs);
  assert.equal(merged.people_meta.Amanda.title, 'Ops');     // disjoint add survives
  assert.equal(merged.people_meta.Noah.title, 'Director');  // their change (ours unchanged)
  assert.equal(conflicts.length, 0);
});

test('unknown top-level keys + workspace identity survive the merge', () => {
  const base = st();
  const ours = st({ _custom: 'keep-me' });
  const theirs = st({ workspace: { id: 'w1', name: 'Renamed' } });
  const { merged } = mergeStates(base, ours, theirs);
  assert.equal(merged._custom, 'keep-me');
  assert.equal(merged.workspace.id, 'w1');
  assert.equal(merged.workspace.name, 'Renamed'); // disk identity wins
});
