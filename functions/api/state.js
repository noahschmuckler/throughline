// Cloudflare Pages Function — GET/PUT the single Throughline state blob.
// The whole document lives at KV key "throughline:state". Last-write-wins;
// v1 has two trusted users so we don't need version vectors yet.

const KV_KEY = 'throughline:state';

const EMPTY_STATE = {
  schema_version: 1,
  containers: [],
  entries: [],
  atoms: [],
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

export async function onRequestGet({ env }) {
  const raw = await env.THROUGHLINE.get(KV_KEY);
  if (!raw) return json(EMPTY_STATE);
  try {
    return json(JSON.parse(raw));
  } catch {
    // KV value got corrupted; fall back to empty so the UI stays usable.
    return json(EMPTY_STATE);
  }
}

export async function onRequestPut({ request, env }) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return json({ error: 'body must be an object' }, { status: 400 });
  }
  const next = {
    schema_version: 1,
    containers: Array.isArray(body.containers) ? body.containers : [],
    entries: Array.isArray(body.entries) ? body.entries : [],
    atoms: Array.isArray(body.atoms) ? body.atoms : [],
  };
  await env.THROUGHLINE.put(KV_KEY, JSON.stringify(next));
  return json({ ok: true, saved_at: new Date().toISOString() });
}

export async function onRequest({ request }) {
  return json({ error: `${request.method} not allowed` }, { status: 405 });
}
