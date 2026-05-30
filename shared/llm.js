// ------------------------------------------------------------------
// Throughline — LLM provider seam (runtime-agnostic ESM).
//
// The single place that knows about a model provider. Mirrors the intent of
// atom_sandbox/lib/llm.js but trimmed to what Throughline needs today and kept
// free of `node:*` imports so the Cloudflare Worker can bundle it. Uses only
// the global `fetch` (available in Workers and Node 20+).
//
// `makeLLMCall(env)` returns either:
//   - null  → caller should use the heuristic stub (provider === 'heuristic',
//             the default), OR
//   - an async `llmCall({ prompt, tier })` → resolves to the model's raw text.
//
// Env is passed in (not read from a global) so the same code serves the
// Worker's `env` binding and the Node `process.env`.
// ------------------------------------------------------------------

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

// Tier → model. Overridable via env so the orange box / a provider rev needs
// no code change. Defaults track the current Claude family.
const TIER_MODEL = {
  classify: 'claude-haiku-4-5-20251001',
  reason:   'claude-sonnet-4-6',
  escalate: 'claude-opus-4-8',
};

export function makeLLMCall(env = {}) {
  const provider = String(env.LLM_PROVIDER || 'heuristic').toLowerCase();

  // Default + explicit "heuristic": no model. The atomizer falls back to its
  // deterministic stub. This is the v1 shipping configuration.
  if (provider === 'heuristic') return null;

  if (provider === 'anthropic') {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      // Misconfigured — degrade to heuristic rather than 500 every request.
      console.warn('[llm] LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is unset; using heuristic.');
      return null;
    }
    return async function llmCall({ prompt, tier = 'reason' }) {
      const model = env[`TIER_${tier.toUpperCase()}_MODEL`] || TIER_MODEL[tier] || TIER_MODEL.reason;
      const res = await fetch(ANTHROPIC_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
      const data = await res.json();
      // Concatenate text blocks.
      return (data.content || []).map(b => b.text || '').join('');
    };
  }

  // TODO(AI): additional providers (e.g. Optum cdsapi, or a Node-only file-based
  // dryrun for the Copilot-paste workflow) slot in here. Node-only providers
  // should be wired in server.js behind a dynamic import so this module stays
  // Worker-safe.
  console.warn(`[llm] unknown LLM_PROVIDER="${provider}"; using heuristic.`);
  return null;
}
