// Microsoft Graph API client — ported from loop_de_loop/lib/graph-client.js
// for Throughline's "Loop" (Deloop) intake. The ONLY change from the source is
// the token-cache location: it lives in Throughline's machine-local data dir
// (NEVER the OneDrive-synced state.json area), so one operator's Microsoft
// credentials never sync to the other operator's box.
//
// Auth: MSAL PublicClientApplication device-code flow. Reuses the pre-approved
// "Microsoft Graph Command Line Tools" public client app — the same app the
// user authenticated against from PowerShell. No new app registration needed.
//
// First sign-in triggers an interactive device-code flow (a URL + code the user
// enters in a browser); subsequent calls use silent refresh via the cached
// refresh token. The Throughline front-end drives this through the auth wizard.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicClientApplication } from '@azure/msal-node';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Env-overridable (defaults are Noah's org's, same as loop_de_loop).
export const GRAPH_APP_ID = process.env.THROUGHLINE_GRAPH_APP_ID || '14d82eec-204b-4c2f-b7e8-296a70dab67e';
export const GRAPH_TENANT_ID = process.env.THROUGHLINE_GRAPH_TENANT_ID || 'db05faca-c82a-4b9d-b9c5-0f64b6755421';
export const GRAPH_AUTHORITY = `https://login.microsoftonline.com/${GRAPH_TENANT_ID}`;
export const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

// Machine-local token cache — beside the jobs store, NOT in OneDrive. Override
// with THROUGHLINE_GRAPH_CACHE; default ./data/graph_state/token_cache.json.
export const TOKEN_CACHE_PATH = process.env.THROUGHLINE_GRAPH_CACHE
  || join(REPO_ROOT, 'data', 'graph_state', 'token_cache.json');

export const DEFAULT_SCOPES = ['Files.Read.All'];

function createCachePlugin(cachePath) {
  return {
    async beforeCacheAccess(context) {
      try {
        const data = await readFile(cachePath, 'utf8');
        context.tokenCache.deserialize(data);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    },
    async afterCacheAccess(context) {
      if (context.cacheHasChanged) {
        await mkdir(dirname(cachePath), { recursive: true });
        await writeFile(cachePath, context.tokenCache.serialize(), { encoding: 'utf8', mode: 0o600 });
      }
    },
  };
}

let _pca = null;

async function getPca() {
  if (_pca) return _pca;
  await mkdir(dirname(TOKEN_CACHE_PATH), { recursive: true });
  _pca = new PublicClientApplication({
    auth: { clientId: GRAPH_APP_ID, authority: GRAPH_AUTHORITY },
    cache: { cachePlugin: createCachePlugin(TOKEN_CACHE_PATH) },
  });
  return _pca;
}

/** Acquire an access token. Silent refresh first; else device-code flow. */
export async function acquireToken({ scopes = DEFAULT_SCOPES, deviceCodeCallback } = {}) {
  const silent = await acquireTokenSilentOrNull({ scopes });
  if (silent) return silent;
  const callback = deviceCodeCallback || ((response) => { process.stdout.write('\n' + response.message + '\n\n'); });
  const pca = await getPca();
  const result = await pca.acquireTokenByDeviceCode({ scopes, deviceCodeCallback: callback });
  if (!result?.accessToken) throw new Error('Device-code flow returned no access token');
  return result.accessToken;
}

/** Silent token acquisition; returns the token or null. Never triggers device-code. */
export async function acquireTokenSilentOrNull({ scopes = DEFAULT_SCOPES } = {}) {
  const pca = await getPca();
  const cache = pca.getTokenCache();
  const accounts = await cache.getAllAccounts();
  if (accounts.length === 0) return null;
  try {
    const result = await pca.acquireTokenSilent({ account: accounts[0], scopes });
    return result?.accessToken || null;
  } catch (_silentErr) {
    return null;
  }
}

/** { connected, account, last_signin } — used by the wizard's first-run check. */
export async function getAuthStatus({ scopes = DEFAULT_SCOPES } = {}) {
  const pca = await getPca();
  const cache = pca.getTokenCache();
  const accounts = await cache.getAllAccounts();
  if (accounts.length === 0) return { connected: false, account: null, last_signin: null };
  const account = accounts[0];
  try {
    const result = await pca.acquireTokenSilent({ account, scopes });
    if (!result?.accessToken) return { connected: false, account: accountSummary(account), last_signin: null };
    return {
      connected: true,
      account: accountSummary(account),
      last_signin: result.idTokenClaims?.iat ? new Date(result.idTokenClaims.iat * 1000).toISOString() : null,
    };
  } catch (_e) {
    return { connected: false, account: accountSummary(account), last_signin: null };
  }
}

function accountSummary(a) {
  if (!a) return null;
  return { username: a.username || null, name: a.name || null, home_account_id: a.homeAccountId || null };
}

/** Sign out: clear the local token cache. Does NOT revoke server-side tokens. */
export async function signOut() {
  const pca = await getPca();
  const cache = pca.getTokenCache();
  const accounts = await cache.getAllAccounts();
  for (const account of accounts) {
    try { await cache.removeAccount(account); } catch (_e) { /* ignore */ }
  }
}

/**
 * Begin a device-code sign-in. Resolves as soon as MSAL has the user code,
 * without waiting for completion. Returns { userCode, verificationUri, message,
 * expiresAt, completion } where completion is a Promise<accessToken> that
 * resolves on sign-in / rejects on error (incl. approval-required failures).
 */
export async function initiateDeviceCode({ scopes = DEFAULT_SCOPES } = {}) {
  const silent = await acquireTokenSilentOrNull({ scopes });
  if (silent) {
    return { userCode: null, verificationUri: null, message: 'Already signed in', expiresAt: null, completion: Promise.resolve(silent) };
  }
  const pca = await getPca();

  let resolveCode, rejectCode;
  const codeReady = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });

  const completion = pca.acquireTokenByDeviceCode({
    scopes,
    deviceCodeCallback: (response) => { resolveCode(response); },
  }).then((result) => {
    if (!result?.accessToken) throw new Error('Device-code flow returned no access token');
    return result.accessToken;
  });
  completion.catch((err) => { rejectCode(err); });

  const codeResp = await codeReady;
  return {
    userCode: codeResp.userCode || null,
    verificationUri: codeResp.verificationUri || null,
    message: codeResp.message || null,
    expiresAt: codeResp.expiresAt ? new Date(codeResp.expiresAt * 1000).toISOString() : null,
    completion,
  };
}

