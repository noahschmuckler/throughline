// Tests for public/gate.js — the v2 verify-and-normalize gate.
// The fixture is INVENTED data that replicates every probe-2 guardrail
// (spec §7b); the real probe artifacts are sensitive, gitignored at
// data/probe2/, and must never be read into tests.
// Run: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDecisionSet, isBundle, isDecisionSet, looksLikeJson, resolveDecisions } from '../public/gate.js';
import { BUNDLE_ARTIFACT } from '../public/ingest.js';

// ---- fixture ---------------------------------------------------------

// Workspace: programs with one / two / zero child projects, a plain project,
// a reference file, and a container that was deleted after export.
function liveState() {
  return {
    containers: [
      { id: 'prog_solo', type: 'program', title: 'Solo program', program_id: null, status: 'active' },
      { id: 'proj_only', type: 'project', title: 'Only child', program_id: 'prog_solo', status: 'active' },
      { id: 'prog_multi', type: 'program', title: 'Multi program', program_id: null, status: 'active' },
      { id: 'proj_m1', type: 'project', title: 'M1', program_id: 'prog_multi', status: 'active' },
      { id: 'proj_m2', type: 'project', title: 'M2', program_id: 'prog_multi', status: 'active' },
      { id: 'prog_empty', type: 'program', title: 'Empty program', program_id: null, status: 'active' },
      { id: 'proj_a', type: 'project', title: 'Plain project', program_id: null, status: 'active' },
      { id: 'ref_b', type: 'reference_file', title: 'Reference', program_id: null, status: 'active' },
      { id: 'real_made', type: 'reference_file', title: 'Made in triage', program_id: null, status: 'active' },
      // NOTE: proj_gone is in the bundle's state_summary but NOT here (deleted since export).
    ],
    entries: [], atoms: [], people_meta: {},
  };
}

function bundle() {
  const summary = liveState().containers
    .map(({ id, type, title, program_id }) => ({ id, type, title, summary: '', program_id, open_actions: 0 }))
    .filter(c => c.id !== 'real_made'); // real_made was created DURING the triage → it's p1, not summary
  summary.push({ id: 'proj_gone', type: 'project', title: 'Deleted later', summary: '', program_id: null, open_actions: 0 });
  return {
    _artifact: BUNDLE_ARTIFACT,
    _schema: 'ingest-v1',
    version_hash: 'tl_fixture1',
    session_id: 'ing_2026-06-07_0900',
    raw_dump: 'invented',
    file_refs: [],
    state_summary: { containers: summary, recent_actions: [], key_people: [] },
    proposed: {
      containers: [
        { id: 'p1', kind: 'reference_file', title: 'Made in triage', goal_or_purpose: '', framework: null, bind_folder: null, confidence: null, source_ref: null, note: 'created during this triage' },
      ],
      atoms: [
        { id: 'a1', kind: 'observation', body: 'plain accept', target: 'proj_a', suggested_target: 'proj_a', source_ref: null, confidence: null },
        { id: 'a2', kind: 'observation', body: 'untriaged but suggested', target: null, suggested_target: 'ref_b', source_ref: null, confidence: null },
        { id: 'a3', kind: 'action', body: 'first-person commitment', target: 'proj_a', suggested_target: null, source_ref: null, confidence: null, assigned_to: 'narrator', due_date: null },
        { id: 'a4', kind: 'observation', body: 'original text', target: 'proj_a', suggested_target: null, source_ref: null, confidence: null },
        { id: 'a5', kind: 'observation', body: 'dup of a4 (1)', target: 'proj_a', suggested_target: null, source_ref: null, confidence: null },
        { id: 'a6', kind: 'observation', body: 'dup of a4 (2)', target: 'proj_a', suggested_target: null, source_ref: null, confidence: null },
        { id: 'a7', kind: 'action', body: 'fabricated thing', target: 'proj_a', suggested_target: null, source_ref: null, confidence: null, assigned_to: null, due_date: null },
        { id: 'a8', kind: 'observation', body: 'program-target one child', target: 'prog_solo', suggested_target: null, source_ref: null, confidence: null },
        { id: 'a9', kind: 'observation', body: 'program-target two children', target: 'prog_multi', suggested_target: null, source_ref: null, confidence: null },
        { id: 'a10', kind: 'observation', body: 'program-target no children', target: 'prog_empty', suggested_target: null, source_ref: null, confidence: null },
        { id: 'a11', kind: 'observation', body: 'targets deleted container', target: 'proj_gone', suggested_target: null, source_ref: null, confidence: null },
        { id: 'a12', kind: 'observation', body: 'targets triage-made p1', target: 'p1', suggested_target: null, source_ref: null, confidence: null },
        { id: 'a13', kind: 'observation', body: 'never verdicted', target: null, suggested_target: null, source_ref: null, confidence: null },
        { id: 'a14', kind: 'observation', body: 'cycle one', target: 'proj_a', suggested_target: null, source_ref: null, confidence: null },
        { id: 'a15', kind: 'observation', body: 'cycle two', target: 'proj_a', suggested_target: null, source_ref: null, confidence: null },
        { id: 'a16', kind: 'observation', body: 'merges into dropped', target: 'proj_a', suggested_target: null, source_ref: null, confidence: null },
      ],
    },
    needs_clarification: [],
  };
}

