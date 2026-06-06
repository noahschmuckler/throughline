// Tests for public/ingest.js — the Copilot-assisted ingestion bundle builders
// (v1, read-only consult). Run: node --test test/  (or: node test/ingest.test.mjs)
//
// Covers the two things the spec leans on: the state_summary reduction (open-
// action counts, exclusions, recent-action ordering, key-people aggregation) and
// the bundle shape + version_hash (deterministic, order-independent).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildStateSummary, buildProposed, buildNeedsClarification,
  assembleBundle, versionHash, stableStringify, sessionIdFrom,
  openActionsForContainer, keyPeopleOpen,
  BUNDLE_ARTIFACT, BUNDLE_SCHEMA,
} from '../public/ingest.js';

// A small workspace: one project (1 open + 1 closed action), one reference file
// (1 open action assigned to Amanda), an archived project, the Inbox, and people.
function fixture() {
  return {
    schema_version: 3,
    containers: [
      { id: 'c_proj', type: 'project', title: 'Payroll', summary: 'pay stuff', framework: 'kanban', status: 'active' },
      { id: 'c_ref', type: 'reference_file', title: 'SOPs', goal_or_purpose: 'how-to', status: 'active' },
      { id: 'c_arch', type: 'project', title: 'Old', status: 'archived' },
      { id: 'inbox', type: 'inbox', title: 'Inbox', status: 'active' },
    ],
    entries: [
      { id: 'e_proj', container_id: 'c_proj' },
      { id: 'e_ref', container_id: 'c_ref' },
      { id: 'e_arch', container_id: 'c_arch' },
    ],
    atoms: [
      { id: 'a_open', kind: 'action', body: 'do X', entry_id: 'e_proj', assigned_to: 'Natalia', due_date: '2026-06-20', created_at: '2026-06-03T10:00:00Z' },
      { id: 'a_closed', kind: 'action', body: 'did Y', entry_id: 'e_proj', assigned_to: 'Natalia', created_at: '2026-06-01T10:00:00Z' },
      { id: 'o_close', kind: 'outcome', body: 'Y done', entry_id: 'e_proj', parent_atom_id: 'a_closed', created_at: '2026-06-02T10:00:00Z' },
      { id: 'a_ref', kind: 'action', body: 'ref task', entry_id: 'e_ref', assigned_to: 'Amanda', created_at: '2026-06-04T10:00:00Z' },
      { id: 'a_archived', kind: 'action', body: 'old task', entry_id: 'e_arch', assigned_to: 'Bob', created_at: '2026-05-01T10:00:00Z' },
    ],
    people_meta: {},
  };
}

test('openActionsForContainer: action minus closing outcome', () => {
  const s = fixture();
  assert.deepEqual(openActionsForContainer(s, 'c_proj').map(a => a.id), ['a_open']); // a_closed excluded
  assert.deepEqual(openActionsForContainer(s, 'c_ref').map(a => a.id), ['a_ref']);
});

test('keyPeopleOpen: only open work, busiest first', () => {
  const s = fixture();
  const people = keyPeopleOpen(s);
  // Natalia 1 open (a_closed is closed), Amanda 1, Bob 1 (archived container still
  // has the atom — people is workspace-wide). Sorted by open desc then name.
  assert.deepEqual(people, [
    { name: 'Amanda', open: 1 },
    { name: 'Bob', open: 1 },
    { name: 'Natalia', open: 1 },
  ]);
});

test('buildStateSummary: excludes inbox/archived, counts open actions, frameworks', () => {
  const s = fixture();
  const sum = buildStateSummary(s);
  const ids = sum.containers.map(c => c.id);
  assert.ok(ids.includes('c_proj') && ids.includes('c_ref'));
  assert.ok(!ids.includes('inbox'), 'inbox excluded');
  assert.ok(!ids.includes('c_arch'), 'archived excluded');

  const proj = sum.containers.find(c => c.id === 'c_proj');
  assert.equal(proj.framework, 'kanban');
  assert.equal(proj.open_actions, 1);
  assert.equal(proj.summary, 'pay stuff');

  const ref = sum.containers.find(c => c.id === 'c_ref');
  assert.equal(ref.open_actions, 1);
  assert.ok(!('framework' in ref), 'framework only on projects');
  assert.equal(ref.summary, 'how-to'); // falls back to goal_or_purpose
});

test('buildStateSummary: recent_actions exclude closed, newest first, capped', () => {
  const s = fixture();
  const sum = buildStateSummary(s, { maxRecentActions: 2 });
  // open actions only: a_open (06-03), a_ref (06-04), a_archived (05-01). Closed
  // a_closed excluded. Newest-first, cap 2 → a_ref, a_open.
  assert.deepEqual(sum.recent_actions.map(a => a.id), ['a_ref', 'a_open']);
  const first = sum.recent_actions[0];
  assert.deepEqual(Object.keys(first).sort(), ['body', 'container_id', 'due_date', 'id']);
  assert.equal(sum.recent_actions[1].due_date, '2026-06-20');
});

