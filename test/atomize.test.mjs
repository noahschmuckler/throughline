// Tests for the atomize provenance seam (T8): atomizeEntry's `source` field
// (llm vs heuristic-degraded vs heuristic-only) and describeLLM (the
// human-readable model descriptor /api/atomize attaches as `llm`).
// Run: node --test test/

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { atomizeEntry, atomizeOpts } from '../shared/atomize.js';
import { describeLLM, makeLLMCall } from '../shared/llm.js';

const ENTRY = { title: 'Standup', notes: 'Alice to send the report by 2026-06-10. We decided to defer the migration.' };
const PROJECTS = [{ id: 'c_rep', title: 'Reporting', tags: ['report'], goal_or_purpose: '' }];

test('atomizeEntry: no llmCall → heuristic source', async () => {
  const r = await atomizeEntry(ENTRY, { projects: PROJECTS });
  assert.equal(r.source, 'heuristic');
  assert.ok(Array.isArray(r.clusters) && r.clusters.length);
});

test('atomizeEntry: good model reply → llm source', async () => {
  const llmCall = async () => JSON.stringify({
    clusters: [{ name: 'Reporting', suggestedId: 'c_rep', atoms: [{ type: 'action', body: 'Send the report', owner: 'Alice', due: '2026-06-10' }] }],
  });
  const r = await atomizeEntry(ENTRY, { projects: PROJECTS, llmCall });
  assert.equal(r.source, 'llm');
  assert.equal(r.clusters[0].suggestedId, 'c_rep');
});

test('atomizeEntry: garbage/throwing model reply → degrades to heuristic source', async () => {
  const garbage = await atomizeEntry(ENTRY, { projects: PROJECTS, llmCall: async () => 'sorry, I cannot help with that' });
  assert.equal(garbage.source, 'heuristic');
  const thrown = await atomizeEntry(ENTRY, { projects: PROJECTS, llmCall: async () => { throw new Error('network'); } });
  assert.equal(thrown.source, 'heuristic');
});

// ---- T20 step 2: tolerant repair parsing (mirrors the gate's) --------

const GOOD = { clusters: [{ name: 'Reporting', suggestedId: 'c_rep', atoms: [{ type: 'action', body: 'Send the report' }] }] };

test('atomizeEntry: repairable JSON pathologies → llm source (trailing commas, smart quotes, fences+prose)', async () => {
  // Trailing comma before } and ] — strict JSON.parse rejects, repair recovers.
  const trailing = JSON.stringify(GOOD).replace('}]}]}', '},]},]}');
  const r1 = await atomizeEntry(ENTRY, { projects: PROJECTS, llmCall: async () => trailing });
  assert.equal(r1.source, 'llm');

  // Smart quotes around a value + zero-width space.
  const smart = JSON.stringify(GOOD).replace('"Reporting"', '“Reporting”') + '​';
  const r2 = await atomizeEntry(ENTRY, { projects: PROJECTS, llmCall: async () => smart });
  assert.equal(r2.source, 'llm');

  // Fenced + prose aside containing braces (the {curly} mention must not win).
  const prose = `Here you go {ok}:\n\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\`\nHope that helps!`;
  const r3 = await atomizeEntry(ENTRY, { projects: PROJECTS, llmCall: async () => prose });
  assert.equal(r3.source, 'llm');
  assert.equal(r3.clusters[0].suggestedId, 'c_rep');
});

// ---- T20 step 1: degradation carries a failure reason ----------------

test('atomizeEntry: degraded runs say WHY in `fail`; clean runs have no fail', async () => {
  const ok = await atomizeEntry(ENTRY, { projects: PROJECTS, llmCall: async () => JSON.stringify(GOOD) });
  assert.equal(ok.fail, undefined);

  const thrown = await atomizeEntry(ENTRY, { projects: PROJECTS, llmCall: async () => { throw new Error('HTTP 504: gateway timeout'); } });
  assert.match(thrown.fail, /gateway timeout/);

  const empty = await atomizeEntry(ENTRY, { projects: PROJECTS, llmCall: async () => '   ' });
  assert.match(empty.fail, /empty reply/); // now tier-prefixed: "reason: empty reply"

  const truncated = await atomizeEntry(ENTRY, { projects: PROJECTS, llmCall: async () => JSON.stringify(GOOD).slice(0, 40) });
  assert.match(truncated.fail, /truncated/);

  const prose = await atomizeEntry(ENTRY, { projects: PROJECTS, llmCall: async () => 'sorry, I cannot help with that' });
  assert.match(prose.fail, /no parseable JSON/);

  const wrongShape = await atomizeEntry(ENTRY, { projects: PROJECTS, llmCall: async () => '{"items": []}' });
  assert.match(wrongShape.fail, /missing clusters/);

  const noModel = await atomizeEntry(ENTRY, { projects: PROJECTS });
  assert.equal(noModel.fail, undefined); // heuristic-only config is not a failure
});