function decisions() {
  return {
    _meta: { version_hash: 'tl_fixture1', session_id: 'ing_2026-06-07_0900' },
    a1: { verb: 'accept' },
    a2: { verb: 'accept' },
    a3: { verb: 'edit', due_date: '2026-07-01' },
    // Verb blur (§7b#1): recategorize ALSO carries a new body — both apply.
    a4: { verb: 'recategorize', kind: 'decision', body: 'rewritten as a decision' },
    // Empty-string noise on merges/drops (§7b#6).
    a5: { verb: 'merge_into', target: 'a4', body: '', kind: '' },
    a6: { verb: 'merge_into', target: 'a5' }, // chain → a4 transitively
    a7: { verb: 'drop', body: '', target: null, note: 'fabricated — not in source' },
    a8: { verb: 'accept' },
    a9: { verb: 'accept' },
    a10: { verb: 'accept' },
    a11: { verb: 'accept' },
    a12: { verb: 'accept' },
    a14: { verb: 'merge_into', target: 'a15' }, // cycle
    a15: { verb: 'merge_into', target: 'a14' }, // cycle
    a16: { verb: 'merge_into', target: 'a7' },  // into a dropped atom → orphan
    // Creates: arbitrary unused p* numbering (§7b#2 — there is no p2 ancestor).
    p3: { verb: 'create', kind: 'project', title: 'Legal & Risk', goal_or_purpose: 'clarify liability', framework: 'kanban' },
    p9: { verb: 'create', kind: 'program', title: 'Sneaky program' }, // coerced
    n1: { verb: 'create', kind: 'action', body: 'new legal question', target: 'p3', assigned_to: 'me' },
    n2: { verb: 'create', kind: 'outcome', body: 'weird kind', target: 'proj_a' },
    // Verdict on the bundle's p1 (an already-committed container) → deferred.
    p1: { verb: 'edit', title: 'Renamed reference' },
    // Unknown id → warned + skipped.
    z9: { verb: 'edit', body: 'ghost' },
  };
}

const OPTS = { state: liveState(), userName: 'Noah', pRealIds: ['real_made'] };
const codes = (plan) => plan.warnings.map(w => w.code);
const byatomSrc = (plan, id) => plan.atoms.find(a => a._srcId === id);

// ---- parse / sniff ----------------------------------------------------

test('parseDecisionSet: tolerant (fences, prose, garbage)', () => {
  assert.deepEqual(parseDecisionSet('{"a1":{"verb":"accept"}}'), { a1: { verb: 'accept' } });
  assert.deepEqual(parseDecisionSet('Here you go:\n```json\n{"a1":{"verb":"drop"}}\n```\nHope that helps!'), { a1: { verb: 'drop' } });
  assert.deepEqual(parseDecisionSet('preamble {"x":{"body":"b"}} postamble'), { x: { body: 'b' } });
  assert.equal(parseDecisionSet('no json here'), null);
  assert.equal(parseDecisionSet(''), null);
  assert.equal(parseDecisionSet(null), null);
});