test('buildStateSummary: excludeIds drops those containers', () => {
  const s = fixture();
  const sum = buildStateSummary(s, { excludeIds: ['c_proj'] });
  assert.ok(!sum.containers.some(c => c.id === 'c_proj'));
  assert.ok(sum.containers.some(c => c.id === 'c_ref'));
});

test('buildProposed: new containers → p*, atoms → a*, target remap', () => {
  const draft = {
    newContainers: [
      { id: 'real_new', type: 'reference_file', title: 'Provider Roster', folder: 'Provider Corner' },
    ],
    atoms: [
      { type: 'action', body: 'cred check', owner: 'Natalia', due: '2026-06-20', target: 'real_new' },
      { type: 'observation', body: 'people ask', target: 'c_existing' },
      { type: 'action', body: 'unsorted', target: null },
      { type: 'decision', body: 'inbox one', target: 'inbox' },
    ],
  };
  const p = buildProposed(draft);

  assert.equal(p.containers.length, 1);
  const pc = p.containers[0];
  assert.equal(pc.id, 'p1');
  assert.equal(pc.kind, 'reference_file');
  assert.equal(pc.framework, null);        // not a project
  assert.equal(pc.bind_folder, 'Provider Corner');
  assert.equal(pc.source_ref, null);

  assert.deepEqual(p.atoms.map(a => a.id), ['a1', 'a2', 'a3', 'a4']);
  assert.equal(p.atoms[0].target, 'p1');   // created real id → p1
  assert.equal(p.atoms[0].assigned_to, 'Natalia');
  assert.equal(p.atoms[0].due_date, '2026-06-20');
  assert.equal(p.atoms[1].target, 'c_existing'); // existing id preserved
  assert.equal(p.atoms[2].target, null);
  assert.equal(p.atoms[3].target, 'inbox');
  assert.ok(!('assigned_to' in p.atoms[1]), 'non-actions carry no action fields');
});

test('buildProposed: project new container keeps framework', () => {
  const p = buildProposed({ newContainers: [{ id: 'x', type: 'project', title: 'P', framework: 'pdsa' }], atoms: [] });
  assert.equal(p.containers[0].framework, 'pdsa');
});

test('buildNeedsClarification: unassigned + new container prompts', () => {
  const q = buildNeedsClarification({
    atoms: [{ target: null }, { target: 'c1' }, { target: null }],
    newContainers: [{ title: 'Roster' }],
  });
  assert.equal(q.length, 2);
  assert.match(q[0], /2 unassigned/);
  assert.match(q[1], /Roster/);
  assert.deepEqual(buildNeedsClarification({ atoms: [{ target: 'c1' }], newContainers: [] }), []);
});

test('versionHash: deterministic, key-order independent, sensitive to content', () => {
  const a = { containers: [{ id: 'p1', title: 'X' }], atoms: [{ id: 'a1', body: 'b' }] };
  const b = { atoms: [{ body: 'b', id: 'a1' }], containers: [{ title: 'X', id: 'p1' }] }; // reordered keys
  assert.equal(versionHash(a), versionHash(b), 'order-independent');
  assert.match(versionHash(a), /^tl_[0-9a-f]{8}$/);
  assert.notEqual(versionHash(a), versionHash({ ...a, atoms: [{ id: 'a1', body: 'changed' }] }));
  assert.equal(versionHash(null), versionHash({})); // null guarded
});

test('stableStringify: sorts keys recursively', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});

test('sessionIdFrom: ISO → ing_date_HHMM', () => {
  assert.equal(sessionIdFrom('2026-06-06T14:00:00Z'), 'ing_2026-06-06_1400');
  assert.equal(sessionIdFrom('garbage'), 'ing_session');
});

test('assembleBundle: §2 envelope, version_hash over proposed, derived session_id', () => {
  const proposed = buildProposed({ newContainers: [], atoms: [{ type: 'observation', body: 'x', target: null }] });
  const bundle = assembleBundle({
    raw_dump: 'dump',
    file_refs: [{ ref_id: 'f1', path: 'a/b.xlsx', kind: 'xlsx', note: '' }],
    state_summary: buildStateSummary(fixture()),
    proposed,
    needs_clarification: ['q?'],
    now: '2026-06-06T14:00:00Z',
  });
  assert.equal(bundle._artifact, BUNDLE_ARTIFACT);
  assert.equal(bundle._schema, BUNDLE_SCHEMA);
  assert.equal(bundle.version_hash, versionHash(proposed));
  assert.equal(bundle.created_at, '2026-06-06T14:00:00Z');
  assert.equal(bundle.session_id, 'ing_2026-06-06_1400');
  assert.equal(bundle.raw_dump, 'dump');
  assert.equal(bundle.file_refs[0].path, 'a/b.xlsx');
  // round-trips as strict JSON
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(bundle)));
  // top-level keys exactly match the spec §2 shape
  assert.deepEqual(Object.keys(bundle).sort(), [
    '_artifact', '_schema', 'created_at', 'file_refs', 'needs_clarification',
    'proposed', 'raw_dump', 'session_id', 'state_summary', 'version_hash',
  ]);
});
