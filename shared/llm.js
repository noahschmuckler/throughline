// ------------------------------------------------------------------
// Throughline — LLM provider seam (runtime-agnostic ESM).
//
// The single place that knows about a model provider. Mirrors the provider
// model of atom_sandbox/lib/llm.js (so the two stay translatable) but trimmed
// to what Throughline needs and kept free of `node:*` imports — only the global
// `fetch` — so the Cloudflare Worker can bundle it too.
//
// `makeLLMCall(env)` returns either:
//   - null  → caller uses the heuristic stub (provider 'heuristic', default), OR
//   - an async `llmCall({ prompt, tier, json })` resolving to the model's raw
//     text. `atomizeEntry` (shared/atomize.js) parses JSON out of that text.
//
// Providers (LLM_PROVIDER):
//   - heuristic — no model; deterministic stub. The default. Zero spend.
//   - anthropic — HTTPS POST to the Anthropic Messages API (cloud / dev).
//   - cdsapi    — HTTP POST to Optum's metered endpoint. THIS is the orange-
//                 device provider: the enterprise box can't reach Anthropic,
//                 but cdsapi is on-network and needs no key.
//
// Env is passed in (not read from a global) so the same code serves the
// Worker's `env` binding and the Node `process.env`.
// ------------------------------------------------------------------

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const CDSAPI_DEFAULT_URL = 'http://cdsapi.ms.ds.uhc.com:8080/single_response';

// Tier → model, per provider. Overridable via env (TIER_<TIER>_MODEL) so the
// orange box or a provider rev needs no code change. Tiers:
//   classify — cheap pre-filter · reason — main work · escalate — hard cases.
const TIER_MODEL = {
  anthropic: {
    classify: 'claude-haiku-4-5-20251001',
    reason:   'claude-sonnet-4-6',
    escalate: 'claude-opus-4-8',
  },
  cdsapi: {
    classify: 'gpt-nano',
    reason:   'gpt-mini',
    escalate: 'gpt-5.4',
  },
};

function tierModel(provider, tier, env) {
  return env[`TIER_${String(tier).toUpperCase()}_MODEL`]
    || TIER_MODEL[provider]?.[tier]
    || TIER_MODEL[provider]?.reason;
}

// Human-readable descriptor of the model makeLLMCall(env) would use for a
// tier — "cdsapi · gpt-mini" — or null when it would return null (heuristic).
// Surfaced by /api/atomize so the triage UI can say WHO produced the draft
// (T8: a silent heuristic degradation was indistinguishable from a model run).
export function describeLLM(env = {}, tier = 'reason') {
  const provider = String(env.LLM_PROVIDER || 'heuristic').toLowerCase();
  if (provider === 'anthropic' && env.ANTHROPIC_API_KEY) {
    return `anthropic · ${env.ANTHROPIC_MODEL || tierModel('anthropic', tier, env)}`;
  }
  if (provider === 'cdsapi') {
    return `cdsapi · ${env.LLM_MODEL || tierModel('cdsapi', tier, env)}`;
  }
  return null;
}

export function makeLLMCall(env = {}) {
  const provider = String(env.LLM_PROVIDER || 'heuristic').toLowerCase();

  // Default + explicit "heuristic": no model. The atomizer falls back to its
  // deterministic stub. This is the zero-config / zero-spend shipping default.
  if (provider === 'heuristic') return null;

  if (provider === 'anthropic') {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.warn('[llm] LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is unset; using heuristic.');
      return null;
    }
    return ({ prompt, tier = 'reason', json = true }) =>
      callAnthropic({ apiKey, model: env.ANTHROPIC_MODEL || tierModel('anthropic', tier, env), prompt, json });
  }

  if (provider === 'cdsapi') {
    // No key needed on-network. LLM_MODEL pins a single model across tiers if
    // the operator wants (matches atom_sandbox's CDSAPI_DEFAULT_MODEL behavior).
    const url = env.CDSAPI_URL || CDSAPI_DEFAULT_URL;
    return ({ prompt, tier = 'reason', json = true }) =>
      callCdsApi({ url, model: env.LLM_MODEL || tierModel('cdsapi', tier, env), prompt, json });
  }

  console.warn(`[llm] unknown LLM_PROVIDER="${provider}"; using heuristic.`);
  return null;
}

// ---- providers -----------------------------------------------------

// Retry 429/5xx with exponential backoff. Returns the ok Response, or throws.
async function fetchRetry(url, init, { retries = 2 } = {}) {
  let attempt = 0, lastErr;
  while (attempt <= retries) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      const body = await res.text();
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
        attempt++;
        await sleep(800 * 2 ** attempt);
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
    } catch (err) {
      lastErr = err;
      attempt++;
      if (attempt > retries) break;
      await sleep(800 * 2 ** attempt);
    }
  }
  throw lastErr;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const JSON_SYSTEM = 'You are a precise data-extraction service. Respond with raw JSON only — no prose, no markdown fences.';

async function callAnthropic({ apiKey, model, prompt, json = true }) {
  const res = await fetchRetry(ANTHROPIC_ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      // json:false (consult prose turns) must NOT force the JSON-only system
      // prompt — the cdsapi path makes the same json-gated distinction.
      ...(json ? { system: JSON_SYSTEM } : {}),
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await res.json();
  return (data.content || []).map(b => b.text || '').join('');
}

// Optum cdsapi — stateless, non-streaming. Reply text lives under one of a few
// keys; mirror atom_sandbox's tolerant extraction. Observed live failure mode
// (T20): the gateway sometimes returns an EMPTY-bodied success after ~60 s on
// big prompts — fetchRetry treats that as ok, so retry the call once here.
async function callCdsApi({ url, model, prompt, json }) {
  const user = json
    ? `${prompt}\n\nIMPORTANT: respond with raw JSON only — no prose, no markdown fences. Begin with { and end with }.`
    : prompt;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetchRetry(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system: '', user, model, verbose: false }),
    });
    const rawText = await res.text();
    const ctype = res.headers.get('content-type') || '';
    let reply = rawText;
    if (ctype.includes('application/json')) {
      try {
        const d = JSON.parse(rawText);
        reply = d.response ?? d.reply ?? d.text ?? d.content ?? d.output ?? d.answer ?? rawText;
      } catch { /* keep rawText */ }
    }
    if (String(reply ?? '').trim()) return reply;
    if (attempt === 0) console.warn('[llm] cdsapi returned an empty reply — retrying once');
  }
  return ''; // still empty after the retry: callers' empty-reply handling fires
}
