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
import { listFolder, openFile } from './lib/files.js';
import { setupStatus, listSetupFolder, bindFolder, dbInfo } from './lib/setup.js';
import { atomizeEntry } from './shared/atomize.js';
import { classifyProject } from './shared/classify.js';
import { consultTurn } from './shared/consult.js';
import { makeLLMCall, describeLLM } from './shared/llm.js';

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
    // llm = the model the provider WOULD use (null = heuristic-only config);
    // result.source says whether it actually produced this draft (T8);
    // result.fail says WHY the model path degraded, when it did (T20).
    if (result.fail) console.warn(`[atomize] model path degraded to heuristic: ${result.fail}`);
    return sendJson(res, 200, { ...result, llm: describeLLM(process.env, 'reason') });
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

// Native consult chat (T13): bundle + message history → one stateless
// gpt-5.4 (tier `escalate`) turn. NO fallback — errors surface to the chat UI.
async function handleConsult(req, res) {
  // GET = engine info only (T25): lets the chat header name the model before
  // the first reply. Provider-agnostic — whatever the escalate tier maps to.
  if (req.method === 'GET') return sendJson(res, 200, { llm: describeLLM(process.env, 'escalate') });
  if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const bundle = body?.bundle && typeof body.bundle === 'object' ? body.bundle : {};
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  try {
    const { reply } = await consultTurn(bundle, messages, { llmCall });
    return sendJson(res, 200, { reply, llm: describeLLM(process.env, 'escalate') });
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

// Folder-lens (Epic E1) — LOCAL ONLY. The Worker 501s these (no filesystem in
// the cloud). Every path is root-relative and validated inside ONEDRIVE_ROOT by
// lib/files.js before any disk access; an escape attempt → 400, missing → 404.
async function handleFsList(req, res, url) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: `${req.method} not allowed` });
  const rel = url.searchParams.get('path') || '';
  try {
    return sendJson(res, 200, await listFolder(rel));
  } catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'folder not found' });
    if (/escapes ONEDRIVE_ROOT|absolute path not allowed|must be a string/.test(err.message)) {
      return sendJson(res, 400, { error: err.message });
    }
    if (err.code === 'ENOTDIR') return sendJson(res, 400, { error: 'not a folder' });
    return sendJson(res, 500, { error: err.message });
  }
}

// Open a bound-tree file in its native app. Validates within ONEDRIVE_ROOT
// before spawning the opener; never writes/deletes. Worker → 501.
async function handleFsOpen(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const rel = typeof body?.path === 'string' ? body.path : '';
  if (!rel) return sendJson(res, 400, { error: 'path required' });
  try {
    return sendJson(res, 200, await openFile(rel));
  } catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'file not found' });
    if (/escapes ONEDRIVE_ROOT|absolute path not allowed|must be a string|not a file/.test(err.message)) {
      return sendJson(res, 400, { error: err.message });
    }
    return sendJson(res, 500, { error: err.message });
  }
}

// First-run onboarding (Epic E1.5) — LOCAL ONLY, like the lens. The wizard
// browses from the user's HOME (not the not-yet-set ONEDRIVE_ROOT) so they can
// find + pick the shared OneDrive folder; /api/setup/bind writes .env and
// restarts the server task. The Worker has no filesystem and never serves these.
async function handleSetupStatus(req, res) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: `${req.method} not allowed` });
  return sendJson(res, 200, await setupStatus());
}

async function handleSetupBrowse(req, res, url) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: `${req.method} not allowed` });
  const rel = url.searchParams.get('path') || '';
  try {
    return sendJson(res, 200, await listSetupFolder(rel));
  } catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'folder not found' });
    if (/escapes home|absolute path not allowed|must be a string/.test(err.message)) {
      return sendJson(res, 400, { error: err.message });
    }
    if (err.code === 'ENOTDIR') return sendJson(res, 400, { error: 'not a folder' });
    return sendJson(res, 500, { error: err.message });
  }
}

// Candidate workspace-DB locations for a chosen lens root (Throughline subfolder
// vs root), with existing-workspace detection so the wizard can default + reuse.
async function handleSetupDbInfo(req, res, url) {
  if (req.method !== 'GET') return sendJson(res, 405, { error: `${req.method} not allowed` });
  const folder = url.searchParams.get('folder') || '';
  try {
    return sendJson(res, 200, await dbInfo(folder));
  } catch (err) {
    if (/inside your user profile|absolute path/.test(err.message)) return sendJson(res, 400, { error: err.message });
    return sendJson(res, 500, { error: err.message });
  }
}

async function handleSetupBind(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: `${req.method} not allowed` });
  let body;
  try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
  const folderAbsPath = typeof body?.folderAbsPath === 'string' ? body.folderAbsPath : '';
  const dbAbsPath = typeof body?.dbAbsPath === 'string' ? body.dbAbsPath : '';
  let result;
  try {
    result = await bindFolder(folderAbsPath, dbAbsPath);
  } catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'folder not found' });
    return sendJson(res, 400, { error: err.message });
  }
  // bindFolder applied the binding to process.env live (no task restart needed),
  // so the server is configured the moment this returns.
  return sendJson(res, 200, { ok: true, configured: true, ...result });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/state') return await handleState(req, res);
    if (url.pathname === '/api/atomize') return await handleAtomize(req, res);
    if (url.pathname === '/api/classify') return await handleClassify(req, res);
    if (url.pathname === '/api/consult') return await handleConsult(req, res);
    if (url.pathname === '/api/attachments') return await handleAttachmentUpload(req, res);
    if (url.pathname.startsWith('/api/attachments/')) return await serveAttachment(req, res, url.pathname);
    if (url.pathname === '/api/fs/list') return await handleFsList(req, res, url);
    if (url.pathname === '/api/fs/open') return await handleFsOpen(req, res);
    if (url.pathname === '/api/setup/status') return await handleSetupStatus(req, res);
    if (url.pathname === '/api/setup/browse') return await handleSetupBrowse(req, res, url);
    if (url.pathname === '/api/setup/dbinfo') return await handleSetupDbInfo(req, res, url);
    if (url.pathname === '/api/setup/bind') return await handleSetupBind(req, res);
    return await serveStatic(req, res, url.pathname);
  } catch (err) {
    console.error(err);
    return sendJson(res, 500, { error: err.message });
  }
});

// gpt-5.4 consult turns can outlast Node's 5-minute default requestTimeout
// (gpt-mini alone took ~90 s on an 8 KB dump — T12); don't kill them mid-call.
server.requestTimeout = 0;

server.listen(PORT, HOST, () => {
  console.log(`Throughline server → http://${HOST}:${PORT}`);
  console.log(`  DB:       ${dbPath()}`);
  console.log(`  Provider: ${process.env.LLM_PROVIDER || 'heuristic'}`);
});
