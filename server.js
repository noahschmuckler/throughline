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
import { readFile } from 'node:fs/promises';
import { dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readState, writeState, dbPath } from './lib/store.js';
import { atomizeEntry } from './shared/atomize.js';
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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/state') return await handleState(req, res);
    if (url.pathname === '/api/atomize') return await handleAtomize(req, res);
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
