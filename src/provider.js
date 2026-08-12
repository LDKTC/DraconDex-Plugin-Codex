'use strict';
// The connection layer: one interface, two ways of authenticating.
//
// This talks to OpenAI's Responses API over raw HTTP rather than through the
// official SDK, because a plugin page has no bundler and no node_modules —
// there is nowhere for a dependency to come from. Everything below follows the
// documented wire format for POST /v1/responses.
//
//   mode 'api'    Authorization: Bearer sk-…      → https://api.openai.com/v1
//   mode 'oauth'  Authorization: Bearer <token>   → https://chatgpt.com/backend-api/codex
//
// BE HONEST ABOUT THE SECOND MODE. OpenAI publishes no supported API for
// driving a ChatGPT subscription from a third-party app, and this does not
// invent one. What it implements is standard OAuth 2.0 + PKCE against endpoints
// and a client_id the user supplies, plus a place to paste a token obtained
// elsewhere. The API-key mode is the supported one and works out of the box.
//
// See README.md §Connection for the two limits that shape this file: the host
// only allows requests to origins this plugin's manifest declared, and its
// OAuth redirect lands on a RANDOM loopback port.

// Must stay in sync with permissions.net in dracondex-plugin.json — the host
// rejects anything else, and failing here gives a far better message than the
// generic "origin not allowed by this plugin's manifest".
const ALLOWED_ORIGINS = ['https://api.openai.com', 'https://auth.openai.com', 'https://chatgpt.com'];

const API_BASE_DEFAULT = 'https://api.openai.com/v1';
// What the Codex CLI talks to when signed in with a ChatGPT account. Undocumented.
const OAUTH_BASE_DEFAULT = 'https://chatgpt.com/backend-api/codex';
const OAUTH_AUTHORIZE_DEFAULT = 'https://auth.openai.com/oauth/authorize';
const OAUTH_TOKEN_DEFAULT = 'https://auth.openai.com/oauth/token';

// Refresh this far ahead of expiry so a long streaming response doesn't have
// the token die out from under it mid-flight.
const REFRESH_SKEW_MS = 120000;

// Suggestions only — NOT a closed list. Codex model ids turn over quickly and
// which ones an account can reach differs between API keys and ChatGPT
// sign-in, so the setting is a free-text field with these as autocomplete and
// a "Fetch models" button that replaces them with what the account really has.
const MODEL_SUGGESTIONS = [
  'gpt-5.2-codex',
  'gpt-5.3-codex',
  'gpt-5-codex',
  'gpt-5.5',
  'gpt-5.2',
];
const DEFAULT_MODEL = 'gpt-5.2-codex';
const DEFAULT_MAX_OUTPUT_TOKENS = 16000;
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'];

// ---------------------------------------------------------------------------
// Transport. The host's pluginApi.net.* runs the request in the main process,
// which is the only way to read a cross-origin response — the manifest's
// permissions.net allowlist is what makes that legal. Falling back to the
// page's own fetch() keeps this plugin working as a plain window on a host
// that predates the panel API, where the request is subject to CORS.
// ---------------------------------------------------------------------------
const hostNet = () => (window.pluginApi || window.extApi || {}).net || null;
const hasHostNet = () => !!hostNet();

async function httpFetch(url, init) {
  const net = hostNet();
  if (net) return net.fetch(url, init);
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    return { ok: false, code: 'network', error: String(e?.message || e) };
  }
  return { ok: true, status: res.status, statusText: res.statusText, body: await res.text() };
}

function originOf(url) {
  try { return new URL(String(url)).origin; } catch (_) { return null; }
}