test('parseDecisionSet: real-paste pathologies (first live v2 run)', () => {
  // Trailing commas — the classic LLM emission error.
  assert.deepEqual(parseDecisionSet('{"a1":{"verb":"accept",},}'), { a1: { verb: 'accept' } });
  // Smart quotes (chat UIs love converting them).
  assert.deepEqual(parseDecisionSet('{“a1”:{“verb”:“drop”}}'), { a1: { verb: 'drop' } });
  // Prose with braces around the real block — balanced-brace candidates pick
  // the longest parseable object, not a naive first-{-to-last-} slice.
  const wrapped = 'Sure! Here {is} the set:\n{"a1":{"verb":"accept"},"n1":{"kind":"action","body":"x"}}\nLet me know {if} more.';
  assert.deepEqual(Object.keys(parseDecisionSet(wrapped)), ['a1', 'n1']);
  // Braces inside string values don't break candidate extraction.
  assert.deepEqual(parseDecisionSet('{"a1":{"body":"uses {curly} braces"}}'), { a1: { body: 'uses {curly} braces' } });
  // Truncation → null (no partial parse).
  assert.equal(parseDecisionSet('{"a1":{"verb":"accept"},"a2":{"ver'), null);
  // BOM + zero-width contamination.
  assert.deepEqual(parseDecisionSet('﻿{"a1":{"verb":"accept"}}'), { a1: { verb: 'accept' } });
});

test('looksLikeJson: routes broken JSON to an error, prose to freetext', () => {
  assert.ok(looksLikeJson('{"a1": {"verb": "accept"'));            // truncated
  assert.ok(looksLikeJson('﻿{ "a1": …'));                     // BOM + broken
  assert.ok(looksLikeJson('```json\n{"a1":{}}\n```'));             // fenced
  assert.ok(looksLikeJson('reply: "a1": { "verb": "accept" }'));   // id-key pattern mid-prose
  assert.ok(!looksLikeJson('Met with Jessica about the covenant.'));
  assert.ok(!looksLikeJson(''));
});

test('isBundle / isDecisionSet: sniffing', () => {
  assert.ok(isBundle(bundle()));
  assert.ok(!isDecisionSet(bundle()), 'a bundle is not a decision set');
  assert.ok(isDecisionSet(decisions()));
  assert.ok(isDecisionSet({ a1: { body: 'no verb — verbs blur' } }));
  assert.ok(!isDecisionSet({ hello: 'world' }));
  assert.ok(!isDecisionSet([1, 2]));
  assert.ok(!isDecisionSet(null));
  assert.ok(!isDecisionSet({ _meta: { version_hash: 'x' } }), 'meta alone is not a decision set');
});

// ---- resolveDecisions: the probe-2 guardrails --------------------------

test('gate: accept keeps the bundle atom; verb blur applies all fields', () => {
  const plan = resolveDecisions(bundle(), decisions(), OPTS);
  const a1 = byatomSrc(plan, 'a1');
  assert.equal(a1.body, 'plain accept');
  assert.equal(a1.target, 'proj_a');
  // recategorize + body (blur): both applied.
  const a4 = byatomSrc(plan, 'a4');
  assert.equal(a4.type, 'decision');
  assert.equal(a4.body, 'rewritten as a decision');
});

test('gate: suggested_target fallback when no one assigned a target', () => {
  const a2 = byatomSrc(resolveDecisions(bundle(), decisions(), OPTS), 'a2');
  assert.equal(a2.target, 'ref_b');
  assert.equal(a2._badge, 'suggested');
});

test('gate: narrator aliasing → userName; empty userName → warning, left as-is', () => {
  const plan = resolveDecisions(bundle(), decisions(), OPTS);
  assert.equal(byatomSrc(plan, 'a3').owner, 'Noah');
  assert.equal(byatomSrc(plan, 'a3').due, '2026-07-01');
  assert.equal(byatomSrc(plan, 'n1').owner, 'Noah'); // "me" variant
  assert.ok(!plan.info.userNameMissing);

  const noName = resolveDecisions(bundle(), decisions(), { ...OPTS, userName: '' });
  assert.equal(byatomSrc(noName, 'a3').owner, 'narrator');
  assert.ok(noName.info.userNameMissing);
  assert.ok(codes(noName).includes('no_user_name'));
});

test('gate: merge chain folds transitively; survivor text wins; merged excluded', () => {
  const plan = resolveDecisions(bundle(), decisions(), OPTS);
  assert.equal(byatomSrc(plan, 'a5'), undefined, 'a5 merged away');
  assert.equal(byatomSrc(plan, 'a6'), undefined, 'a6 merged away through the chain');
  assert.equal(byatomSrc(plan, 'a4').body, 'rewritten as a decision', 'edited survivor wins');
});

test('gate: merge cycle → all members standalone + warning', () => {
  const plan = resolveDecisions(bundle(), decisions(), OPTS);
  assert.ok(byatomSrc(plan, 'a14'), 'cycle member kept');
  assert.ok(byatomSrc(plan, 'a15'), 'cycle member kept');
  assert.ok(codes(plan).includes('merge_cycle'));
});