test('describeLLM: provider/tier → descriptor; heuristic-shaped configs → null', () => {
  assert.equal(describeLLM({ LLM_PROVIDER: 'cdsapi' }, 'reason'), 'cdsapi · gpt-mini');
  assert.equal(describeLLM({ LLM_PROVIDER: 'cdsapi' }, 'classify'), 'cdsapi · gpt-nano');
  assert.equal(describeLLM({ LLM_PROVIDER: 'cdsapi', LLM_MODEL: 'gpt-5.4' }, 'reason'), 'cdsapi · gpt-5.4'); // pin wins
  assert.equal(describeLLM({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' }, 'reason'), 'anthropic · claude-sonnet-4-6');
  assert.equal(describeLLM({ LLM_PROVIDER: 'anthropic' }), null); // no key → makeLLMCall returns null too
  assert.equal(describeLLM({}), null);
  assert.equal(describeLLM({ LLM_PROVIDER: 'heuristic' }), null);
});

// ---- T20 steps 3-4: tier + onFail experiment knobs --------------------

test('atomizeOpts: env validation with safe defaults', () => {
  // T30 (2026-06-08): default tier flipped reason→escalate (gpt-mini retired).
  assert.deepEqual(atomizeOpts({}), { tier: 'escalate', onFail: 'heuristic' });
  assert.deepEqual(atomizeOpts({ ATOMIZE_TIER: 'reason', ATOMIZE_ON_FAIL: 'error' }), { tier: 'reason', onFail: 'error' });
  assert.deepEqual(atomizeOpts({ ATOMIZE_TIER: 'bogus', ATOMIZE_ON_FAIL: 'bogus' }), { tier: 'escalate', onFail: 'heuristic' });
});

test('atomizeEntry: tier passes through to llmCall; result records it', async () => {
  let captured = null;
  const llmCall = async (args) => { captured = args; return JSON.stringify(GOOD); };
  const r = await atomizeEntry(ENTRY, { projects: PROJECTS, llmCall, tier: 'escalate' });
  assert.equal(captured.tier, 'escalate');
  assert.equal(r.source, 'llm');
  assert.equal(r.tier, 'escalate');
});

test('atomizeEntry: onFail=escalate retries at escalate tier, then heuristic with both fails', async () => {
  const tiers = [];
  const llmCall = async ({ tier }) => { tiers.push(tier); throw new Error(`${tier} down`); };
  // explicit tier:'reason' — the default is now 'escalate' (T30), so to exercise
  // the lower-tier→escalate retry path we start from reason on purpose.
  const r = await atomizeEntry(ENTRY, { projects: PROJECTS, llmCall, tier: 'reason', onFail: 'escalate' });
  assert.deepEqual(tiers, ['reason', 'escalate']);
  assert.equal(r.source, 'heuristic');
  assert.match(r.fail, /reason: reason down/);
  assert.match(r.fail, /escalate: escalate down/);

  // Escalate attempt succeeding short-circuits the heuristic.
  const llmCall2 = async ({ tier }) => tier === 'escalate' ? JSON.stringify(GOOD) : '';
  const r2 = await atomizeEntry(ENTRY, { projects: PROJECTS, llmCall: llmCall2, onFail: 'escalate' });
  assert.equal(r2.source, 'llm');
  assert.equal(r2.tier, 'escalate');
});

test('atomizeEntry: onFail=error returns no draft, visible fail, empty clusters', async () => {
  const r = await atomizeEntry(ENTRY, { projects: PROJECTS, llmCall: async () => '', onFail: 'error' });
  assert.equal(r.source, 'none');
  assert.deepEqual(r.clusters, []);
  assert.match(r.fail, /empty reply/);
});

// ---- T20 step 3: cdsapi retries once on an empty-bodied success --------

test('callCdsApi (via makeLLMCall): empty reply → one retry; second reply wins', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    const body = calls === 1 ? '' : JSON.stringify({ response: 'second time lucky' });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const llmCall = makeLLMCall({ LLM_PROVIDER: 'cdsapi' });
    const reply = await llmCall({ prompt: 'hi', tier: 'reason', json: false });
    assert.equal(reply, 'second time lucky');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('callCdsApi: still empty after the retry → empty string (caller handles)', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('', { status: 200 }); };
  try {
    const llmCall = makeLLMCall({ LLM_PROVIDER: 'cdsapi' });
    const reply = await llmCall({ prompt: 'hi', json: false });
    assert.equal(String(reply).trim(), '');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});