// Checked before every request so a mistyped base URL reports itself here
// rather than as an opaque rejection from the main process.
function checkOrigin(url, what) {
  const origin = originOf(url);
  if (!origin) return `${what} is not a valid URL: ${url}`;
  if (!ALLOWED_ORIGINS.includes(origin)) {
    return `${what} points at ${origin}, which this plugin's manifest does not allow. Allowed: ${ALLOWED_ORIGINS.join(', ')}.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
async function readSettings() {
  const [mode, apiKey, baseUrl, model, maxTokens, effort, reasoningSummary, systemPrompt,
    clientId, authorizeUrl, tokenUrl, scope, accessToken, refreshToken, expiresAt, accountId] = await Promise.all([
    Store.getConfig('mode', 'api'),
    Store.getConfig('api_key', ''),
    Store.getConfig('base_url', ''),
    Store.getConfig('model', DEFAULT_MODEL),
    Store.getConfig('max_output_tokens', String(DEFAULT_MAX_OUTPUT_TOKENS)),
    Store.getConfig('effort', ''),
    Store.getConfig('reasoning_summary', '0'),
    Store.getConfig('system_prompt', ''),
    Store.getConfig('oauth_client_id', ''),
    Store.getConfig('oauth_authorize_url', ''),
    Store.getConfig('oauth_token_url', ''),
    Store.getConfig('oauth_scope', ''),
    Store.getConfig('oauth_access_token', ''),
    Store.getConfig('oauth_refresh_token', ''),
    Store.getConfig('oauth_expires_at', ''),
    Store.getConfig('oauth_account_id', ''),
  ]);
  const resolvedMode = mode === 'oauth' ? 'oauth' : 'api';
  return {
    mode: resolvedMode,
    apiKey: apiKey || '',
    // Empty means "whatever this mode's default is", so switching modes moves
    // the endpoint with it instead of stranding an api.openai.com URL in OAuth
    // mode. A value the user typed always wins.
    baseUrl: (baseUrl || '').replace(/\/+$/, '') || defaultBaseUrl(resolvedMode),
    baseUrlOverridden: !!baseUrl,
    model: (model || '').trim() || DEFAULT_MODEL,
    maxOutputTokens: Number(maxTokens) > 0 ? Number(maxTokens) : DEFAULT_MAX_OUTPUT_TOKENS,
    effort: EFFORTS.includes(effort) ? effort : '',
    reasoningSummary: reasoningSummary === '1',
    systemPrompt: systemPrompt || '',
    oauth: {
      clientId: clientId || '',
      authorizeUrl: authorizeUrl || OAUTH_AUTHORIZE_DEFAULT,
      tokenUrl: tokenUrl || OAUTH_TOKEN_DEFAULT,
      scope: scope || '', accessToken: accessToken || '', refreshToken: refreshToken || '',
      expiresAt: Number(expiresAt) || 0, accountId: accountId || '',
    },
  };
}

function defaultBaseUrl(mode) {
  return mode === 'oauth' ? OAUTH_BASE_DEFAULT : API_BASE_DEFAULT;
}

function connectionState(s) {
  if (s.mode === 'api') return s.apiKey ? { ok: true } : { ok: false, reason: 'no_api_key' };
  // Either half of OAuth mode is enough to have a usable token: the PKCE
  // sign-in below, or a token pasted in from an external `codex login`.
  return s.oauth.accessToken ? { ok: true } : { ok: false, reason: 'oauth_signed_out' };
}

// --- OAuth 2.0 + PKCE ------------------------------------------------------
// The host owns the redirect capture: a plugin page cannot listen on a port,
// so pluginApi.oauth.authorize opens the system browser and hands back the
// code plus the PKCE verifier it generated. The token exchange stays here, so
// a client secret (if the provider needs one) never leaves this page.
//
// The host's loopback receiver binds a RANDOM port (src/db/oauth-loopback.js:
// `srv.listen(0)`), so the redirect_uri is http://127.0.0.1:<random>/callback.
// A provider that demands one exact pre-registered redirect — OpenAI's stock
// Codex client wants http://localhost:1455/auth/callback — will refuse it.
// That is why Local CLI (paste a token) exists next to this.
async function oauthSignIn() {
  const s = await readSettings();
  const o = s.oauth;
  if (!o.clientId) throw new Error('Fill in a client ID first.');
  const bad = checkOrigin(o.authorizeUrl, 'Authorize URL') || checkOrigin(o.tokenUrl, 'Token URL');
  if (bad) throw new Error(bad);
  const oauth = (window.pluginApi || window.extApi || {}).oauth;
  if (!oauth) throw new Error('This DraconDex version cannot capture the OAuth redirect. Update the app, use Local CLI instead, or use API key mode.');

  const { code, redirectUri, verifier } = await oauth.authorize({
    authorizeUrl: o.authorizeUrl, clientId: o.clientId, scope: o.scope || undefined,
  });

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code, redirect_uri: redirectUri, client_id: o.clientId, code_verifier: verifier,
  });
  const res = await httpFetch(o.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return storeToken(res, 'sign-in');
}

async function oauthRefresh(o) {
  if (!o.refreshToken) throw new Error('Signed out — sign in again, or paste a fresh token.');
  const bad = checkOrigin(o.tokenUrl, 'Token URL');
  if (bad) throw new Error(bad);
  const body = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: o.clientId,
  });
  const res = await httpFetch(o.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return storeToken(res, 'refresh');
}

async function storeToken(res, what) {
  if (!res.ok) throw new Error(`Token ${what} failed: ${res.error || 'network error'}`);
  if (res.status < 200 || res.status >= 300) throw new Error(`Token ${what} failed (HTTP ${res.status}): ${res.body || ''}`);
  let json;
  try { json = JSON.parse(res.body); } catch (_) { throw new Error(`Token ${what} returned a non-JSON body.`); }
  if (!json.access_token) throw new Error(`Token ${what} returned no access_token.`);
  const expiresAt = json.expires_in ? Date.now() + Number(json.expires_in) * 1000 : 0;
  await Store.setConfig('oauth_access_token', json.access_token);
  // Providers that rotate refresh tokens send a new one on every exchange;
  // ones that don't omit it, and the existing token must be kept.
  if (json.refresh_token) await Store.setConfig('oauth_refresh_token', json.refresh_token);
  await Store.setConfig('oauth_expires_at', String(expiresAt));
  return { ok: true };
}

async function oauthSignOut() {
  await Store.setConfig('oauth_access_token', '');
  await Store.setConfig('oauth_refresh_token', '');
  await Store.setConfig('oauth_expires_at', '');
}

// Returns the headers for one request, refreshing an about-to-expire token
// first so the refresh never lands mid-stream.
async function authHeaders(s) {
  if (s.mode === 'api') return { authorization: `Bearer ${s.apiKey}` };
  let o = s.oauth;
  if (o.expiresAt && Date.now() > o.expiresAt - REFRESH_SKEW_MS && o.refreshToken) {
    await oauthRefresh(o);
    o = (await readSettings()).oauth;
  }
  const headers = { authorization: `Bearer ${o.accessToken}` };
  // The ChatGPT backend routes by account; a token that belongs to more than
  // one workspace needs to say which. Omitted when the user left it blank.
  if (o.accountId) headers['chatgpt-account-id'] = o.accountId;
  return headers;
}

// ---------------------------------------------------------------------------
// Responses API
// ---------------------------------------------------------------------------
function buildRequestBody(s, messages) {
  const body = {
    model: s.model,
    input: messages,
    max_output_tokens: s.maxOutputTokens,
    stream: true,
    // Nothing here needs server-side conversation state — the transcript is
    // replayed from this plugin's own table on every turn — so don't ask
    // OpenAI to retain the response.
    store: false,
  };
  if (s.systemPrompt) body.instructions = s.systemPrompt;
  // Only sent when the user actually asked for it: a non-reasoning model
  // rejects a `reasoning` block outright, and the default summary is off, so
  // an empty one would buy a 400 for nothing.
  if (s.effort || s.reasoningSummary) {
    body.reasoning = {};
    if (s.effort) body.reasoning.effort = s.effort;
    if (s.reasoningSummary) body.reasoning.summary = 'auto';
  }
  // Deliberately absent: temperature/top_p (rejected by the reasoning models
  // this plugin targets) and previous_response_id (see `store` above).
  return body;
}

// One SSE `data:` payload. Returns what the caller should do with it.
function applyStreamEvent(evt, acc) {
  switch (evt.type) {
    case 'response.output_text.delta':
      return { text: evt.delta };
    case 'response.reasoning_summary_text.delta':
      return { reasoning: evt.delta };
    case 'response.refusal.delta':
      acc.refusal += evt.delta || '';
      return null;
    case 'response.completed':
      readUsage(evt, acc);
      return null;
    // A response that ran out of room still carries everything it produced —
    // record why it stopped so the caller can say so instead of pretending the
    // half-finished answer was the whole one.
    case 'response.incomplete':
      readUsage(evt, acc);
      acc.incomplete = evt.response?.incomplete_details?.reason || 'incomplete';
      return null;
    case 'response.failed':
      readUsage(evt, acc);
      acc.error = evt.response?.error?.message || 'the response failed';
      return null;
    case 'error':
      acc.error = evt.message || evt.error?.message || 'stream error';
      return null;
    default:
      return null;
  }
}

function readUsage(evt, acc) {
  const usage = evt.response?.usage;
  if (!usage) return;
  if (usage.input_tokens != null) acc.inTokens = usage.input_tokens;
  if (usage.output_tokens != null) acc.outTokens = usage.output_tokens;
}

// Feeds raw SSE bytes in and calls back with deltas. Chunks arrive on
// arbitrary boundaries, so a partial line is held over to the next chunk.
// Only `data:` lines are read — the Responses stream also sends `event:` lines,
// but every payload names its own `type`, so they carry nothing extra.
function makeSseParser(onEvent) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();          // last element is the incomplete tail
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try { onEvent(JSON.parse(payload)); } catch (_) { /* a non-JSON keepalive */ }
    }
  };
}

// Streams one assistant turn. `onDelta` is called with { text } / { reasoning }
// as they arrive; resolves with the finished turn. Never throws for an API
// error — those come back on the result so the caller can persist them next to
// the message they belong to.
async function sendMessage({ settings, messages, onDelta, onAbortReady }) {
  const s = settings;
  const gate = connectionState(s);
  if (!gate.ok) return { ok: false, error: describeGate(gate.reason) };

  const url = `${s.baseUrl}/responses`;
  const badOrigin = checkOrigin(url, 'The endpoint');
  if (badOrigin) return { ok: false, error: badOrigin };

  let headers;
  try {
    headers = { ...(await authHeaders(s)), 'content-type': 'application/json' };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }

  const init = { method: 'POST', headers, body: JSON.stringify(buildRequestBody(s, messages)) };
  const acc = { refusal: '', incomplete: null, inTokens: null, outTokens: null, error: null };
  let text = '';
  let reasoning = '';

  const feed = makeSseParser((evt) => {
    const delta = applyStreamEvent(evt, acc);
    if (!delta) return;
    if (delta.text != null) { text += delta.text; onDelta?.({ text: delta.text, full: text }); }
    if (delta.reasoning != null) { reasoning += delta.reasoning; onDelta?.({ reasoning: delta.reasoning }); }
  });

  const net = hostNet();
  const end = net
    ? await streamViaHost(net, url, init, feed, onAbortReady)
    : await streamViaFetch(url, init, feed, onAbortReady);

  if (!end.ok) return { ok: false, error: end.error, text, reasoning };
  if (acc.error) return { ok: false, error: acc.error, text, reasoning };
  // A refusal arrives as a successful stream whose content is the refusal —
  // check it before treating the accumulated text as a real answer.
  if (acc.refusal) return { ok: false, refusal: true, error: acc.refusal, text, reasoning };
  if (acc.incomplete) {
    const why = acc.incomplete === 'max_output_tokens'
      ? 'Cut off — the reply hit the max output tokens limit. Raise it in Settings.'
      : `Cut off (${acc.incomplete}).`;
    return { ok: false, error: why, text, reasoning };
  }
  return { ok: true, text, reasoning, inTokens: acc.inTokens, outTokens: acc.outTokens };
}

function streamViaHost(net, url, init, feed, onAbortReady) {
  return new Promise((resolve) => {
    net.stream(url, init, {
      onChunk: feed,
      onEnd: (res) => resolve(res.ok ? { ok: true } : { ok: false, ...toEndError(res) }),
    })
      .then((abort) => onAbortReady?.(abort))
      .catch((e) => resolve({ ok: false, error: String(e?.message || e) }));
  });
}

function toEndError(res) {
  if (res.code === 'aborted') return { error: 'Stopped.' };
  if (res.code === 'http') return { error: describeHttp(res.status, res.error) };
  return { error: res.error || 'Request failed.' };
}

// Fallback for a host without pluginApi.net — subject to CORS.
async function streamViaFetch(url, init, feed, onAbortReady) {
  const ctrl = new AbortController();
  onAbortReady?.(() => ctrl.abort());
  let res;
  try {
    res = await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    return { ok: false, error: ctrl.signal.aborted ? 'Stopped.' : String(e?.message || e) };
  }
  if (!res.ok) return { ok: false, error: describeHttp(res.status, await res.text()) };
  const reader = res.body?.getReader();
  if (!reader) return { ok: false, error: 'No response body.' };
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      feed(decoder.decode(value, { stream: true }));
    }
  } catch (e) {
    return { ok: false, error: ctrl.signal.aborted ? 'Stopped.' : String(e?.message || e) };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Model list. The suggestions above go stale as OpenAI ships; this replaces
// them with what the credentials in use can actually reach, so a wrong guess
// is one button away from being corrected rather than a dead end.
// ---------------------------------------------------------------------------
async function fetchModels(s) {
  const url = `${s.baseUrl}/models`;
  const badOrigin = checkOrigin(url, 'The endpoint');
  if (badOrigin) throw new Error(badOrigin);
  const res = await httpFetch(url, { method: 'GET', headers: await authHeaders(s) });
  if (!res.ok) throw new Error(res.error || 'network error');
  if (res.status < 200 || res.status >= 300) throw new Error(describeHttp(res.status, res.body));
  let json;
  try { json = JSON.parse(res.body); } catch (_) { throw new Error('The model list was not JSON.'); }
  const ids = (json?.data || []).map((m) => m?.id).filter((id) => typeof id === 'string');
  if (!ids.length) throw new Error('The endpoint returned no models.');
  return ids.sort();
}

// The API's own message is the useful part; the status code alone tells the
// user nothing they can act on.
function describeHttp(status, body) {
  let detail = '';
  try { detail = JSON.parse(body)?.error?.message || ''; } catch (_) { detail = String(body || '').slice(0, 300); }
  if (status === 401) return `Not authorized (401). ${detail || 'Check your API key, or sign in / paste a token again.'}`;
  if (status === 403) return `Forbidden (403). ${detail || 'These credentials cannot reach this endpoint.'}`;
  if (status === 404) return `Not found (404). ${detail || 'Check the model id and the base URL in Settings.'}`;
  if (status === 429) return `Rate limited (429). ${detail || 'Wait a moment and retry.'}`;
  if (status >= 500) return `OpenAI API error (${status}). ${detail || 'Retry shortly.'}`;
  return `HTTP ${status}. ${detail}`;
}

function describeGate(reason) {
  if (reason === 'no_api_key') return 'No API key set — open Settings and paste one.';
  if (reason === 'oauth_signed_out') return 'Signed out — sign in from Settings, or paste an access token there.';
  return 'Not connected.';
}

window.Provider = {
  MODEL_SUGGESTIONS, DEFAULT_MODEL, DEFAULT_MAX_OUTPUT_TOKENS, EFFORTS,
  API_BASE_DEFAULT, OAUTH_BASE_DEFAULT, OAUTH_AUTHORIZE_DEFAULT, OAUTH_TOKEN_DEFAULT,
  ALLOWED_ORIGINS, defaultBaseUrl,
  readSettings, connectionState, describeGate,
  oauthSignIn, oauthRefresh, oauthSignOut,
  sendMessage, fetchModels, hasHostNet,
};