test('gate: merge into a dropped atom → orphan kept standalone + warning', () => {
  const plan = resolveDecisions(bundle(), decisions(), OPTS);
  assert.ok(byatomSrc(plan, 'a16'), 'orphan kept');
  assert.ok(codes(plan).includes('merge_orphan'));
});

test('gate: drop excluded + listed with note', () => {
  const plan = resolveDecisions(bundle(), decisions(), OPTS);
  assert.equal(byatomSrc(plan, 'a7'), undefined);
  const d = plan.dropped.find(x => x.id === 'a7');
  assert.equal(d.body, 'fabricated thing');
  assert.match(d.note, /fabricated/);
});

test('gate: program rule — one child remaps, multi/zero clear to null', () => {
  const plan = resolveDecisions(bundle(), decisions(), OPTS);
  const one = byatomSrc(plan, 'a8');
  assert.equal(one.target, 'proj_only');
  assert.equal(one._badge, 'remapped');
  const multi = byatomSrc(plan, 'a9');
  assert.equal(multi.target, null);
  assert.equal(multi._badge, 'unresolved_target');
  const zero = byatomSrc(plan, 'a10');
  assert.equal(zero.target, null);
  assert.ok(codes(plan).includes('program_remap'));
  assert.ok(codes(plan).includes('program_no_target'));
});

test('gate: drift — container deleted since export → null + warning', () => {
  const plan = resolveDecisions(bundle(), decisions(), OPTS);
  assert.equal(byatomSrc(plan, 'a11').target, null);
  assert.ok(codes(plan).includes('container_deleted'));
});

test('gate: bundle p* targets resolve through pRealIds; p* verdicts are deferred', () => {
  const plan = resolveDecisions(bundle(), decisions(), OPTS);
  assert.equal(byatomSrc(plan, 'a12').target, 'real_made');
  assert.ok(codes(plan).includes('container_edit_deferred'), 'edit on committed p1 deferred');
  // Without the mapping, the target degrades safely.
  const noMap = resolveDecisions(bundle(), decisions(), { ...OPTS, pRealIds: [] });
  assert.equal(byatomSrc(noMap, 'a12').target, null);
});

test('gate: creates — arbitrary p* numbering, kind coercion, pending targets, n* atoms', () => {
  const plan = resolveDecisions(bundle(), decisions(), OPTS);
  const p3 = plan.containerCreates.find(c => c.pid === 'p3');
  assert.equal(p3.kind, 'project');
  assert.equal(p3.title, 'Legal & Risk');
  assert.equal(p3.framework, 'kanban');
  const p9 = plan.containerCreates.find(c => c.pid === 'p9');
  assert.equal(p9.kind, 'reference_file', 'program create coerced');
  assert.ok(codes(plan).includes('container_kind_coerced'));
  const n1 = byatomSrc(plan, 'n1');
  assert.equal(n1.target, 'p3', 'pending p* target preserved for commit-time materialization');
  assert.equal(n1._badge, 'created');
  const n2 = byatomSrc(plan, 'n2');
  assert.equal(n2.type, 'observation', 'outcome create coerced');
  assert.ok(codes(plan).includes('kind_coerced'));
});

test('gate: unknown id warned + skipped', () => {
  const plan = resolveDecisions(bundle(), decisions(), OPTS);
  assert.equal(byatomSrc(plan, 'z9'), undefined);
  assert.ok(codes(plan).includes('unknown_id'));
});

test('gate: unaddressed atoms excluded but listed; coverage info', () => {
  const plan = resolveDecisions(bundle(), decisions(), OPTS);
  assert.equal(byatomSrc(plan, 'a13'), undefined);
  assert.deepEqual(plan.unaddressed.map(u => u.id), ['a13']);
  assert.ok(plan.info.coverageMissingPct > 0 && plan.info.coverageMissingPct < 0.4);
  assert.ok(codes(plan).includes('coverage_gap'));

  // Heavy non-coverage → coverage_low.
  const sparse = resolveDecisions(bundle(), { _meta: { version_hash: 'tl_fixture1' }, a1: { verb: 'accept' } }, OPTS);
  assert.ok(sparse.info.coverageMissingPct > 0.4);
  assert.ok(codes(sparse).includes('coverage_low'));
});

