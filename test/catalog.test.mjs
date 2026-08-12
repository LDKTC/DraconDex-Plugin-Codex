// Drives src/catalog.js in Node against a fake pluginApi.net / Store / fetch —
// same shim style as provider.test.mjs. catalog.js is deliberately independent
// of provider.js (its net origin isn't in Provider.ALLOWED_ORIGINS), so it
// gets its own harness here rather than reusing that file's.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';

const ROOT = new URL('..', import.meta.url).pathname;

const SAMPLE_CATALOG = {
  catalogVersion: '1.0.0',
  app: { name: 'DraconDex', description: 'a novel and world-building data manager' },
  features: [{ id: 'nexus', name: 'Nexus' }, { id: 'scribe', name: 'Scribe' }],
  pluginCapabilities: { summary: 'Plugins are sandboxed.' },
};

let config;
let scriptedNetFetch;
let scriptedPageFetch;
let netCalls;
let pageFetchCalls;

function reset() {
  config = new Map();
  scriptedNetFetch = { ok: true, status: 200, body: JSON.stringify(SAMPLE_CATALOG) };
  scriptedPageFetch = null;
  netCalls = [];
  pageFetchCalls = [];
}

// catalog.js is a classic browser script: bare `window`/`Store`/`fetch`
// identifiers resolve to whatever `new Function` is handed, exactly like the
// real page provides them — no bundler, no module wrapper.
function loadCatalog({ withHostNet = true } = {}) {
  const win = {};
  win.window = win;
  win.Store = {
    getConfig: async (k, fallback = null) => (config.has(k) ? config.get(k) : fallback),
    setConfig: async (k, v) => { config.set(k, v == null ? null : String(v)); },
  };
  if (withHostNet) {
    win.pluginApi = {
      net: {
        fetch: async (url, init) => { netCalls.push({ url, init }); return scriptedNetFetch; },
      },
    };
  }
  const pageFetch = async (url) => {
    pageFetchCalls.push(url);
    if (!scriptedPageFetch) throw new Error('no scripted page fetch — this test should have gone through pluginApi.net');
    return scriptedPageFetch;
  };
  const src = readFileSync(`${ROOT}src/catalog.js`, 'utf8');
  new Function('window', 'Store', 'fetch', src)(win, win.Store, pageFetch);
  return win.Catalog;
}

test('preamble/composeSystemPrompt are empty before any fetch has ever succeeded', () => {
  reset();
  const C = loadCatalog();
  assert.equal(C.preamble(), '');
  assert.equal(C.composeSystemPrompt(''), '');
  assert.equal(C.composeSystemPrompt('Be terse.'), 'Be terse.', 'the user\'s own prompt is untouched when there is no catalog');
});

test('ensure() fetches through pluginApi.net and caches into the config table', async () => {
  reset();
  const C = loadCatalog();
  await C.ensure();

  assert.equal(netCalls.length, 1);
  assert.equal(netCalls[0].url, 'https://raw.githubusercontent.com/LDKTC/DraconDex-Plugin-Native/main/catalog.json');
  assert.equal(pageFetchCalls.length, 0, 'never falls back to the page fetch when pluginApi.net exists');

  assert.equal(config.get('app_catalog_json'), JSON.stringify(SAMPLE_CATALOG));
  assert.ok(config.get('app_catalog_fetched_at'), 'records when it was fetched');

  const p = C.preamble();
  assert.match(p, /DraconDex/);
  assert.match(p, /Nexus/);
  assert.match(p, /Scribe/);
  assert.match(p, /sandboxed/i);
});

test('composeSystemPrompt puts the catalog preamble first and keeps the user\'s prompt intact after it', async () => {
  reset();
  const C = loadCatalog();
  await C.ensure();
  const composed = C.composeSystemPrompt('Answer in Thai.');
  assert.ok(composed.startsWith(C.preamble()));
  assert.ok(composed.endsWith('Answer in Thai.'));
});

test('ensure() falls back to the page fetch when there is no pluginApi.net', async () => {
  reset();
  scriptedPageFetch = { ok: true, text: async () => JSON.stringify(SAMPLE_CATALOG) };
  const C = loadCatalog({ withHostNet: false });
  await C.ensure();
  assert.equal(pageFetchCalls.length, 1);
  assert.match(C.preamble(), /DraconDex/);
});

test('a network failure leaves the catalog empty rather than throwing', async () => {
  reset();
  const C = loadCatalog();
  scriptedNetFetch = { ok: false, status: 0, error: 'network' };
  await C.ensure();
  assert.equal(C.preamble(), '', 'no crash, no stale cache to fall back to on a first-ever fetch');
  assert.equal(config.has('app_catalog_json'), false);
});

test('malformed JSON from the catalog URL is treated as no catalog, not a crash', async () => {
  reset();
  scriptedNetFetch = { ok: true, status: 200, body: 'not json' };
  const C = loadCatalog();
  await C.ensure();
  assert.equal(C.preamble(), '');
});

test('a second boot reuses the config-table copy immediately, then refreshes it', async () => {
  reset();
  config.set('app_catalog_json', JSON.stringify(SAMPLE_CATALOG));
  // This "boot" runs offline — the refresh fails, but the stored copy from a
  // previous session is still what preamble() reports.
  scriptedNetFetch = { ok: false, status: 0, error: 'offline' };
  const C = loadCatalog();
  await C.ensure();
  assert.match(C.preamble(), /DraconDex/, 'the last-known-good copy is used even though this fetch failed');
});
