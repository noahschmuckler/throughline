// ------------------------------------------------------------------
// Throughline — consult seam (runtime-agnostic ESM).
//
// The native chat engine behind /api/consult (T13): the user converses with
// a strong model (tier `escalate` → cdsapi gpt-5.4) about a "Chat about this"
// ingestion bundle, in-app, replacing the copy-paste Copilot loop as the
// primary path. Imported by BOTH backends, like shared/atomize.js.
//
// The provider is STATELESS (cdsapi single_response), so every round
// serializes the bundle + the full turn history into ONE prompt. Expected
// history is short (a few turns); the bundle's own embedded `_instructions`
// (assembleBundle, public/ingest.js) carries the consult brief — this module
// deliberately does NOT import public/ingest.js, keeping shared/ → public/
// one-directional.
//
// UNLIKE atomize/classify there is NO heuristic fallback: a chat has nothing
// meaningful to degrade to, and a silent fallback would reproduce exactly the
// "engine fails opaquely" problem this seam exists to fix (the Copilot hard
// refusal). consultTurn THROWS on no-model / empty reply / provider error,
// and the handler surfaces the message to the UI.
// ------------------------------------------------------------------

export const CONSULT_FRAMING = [
  'You are consulting on a draft ingestion for Throughline, a project-tracking tool.',
  'The bundle below (JSON) describes the user’s workspace and a draft breakdown of a',
  'raw note dump; follow its _instructions field — help the user process the dump,',
  'do NOT review or praise the JSON formatting.',
  'This is a multi-turn conversation: the full history so far follows the bundle.',
  'Reply in plain prose unless the latest user turn explicitly asks for JSON.',
].join('\n');

// ---- prompt assembly -------------------------------------------------

// Serialize bundle + history into the single stateless prompt sent each round.
// Tolerant by design: messages may be empty/malformed; roles coerce to
// user/assistant; blank turns are skipped. Latest user turn lands last.
export function buildConsultPrompt(bundle, messages = []) {
  const turns = (Array.isArray(messages) ? messages : [])
    .filter(m => m && typeof m.content === 'string' && m.content.trim())
    .map(m => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content.trim()}`);

  return [
    CONSULT_FRAMING,
    '',
    '=== BUNDLE ===',
    JSON.stringify(bundle ?? {}, null, 2),
    '=== END BUNDLE ===',
    '',
    '=== CONVERSATION ===',
    turns.length ? turns.join('\n\n') : '(no turns yet)',
    '',
    'Respond to the latest User turn.',
  ].join('\n');
}

// ---- the public entry point ------------------------------------------

// consultTurn(bundle, messages, { llmCall }) → { reply }
// `json: false` is load-bearing: the provider seam otherwise appends a
// "raw JSON only" nudge that would corrupt prose turns. The decision-set turn
// needs no special casing — DECISION_PROMPT's own text demands JSON and the
// gate's parseDecisionSet is tolerant of prose around it.
export async function consultTurn(bundle, messages, { llmCall = null } = {}) {
  if (!llmCall) {
    throw new Error('No LLM configured for consult — set LLM_PROVIDER (cdsapi on orange, anthropic on dev).');
  }
  const prompt = buildConsultPrompt(bundle, messages);
  const raw = await llmCall({ prompt, tier: 'escalate', json: false });
  const reply = String(raw ?? '').trim();
  if (!reply) throw new Error('The model returned an empty reply.');
  return { reply };
}
