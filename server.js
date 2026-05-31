#!/usr/bin/env node
// ------------------------------------------------------------------
// Throughline — Node HTTP server. The orange-device backend.
//
// Serves the same public/ SPA as the Cloudflare Worker and exposes the same
// API (GET/PUT /api/state, POST /api/atomize), so the front-end is byte-for-
// byte identical against either backend. State lives in one JSON file
// (THROUGHLINE_DB) — set that to a OneDrive shared-folder path on orange.
//
// Boots at 127.0.0.1:8787 by default (override via PORT). Node 20+.
// Run with `node --env-file=.env server.js` (or `npm start`).
// ------------------------------------------------------------------

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readState, writeState, dbPath } from './lib/store.js';
import { atomizeEntry } from './shared/atomize.js';
import { classifyProject } from './shared/classify.js';
import { makeLLMCall } from './shared/llm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  const isBuf = typeof body === 'string' || Buffer.isBuffer(body);
  const payload = isBuf ? body : JSON.stringify(body);
  const ct = headers['content-type'] || (isBuf ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8');
  res.writeHead(status, { ...headers, 'content-type': ct });
  res.end(payload);
}

function sendJson(res, status, obj) {
  send(res, status, obj, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function serveStatic(req, res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  if (p.includes('..')) return send(res, 400, 'bad path');
  try {
    const data = await readFile(join(PUBLIC_DIR, p));
    return send(res, 200, data, { 'content-type': MIME[extname(p)] || 'application/octet-stream' });
  } catch {
    return send(res, 404, 'not found');
  }
}

const llmCall = makeLLMCall(process.env);

async function handleState(req, res) {
  if (req.method === 'GET') {
    return sendJson(res, 200, await readState());
  }
  if (req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
    if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'body must be an object' });
    await writeState(body);
    return sendJson(res, 200, { ok: true, saved_at: new Date().toISOString() });
  }
  return sendJson(res, 405, { error: `${req.method} not allowed` });
}

async function handleAtomize(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const entry = body?.entry || {};
  const projects = Array.isArray(body?.projects) ? body.projects : [];
  try {
    const result = await atomizeEntry(entry, { projects, llmCall });
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}

async function handleClassify(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const input = {
    description: typeof body?.description === 'string' ? body.description : '',
    excerpt: typeof body?.excerpt === 'string' ? body.excerpt : '',
    answers: body?.answers && typeof body.answers === 'object' ? body.answers : {},
  };
  try {
    const result = await classifyProject(input, { llmCall });
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}

// Attachments live in an `attachments/<container_id>/` tree beside the state
// JSON (so on orange they sit in the same OneDrive folder, legible to anyone).
// The server only handles file BYTES; the client owns state and records the
// attachment in container.attachments[] itself (avoids state races).
const ATTACH_DIR = join(dirname(dbPath()), 'attachments');
const safeName = (s) => basename(String(s || 'file')).replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'file';
const MAX_ATTACH_BYTES = 15 * 1024 * 1024;

async function handleAttachmentUpload(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const cid = safeName(body?.container_id);
  const filename = safeName(body?.filename);
  const b64 = String(body?.data || '').replace(/^data:[^;]*;base64,/, '');
  if (!body?.container_id || !filename || !b64) return sendJson(res, 400, { error: 'container_id, filename, data required' });
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > MAX_ATTACH_BYTES) return sendJson(res, 413, { error: 'file too large (max 15MB)' });
  try {
    const dir = join(ATTACH_DIR, cid);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, filename), buf);
    return sendJson(res, 200, {
      id: filename,
      filename,
      mime: typeof body.mime === 'string' ? body.mime : 'application/octet-stream',
      added_at: new Date().toISOString(),
      url: `/api/attachments/${encodeURIComponent(cid)}/${encodeURIComponent(filename)}`,
    });
  } catch (err) {
    return sendJson(res, 500, { error: err.message });
  }
}

async function serveAttachment(req, res, pathname) {
  const parts = pathname.split('/').slice(3).map(decodeURIComponent); // after /api/attachments/
  const cid = safeName(parts[0]); const name = safeName(parts[1]);
  if (!cid || !name) return sendJson(res, 404, { error: 'not found' });
  try {
    const buf = await readFile(join(ATTACH_DIR, cid, name));
    const mime = MIME[extname(name).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime, 'content-disposition': `inline; filename="${name}"` });
    return res.end(buf);
  } catch {
    return sendJson(res, 404, { error: 'not found' });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/state') return await handleState(req, res);
    if (url.pathname === '/api/atomize') return await handleAtomize(req, res);
    if (url.pathname === '/api/classify') return await handleClassify(req, res);
    if (url.pathname === '/api/attachments') return await handleAttachmentUpload(req, res);
    if (url.pathname.startsWith('/api/attachments/')) return await serveAttachment(req, res, url.pathname);
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Throughline server → http://${HOST}:${PORT}`);
  console.log(`  DB:       ${dbPath()}`);
  console.log(`  Provider: ${process.env.LLM_PROVIDER || 'heuristic'}`);
});