function buildUri(pathOrUrl) {
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) return pathOrUrl;
  return GRAPH_API_BASE + (pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl);
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Stringify a fetch failure with the underlying cause (Node hides it on err.cause).
function describeFetchError(err, uri) {
  const cause = err?.cause;
  const causeCode = cause?.code || cause?.errno || cause?.name || null;
  const causeMsg = cause?.message ? `: ${cause.message}` : '';
  const where = uri ? ` while fetching ${uri}` : '';
  const base = err?.message || String(err);
  if (causeCode) return `${base} (${causeCode}${causeMsg})${where}`;
  if (causeMsg) return `${base}${causeMsg}${where}`;
  return `${base}${where}`;
}

function isTransientFetchError(err) {
  const code = err?.cause?.code || err?.cause?.errno || err?.code;
  if (!code) return false;
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(code);
}

/**
 * Low-level fetch with manual redirect handling so the Authorization header is
 * not forwarded on cross-origin redirects (graph → 1drv.com preauth URLs from
 * ?format=html). Handles 429/Retry-After, retries transient network errors with
 * backoff, follows up to 5 redirects.
 */
async function graphRequest(uri, token, { binary = false } = {}) {
  const MAX_NETWORK_RETRIES = 3;
  let currentUri = uri;

  for (let retry = 0; retry < 3; retry++) {
    let redirectsRemaining = 5;
    let mustRetry = false;

    while (redirectsRemaining-- > 0) {
      const isGraphOrigin = /^https:\/\/graph\.microsoft\.com\//i.test(currentUri);
      const headers = isGraphOrigin ? { Authorization: `Bearer ${token}` } : {};

      let resp = null;
      let lastFetchErr = null;
      for (let netAttempt = 0; netAttempt < MAX_NETWORK_RETRIES; netAttempt++) {
        try {
          resp = await fetch(currentUri, { headers, redirect: 'manual' });
          lastFetchErr = null;
          break;
        } catch (err) {
          lastFetchErr = err;
          if (!isTransientFetchError(err) || netAttempt === MAX_NETWORK_RETRIES - 1) break;
          await sleep(500 * Math.pow(3, netAttempt));
        }
      }
      if (!resp) throw new Error(describeFetchError(lastFetchErr, currentUri));

      if (resp.status >= 300 && resp.status < 400) {
        const next = resp.headers.get('location');
        if (!next) throw new Error(`Redirect with no Location header (${resp.status}) at ${currentUri}`);
        currentUri = next;
        continue;
      }

      if (resp.status === 429) {
        const wait = parseInt(resp.headers.get('retry-after') || '5', 10);
        await sleep(Math.max(1, wait) * 1000);
        mustRetry = true;
        break;
      }

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Graph request failed: ${resp.status} ${resp.statusText} — ${currentUri}\n${text.slice(0, 500)}`);
      }

      if (binary) return Buffer.from(await resp.arrayBuffer());
      const text = await resp.text();
      if (!text) return null;
      return JSON.parse(text);
    }

    if (!mustRetry) throw new Error(`Too many redirects starting at ${uri}`);
  }
  throw new Error(`Graph request exhausted retries: ${uri}`);
}

/** GET against Graph; returns parsed JSON. `path` can be a `/me/...` path or a full URL. */
export function graphGet(path, token) { return graphRequest(buildUri(path), token); }

/** GET against Graph; returns a Buffer. Use for `/content` and `?format=html` calls. */
export function graphGetBinary(path, token) { return graphRequest(buildUri(path), token, { binary: true }); }