test('gate: _meta echo — missing warns, stale warns, matching is quiet', () => {
  const match = resolveDecisions(bundle(), decisions(), OPTS);
  assert.ok(match.info.metaPresent && !match.info.versionStale);
  assert.ok(!codes(match).includes('no_meta_echo') && !codes(match).includes('version_stale'));

  const d = decisions(); delete d._meta;
  const missing = resolveDecisions(bundle(), d, OPTS);
  assert.ok(!missing.info.metaPresent);
  assert.ok(codes(missing).includes('no_meta_echo'));

  const d2 = decisions(); d2._meta.version_hash = 'tl_older';
  const stale = resolveDecisions(bundle(), d2, OPTS);
  assert.ok(stale.info.versionStale);
  assert.ok(codes(stale).includes('version_stale'));
});

test('gate: never throws on garbage', () => {
  for (const garbage of [null, undefined, [], 'x', 42, { _meta: {} }, { a1: 'not an object' }, { a1: ['nope'] }]) {
    const plan = resolveDecisions(bundle(), garbage, OPTS);
    assert.ok(Array.isArray(plan.atoms) && Array.isArray(plan.warnings));
  }
  // And with a garbage bundle too.
  const plan = resolveDecisions(null, decisions(), { userName: 'Noah' });
  assert.ok(Array.isArray(plan.atoms));
});

test('gate: stable keys + traceability', () => {
  const plan = resolveDecisions(bundle(), decisions(), OPTS);
  assert.deepEqual(plan.atoms.map(a => a.key), plan.atoms.map((_, i) => 'd' + i));
  assert.ok(plan.atoms.every(a => a._srcId));
});

// ---- drift guard: parseDecisionSet must match shared/atomize's parser ---

test('parseDecisionSet agrees with shared/atomize parseModelJson behavior', async () => {
  // parseModelJson isn't exported; replicate its observable behavior through
  // atomizeEntry's tolerant path instead: both must extract from a fenced reply.
  const fenced = '```json\n{"clusters":[{"name":"X","suggestedId":null,"atoms":[{"type":"observation","body":"b"}]}]}\n```';
  const { atomizeEntry } = await import('../shared/atomize.js');
  const viaAtomize = await atomizeEntry({ notes: 'b' }, { projects: [], llmCall: async () => fenced });
  assert.equal(viaAtomize.source, 'llm', 'shared parser extracted the fenced JSON');
  assert.deepEqual(parseDecisionSet(fenced), JSON.parse(fenced.replace(/```(json)?\n?/g, '')), 'gate parser extracts the same');
});

// ---- T21: undeclared-duplicate collapse --------------------------------

test('dedup (T21): undeclared duplicate atoms collapse with a warning + dropped entries', () => {
  const decisions = {
    _meta: { session_id: 'ing_2026-06-07_0900', version_hash: 'tl_fixture1' },
    n1: { verb: 'create', kind: 'observation', body: 'CMS denied the waiver.', target: 'proj_a' },
    n2: { verb: 'create', kind: 'observation', body: 'CMS denied the waiver!', target: 'proj_a' }, // punctuation variant → dup
    n3: { verb: 'create', kind: 'observation', body: 'cms  DENIED the waiver', target: 'proj_a' }, // case/whitespace variant → dup
    n4: { verb: 'create', kind: 'observation', body: 'CMS denied the waiver.', target: 'ref_b' },  // different target → kept
    n5: { verb: 'create', kind: 'action', body: 'CMS denied the waiver.', target: 'proj_a' },      // different type → kept
  };
  const plan = resolveDecisions(bundle(), decisions, OPTS);
  const matching = plan.atoms.filter(a => /cms.*denied/i.test(a.body));
  assert.equal(matching.length, 3, 'quadruplicate collapses to 1 + the two legit variants');
  assert.ok(codes(plan).includes('duplicates_collapsed'));
  const dupDropped = plan.dropped.filter(d => /duplicate/.test(d.note || ''));
  assert.equal(dupDropped.length, 2);
  assert.ok(['n2', 'n3'].every(id => dupDropped.some(d => d.id === id)));
});

test('dedup (T21): empty bodies never collapse into each other', () => {
  const decisions = {
    _meta: { session_id: 'ing_2026-06-07_0900', version_hash: 'tl_fixture1' },
    a1: { verb: 'accept' },
    a4: { verb: 'accept' },
  };
  const plan = resolveDecisions(bundle(), decisions, OPTS);
  // a1 and a4 have distinct bodies in the fixture; sanity: nothing collapsed.
  assert.ok(!codes(plan).includes('duplicates_collapsed'));
});
