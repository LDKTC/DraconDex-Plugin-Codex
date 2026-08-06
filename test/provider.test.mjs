// Drives src/provider.js in Node against canned SSE, exercising the parser,
// the Responses-API event mapping and the result shape. Stubs only what a
// plugin page would really have: window, Store, and pluginApi.net.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const ROOT = new URL('..', import.meta.url).pathname;

// --- fake host -------------------------------------------------------------
const config = new Map();
let lastRequest = null;
let scriptedChunks = [];
let scriptedEnd = { ok: true };

function makeWindow() {
  const win = {};
  win.window = win;
  win.Store = {
    getConfig: async (k, fallback = null) => (config.has(k) ? config.get(k) : fallback),
    setConfig: async (k, v) => { config.set(k, v == null ? null : String(v)); },
  };
  win.pluginApi = {
    net: {
      fetch: async (url, init) => { lastRequest = { url, init }; return { ok: true, status: 200, body: '{}' }; },
      stream: async (url, init, { onChunk, onEnd }) => {
        lastRequest = { url, init };
        // Deliver asynchronously, like the real IPC path does.
        setImmediate(() => {
          for (const c of scriptedChunks) onChunk(c);
          onEnd(scriptedEnd);
        });
        return () => {};
      },
    },
  };
  return win;
}

// provider.js is a classic browser script: it reads bare `window` / `Store` and
// assigns window.Provider. Running it with those as function parameters is the
// whole shim — no bundler, no module wrapper, same file the app downloads.
function loadProvider(customise) {
  const win = makeWindow();
  customise?.(win);
  const src = readFileSync(`${ROOT}src/provider.js`, 'utf8');
  new Function('window', 'Store', 'fetch', src)(win, win.Store, () => {
    throw new Error('the host net path should have been used');
  });
  return win.Provider;
}

// Turns a list of Responses events into the SSE bytes a server would send,
// split on an awkward boundary so the parser's partial-line handling is used.
function sse(events) {
  const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const cut = Math.floor(text.length / 3);
  return [text.slice(0, cut), text.slice(cut, cut * 2), text.slice(cut * 2)];
}

function reset() {
  config.clear();
  lastRequest = null;
  scriptedChunks = [];
  scriptedEnd = { ok: true };
}

// --- tests -----------------------------------------------------------------
test('defaults: api mode, api base url, no key means not connected', async () => {
  reset();
  const P = loadProvider();
  const s = await P.readSettings();
  assert.equal(s.mode, 'api');
  assert.equal(s.baseUrl, 'https://api.openai.com/v1');
  assert.equal(s.model, P.DEFAULT_MODEL);
  assert.deepEqual(P.connectionState(s), { ok: false, reason: 'no_api_key' });
});

test('oauth mode defaults to the chatgpt backend and accepts a pasted token', async () => {
  reset();
  const P = loadProvider();
  config.set('mode', 'oauth');
  let s = await P.readSettings();
  assert.equal(s.baseUrl, 'https://chatgpt.com/backend-api/codex');
  assert.deepEqual(P.connectionState(s), { ok: false, reason: 'oauth_signed_out' });
  // A pasted access token alone is enough — no client id, no sign-in.
  config.set('oauth_access_token', 'tok_123');
  s = await P.readSettings();
  assert.deepEqual(P.connectionState(s), { ok: true });
});

test('streams text, reasoning and usage out of a Responses stream', async () => {
  reset();
  const P = loadProvider();
  config.set('api_key', 'sk-test');
  config.set('effort', 'high');
  config.set('reasoning_summary', '1');
  config.set('system_prompt', 'be brief');
  const s = await P.readSettings();

  scriptedChunks = sse([
    { type: 'response.created', response: { id: 'resp_1' } },
    { type: 'response.reasoning_summary_text.delta', delta: 'weigh' },
    { type: 'response.reasoning_summary_text.delta', delta: ' options' },
    { type: 'response.output_text.delta', delta: 'Hello' },
    { type: 'response.output_text.delta', delta: ', world' },
    { type: 'response.completed', response: { usage: { input_tokens: 11, output_tokens: 4 } } },
  ]);

  const seen = { text: '', reasoning: '' };
  const out = await P.sendMessage({
    settings: s,
    messages: [{ role: 'user', content: 'hi' }],
    onDelta: (d) => { if (d.text) seen.text += d.text; if (d.reasoning) seen.reasoning += d.reasoning; },
  });

  assert.equal(out.ok, true);
  assert.equal(out.text, 'Hello, world');
  assert.equal(out.reasoning, 'weigh options');
  assert.equal(out.inTokens, 11);
  assert.equal(out.outTokens, 4);
  assert.equal(seen.text, 'Hello, world', 'onDelta saw every text delta');
  assert.equal(seen.reasoning, 'weigh options');

  // Request shape
  assert.equal(lastRequest.url, 'https://api.openai.com/v1/responses');
  assert.equal(lastRequest.init.headers.authorization, 'Bearer sk-test');
  const body = JSON.parse(lastRequest.init.body);
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.instructions, 'be brief');
  assert.equal(body.max_output_tokens, 16000);
  assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' });
  assert.deepEqual(body.input, [{ role: 'user', content: 'hi' }]);
  assert.equal('temperature' in body, false);
});

