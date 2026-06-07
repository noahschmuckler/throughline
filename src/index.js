// Throughline Worker — the Cloudflare backend. Handles /api/state and
// /api/atomize and falls through to the static assets binding for everything
// else (the SPA in public/).
//
// The whole document lives at KV key "throughline:state". Last-write-wins; v1
// has two trusted users so we don't need version vectors yet. The Node server
// (server.js) exposes the same API over a JSON file for orange-device use.

import { atomizeEntry } from '../shared/atomize.js';
import { classifyProject } from '../shared/classify.js';
import { consultTurn } from '../shared/consult.js';
import { makeLLMCall, describeLLM } from '../shared/llm.js';

const KV_KEY = 'throughline:state';

const EMPTY_STATE = {
  schema_version: 3,
  containers: [],
  entries: [],
  atoms: [],
  people_meta: {},
};

function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(init.headers || {}),
    },
  });
}

// Tolerate v1/v2 docs (no people_meta / v2/v3 container fields) and preserve any
// unknown keys rather than dropping them. Container inner-fields (incl. the v3
// program_id/framework/rag) pass through the array untouched; the front-end
// defaults any missing ones on read.
function normalize(body) {
  const o = body && typeof body === 'object' ? body : {};
  return {
    ...o,
    schema_version: 3,
    containers: Array.isArray(o.containers) ? o.containers : [],
    entries: Array.isArray(o.entries) ? o.entries : [],
    atoms: Array.isArray(o.atoms) ? o.atoms : [],
    people_meta: o.people_meta && typeof o.people_meta === 'object' ? o.people_meta : {},
  };
}

async function handleStateRequest(request, env) {
  if (request.method === 'GET') {
    const raw = await env.THROUGHLINE.get(KV_KEY);
    if (!raw) return json(EMPTY_STATE);
    try {
      return json(normalize(JSON.parse(raw)));
    } catch {
      return json(EMPTY_STATE);
    }
  }

  if (request.method === 'PUT') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'invalid JSON' }, { status: 400 });
    }
    if (!body || typeof body !== 'object') {
      return json({ error: 'body must be an object' }, { status: 400 });
    }
    const next = normalize(body);
    await env.THROUGHLINE.put(KV_KEY, JSON.stringify(next));
    return json({ ok: true, saved_at: new Date().toISOString() });
  }

  return json({ error: `${request.method} not allowed` }, { status: 405 });
}

async function handleAtomizeRequest(request, env) {
  if (request.method !== 'POST') {
    return json({ error: `${request.method} not allowed` }, { status: 405 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, { status: 400 });
  }
  const entry = body?.entry || {};
  const projects = Array.isArray(body?.projects) ? body.projects : [];
  try {
    const llmCall = makeLLMCall(env);
    const result = await atomizeEntry(entry, { projects, llmCall });
    // llm = the model the provider WOULD use (null = heuristic-only config);
    // result.source says whether it actually produced this draft (T8);
    // result.fail says WHY the model path degraded, when it did (T20).
    if (result.fail) console.warn(`[atomize] model path degraded to heuristic: ${result.fail}`);
    return json({ ...result, llm: describeLLM(env, 'reason') });
  } catch (err) {
    return json({ error: err.message }, { status: 500 });
  }
}

async function handleClassifyRequest(request, env) {
  if (request.method !== 'POST') {
    return json({ error: `${request.method} not allowed` }, { status: 405 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, { status: 400 });
  }
  const input = {
    description: typeof body?.description === 'string' ? body.description : '',
    excerpt: typeof body?.excerpt === 'string' ? body.excerpt : '',
    answers: body?.answers && typeof body.answers === 'object' ? body.answers : {},
  };
  try {
    const llmCall = makeLLMCall(env);
    const result = await classifyProject(input, { llmCall });
    return json(result);
  } catch (err) {
    return json({ error: err.message }, { status: 500 });
  }
}

// Native consult chat (T13): bundle + message history → one stateless
// tier-`escalate` turn. NO fallback — errors surface to the chat UI.
async function handleConsultRequest(request, env) {
  // GET = engine info only (T25): lets the chat header name the model before
  // the first reply. Provider-agnostic — whatever the escalate tier maps to.
  if (request.method === 'GET') {
    return json({ llm: describeLLM(env, 'escalate') });
  }
  if (request.method !== 'POST') {
    return json({ error: `${request.method} not allowed` }, { status: 405 });
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, { status: 400 });
  }
  const bundle = body?.bundle && typeof body.bundle === 'object' ? body.bundle : {};
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  try {
    const llmCall = makeLLMCall(env);
    const { reply } = await consultTurn(bundle, messages, { llmCall });
    return json({ reply, llm: describeLLM(env, 'escalate') });
  } catch (err) {
    return json({ error: err.message }, { status: 500 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/state') {
      return handleStateRequest(request, env);
    }
    if (url.pathname === '/api/atomize') {
      return handleAtomizeRequest(request, env);
    }
    if (url.pathname === '/api/classify') {
      return handleClassifyRequest(request, env);
    }
    if (url.pathname === '/api/consult') {
      return handleConsultRequest(request, env);
    }
    // Attachments are a local (Node/orange) capability — the cloud demo has no
    // file store. Keep the route present (identical contract) but say so clearly
    // so the front-end can degrade gracefully.
    if (url.pathname === '/api/attachments' || url.pathname.startsWith('/api/attachments/')) {
      return json({ error: 'Attachments are only available on the local (Node) backend, not the cloud demo.' }, { status: 501 });
    }
    // Folder-lens (Epic E1) — the cloud demo has no local filesystem to read or
    // open. Keep the routes present (identical contract) but 501 clearly so the
    // front-end can degrade gracefully. Same pattern as attachments.
    if (url.pathname === '/api/fs/list' || url.pathname.startsWith('/api/fs/')) {
      return json({ error: 'Folder access is only available on the local (Node) backend, not the cloud demo.' }, { status: 501 });
    }
    // Everything else: static assets from /public.
    return env.ASSETS.fetch(request);
  },
};
