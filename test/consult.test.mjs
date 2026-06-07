// Tests for the consult seam (shared/consult.js) — T13 native chat engine.
// Run: node --test test/   (or: node --test test/consult.test.mjs)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONSULT_FRAMING, buildConsultPrompt, consultTurn } from '../shared/consult.js';

const BUNDLE = {
  _artifact: 'throughline.chat_about_this',
  _instructions: 'help the user process the dump',
  session_id: 'ing_2026-06-06_1400',
  raw_dump: 'Kickoff notes: Alice to send the roster by Friday.',
  proposed: { atoms: [{ id: 'a1', type: 'action', body: 'Send the roster' }] },
};

const MESSAGES = [
  { role: 'user', content: 'Does this breakdown look right?' },
  { role: 'assistant', content: 'Mostly — a1 should capture the due date.' },
  { role: 'user', content: 'OK, give me the decision set.' },
];

// ---- buildConsultPrompt ---------------------------------------------

test('buildConsultPrompt: embeds framing, bundle JSON, and history in order', () => {
  const p = buildConsultPrompt(BUNDLE, MESSAGES);
  assert.ok(p.startsWith(CONSULT_FRAMING));
  assert.ok(p.includes('"_artifact": "throughline.chat_about_this"'));
  assert.ok(p.includes('=== BUNDLE ===') && p.includes('=== END BUNDLE ==='));
  const iQ = p.indexOf('User: Does this breakdown look right?');
  const iA = p.indexOf('Assistant: Mostly — a1 should capture the due date.');
  const iLast = p.indexOf('User: OK, give me the decision set.');
  assert.ok(iQ !== -1 && iA !== -1 && iLast !== -1);
  assert.ok(iQ < iA && iA < iLast, 'turns render in order');
  // The latest user turn is the last turn rendered (nothing after but the cue).
  assert.ok(iLast > p.lastIndexOf('Assistant:'));
});

test('buildConsultPrompt: tolerates empty/missing history and skips malformed turns', () => {
  const empty = buildConsultPrompt(BUNDLE, []);
  assert.ok(empty.includes('(no turns yet)'));
  assert.ok(buildConsultPrompt(BUNDLE).includes('(no turns yet)'));

  const p = buildConsultPrompt(BUNDLE, [
    null,
    { role: 'user' },                       // no content
    { role: 'user', content: '   ' },       // blank
    { role: 'wat', content: 'hello' },      // bad role → coerced to User
    { role: 'assistant', content: 'hi' },
  ]);
  assert.ok(p.includes('User: hello'));
  assert.ok(p.includes('Assistant: hi'));
  assert.ok(!p.includes('undefined'));
});

// ---- consultTurn -----------------------------------------------------

test('consultTurn: passes tier escalate + json:false, returns trimmed reply', async () => {
  let captured = null;
  const llmCall = async (args) => { captured = args; return '  Here is my advice.  '; };
  const r = await consultTurn(BUNDLE, MESSAGES, { llmCall });
  assert.equal(r.reply, 'Here is my advice.');
  assert.equal(captured.tier, 'escalate');
  assert.equal(captured.json, false);
  assert.ok(captured.prompt.includes('=== BUNDLE ==='));
});

test('consultTurn: no llmCall → rejects visibly (no heuristic fallback)', async () => {
  await assert.rejects(() => consultTurn(BUNDLE, MESSAGES, {}), /No LLM configured/);
  await assert.rejects(() => consultTurn(BUNDLE, MESSAGES), /No LLM configured/);
});

test('consultTurn: provider errors propagate, not swallowed', async () => {
  const llmCall = async () => { throw new Error('HTTP 500: upstream sad'); };
  await assert.rejects(() => consultTurn(BUNDLE, MESSAGES, { llmCall }), /upstream sad/);
});

test('consultTurn: empty/blank reply → rejects with a visible message', async () => {
  await assert.rejects(() => consultTurn(BUNDLE, MESSAGES, { llmCall: async () => '' }), /empty reply/);
  await assert.rejects(() => consultTurn(BUNDLE, MESSAGES, { llmCall: async () => '   ' }), /empty reply/);
  await assert.rejects(() => consultTurn(BUNDLE, MESSAGES, { llmCall: async () => null }), /empty reply/);
});