test('omits the reasoning block when neither effort nor summary is set', async () => {
  reset();
  const P = loadProvider();
  config.set('api_key', 'sk-test');
  const s = await P.readSettings();
  scriptedChunks = sse([{ type: 'response.completed', response: { usage: {} } }]);
  await P.sendMessage({ settings: s, messages: [] });
  const body = JSON.parse(lastRequest.init.body);
  assert.equal('reasoning' in body, false);
  assert.equal('instructions' in body, false);
});

test('a refusal is reported as a failure, not as an answer', async () => {
  reset();
  const P = loadProvider();
  config.set('api_key', 'sk-test');
  const s = await P.readSettings();
  scriptedChunks = sse([
    { type: 'response.refusal.delta', delta: "I can't help with that." },
    { type: 'response.completed', response: { usage: {} } },
  ]);
  const out = await P.sendMessage({ settings: s, messages: [] });
  assert.equal(out.ok, false);
  assert.equal(out.refusal, true);
  assert.match(out.error, /can't help/);
});

test('a truncated response keeps its partial text and says why it stopped', async () => {
  reset();
  const P = loadProvider();
  config.set('api_key', 'sk-test');
  const s = await P.readSettings();
  scriptedChunks = sse([
    { type: 'response.output_text.delta', delta: 'partial…' },
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 5, output_tokens: 9 } } },
  ]);
  const out = await P.sendMessage({ settings: s, messages: [] });
  assert.equal(out.ok, false);
  assert.equal(out.text, 'partial…', 'partial text survives');
  assert.match(out.error, /max output tokens/i);
});

test('response.failed and a bare error event both surface the API message', async () => {
  reset();
  const P = loadProvider();
  config.set('api_key', 'sk-test');
  const s = await P.readSettings();

  scriptedChunks = sse([{ type: 'response.failed', response: { error: { message: 'model overloaded' } } }]);
  let out = await P.sendMessage({ settings: s, messages: [] });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'model overloaded');

  scriptedChunks = sse([{ type: 'error', message: 'stream blew up' }]);
  out = await P.sendMessage({ settings: s, messages: [] });
  assert.equal(out.error, 'stream blew up');
});

test('an HTTP error from the host stream is decoded into the API message', async () => {
  reset();
  const P = loadProvider();
  config.set('api_key', 'sk-bad');
  const s = await P.readSettings();
  scriptedChunks = [];
  scriptedEnd = { ok: false, code: 'http', status: 401, error: JSON.stringify({ error: { message: 'Incorrect API key provided.' } }) };
  const out = await P.sendMessage({ settings: s, messages: [] });
  assert.equal(out.ok, false);
  assert.match(out.error, /401/);
  assert.match(out.error, /Incorrect API key/);
});

test('abort is reported as Stopped, not as a crash', async () => {
  reset();
  const P = loadProvider();
  config.set('api_key', 'sk-test');
  const s = await P.readSettings();
  scriptedEnd = { ok: false, code: 'aborted' };
  const out = await P.sendMessage({ settings: s, messages: [] });
  assert.equal(out.error, 'Stopped.');
});

test('a base URL outside the manifest allowlist is refused before any request', async () => {
  reset();
  const P = loadProvider();
  config.set('api_key', 'sk-test');
  config.set('base_url', 'https://evil.example.com/v1');
  const s = await P.readSettings();
  const out = await P.sendMessage({ settings: s, messages: [] });
  assert.equal(out.ok, false);
  assert.match(out.error, /does not allow/);
  assert.equal(lastRequest, null, 'no request was attempted');
});

test('the oauth account id rides along only when set', async () => {
  reset();
  const P = loadProvider();
  config.set('mode', 'oauth');
  config.set('oauth_access_token', 'tok_123');
  let s = await P.readSettings();
  scriptedChunks = sse([{ type: 'response.completed', response: { usage: {} } }]);
  await P.sendMessage({ settings: s, messages: [] });
  assert.equal(lastRequest.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(lastRequest.init.headers.authorization, 'Bearer tok_123');
  assert.equal('chatgpt-account-id' in lastRequest.init.headers, false);

  config.set('oauth_account_id', 'acct_9');
  s = await P.readSettings();
  await P.sendMessage({ settings: s, messages: [] });
  assert.equal(lastRequest.init.headers['chatgpt-account-id'], 'acct_9');
});

test('fetchModels reads ids off the /models payload, sorted', async () => {
  reset();
  const ids = ['gpt-5.2-codex', 'gpt-4.1'];
  const P = loadProvider((win) => {
    win.pluginApi.net.fetch = async (url, init) => {
      lastRequest = { url, init };
      return { ok: true, status: 200, body: JSON.stringify({ data: ids.map((id) => ({ id })) }) };
    };
  });
  config.set('api_key', 'sk-test');
  const s = await P.readSettings();

  assert.deepEqual(await P.fetchModels(s), ['gpt-4.1', 'gpt-5.2-codex']);
  assert.equal(lastRequest.url, 'https://api.openai.com/v1/models');
  assert.equal(lastRequest.init.headers.authorization, 'Bearer sk-test');
});

test('fetchModels reports an HTTP failure instead of returning an empty list', async () => {
  reset();
  const P = loadProvider((win) => {
    win.pluginApi.net.fetch = async () => ({ ok: true, status: 401, body: JSON.stringify({ error: { message: 'bad key' } }) });
  });
  config.set('api_key', 'sk-bad');
  const s = await P.readSettings();
  await assert.rejects(() => P.fetchModels(s), /401/);
});
