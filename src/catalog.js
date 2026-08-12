'use strict';
// Fetches and caches AI Native's public app/plugin catalog, so this chat has
// some baseline knowledge of what DraconDex is and what a plugin can do —
// without needing AI Native's own window or table, which this plugin's
// sandbox can never reach directly (a plugin cannot read another plugin's
// data, installed alongside it or not — see
// https://github.com/LDKTC/App-DraconDex/blob/main/docs/PLUGINS.md). Declaring
// AI Native under manifest `dependencies` gets it installed in the app the
// first time this plugin is; the catalog content itself still only ever
// travels as the public file this plugin fetches for itself, over the
// `https://raw.githubusercontent.com` origin declared in permissions.net.
//
// Deliberately best-effort everywhere: a machine with no internet, or an
// older DraconDex with no pluginApi.net, still gets a fully working chat —
// just without the app-context preamble.

const CATALOG_URL = 'https://raw.githubusercontent.com/LDKTC/DraconDex-Plugin-Native/main/catalog.json';

const hostNet = () => (window.pluginApi || window.extApi || {}).net || null;

let cached = null; // parsed catalog, once a fetch has succeeded this session

async function fetchCatalog() {
  try {
    const net = hostNet();
    let ok, body;
    if (net) {
      const res = await net.fetch(CATALOG_URL, { method: 'GET' });
      ok = res.ok && res.status >= 200 && res.status < 300;
      body = res.body;
    } else {
      // Falls back to the page's own fetch on a host predating pluginApi.net
      // (or running this plugin as a bare page) — raw.githubusercontent.com
      // sends permissive CORS headers, so this still works, just outside the
      // net.* size/timeout guarantees.
      const res = await fetch(CATALOG_URL);
      ok = res.ok;
      body = await res.text();
    }
    if (!ok || !body) return null;
    return JSON.parse(body);
  } catch (_) {
    return null; // offline, blocked, or a malformed catalog — chat works fine without it
  }
}

// Called once at boot, deliberately NOT awaited by the caller: a slow or dead
// GitHub fetch must never delay the chat becoming usable. Reads the
// last-known-good copy out of this plugin's own config table first (so a
// fresh boot has *something* the moment the user sends before the network
// round-trip finishes), then refreshes it from the network in the background.
async function ensure() {
  const stored = await Store.getConfig('app_catalog_json', '');
  if (stored) {
    try { cached = JSON.parse(stored); } catch (_) { /* fall through to a fresh fetch */ }
  }
  const fresh = await fetchCatalog();
  if (fresh) {
    cached = fresh;
    await Store.setConfig('app_catalog_json', JSON.stringify(fresh));
    await Store.setConfig('app_catalog_fetched_at', new Date().toISOString());
  }
}

// A short, model-facing summary of what DraconDex is and what a plugin can
// do — cheap in tokens on purpose, since it rides along on every turn.
// Returns '' when no catalog has ever been fetched successfully.
function preamble() {
  const c = cached;
  if (!c) return '';
  const lines = [];
  const appName = c.app?.name || 'DraconDex';
  const appDesc = c.app?.description || c.app?.tagline || '';
  lines.push(`You are running as a plugin inside ${appName}${appDesc ? `, ${appDesc}` : ''}.`);
  const features = Array.isArray(c.features) ? c.features.map((f) => f?.name).filter(Boolean) : [];
  if (features.length) lines.push(`Its features include: ${features.join(', ')}.`);
  if (c.pluginCapabilities?.summary) lines.push(c.pluginCapabilities.summary);
  lines.push('As a plugin, you can only store data in your own table(s) and reach network hosts your own manifest declares — you have no access to the app\'s own data or to any other plugin\'s data.');
  return lines.join(' ');
}

// Prefixes the catalog preamble onto whatever system prompt the user
// configured in Settings, so the model gets app context even if they never
// wrote one. The user's own words always come last and are never altered.
function composeSystemPrompt(userPrompt) {
  const p = preamble();
  const u = String(userPrompt || '').trim();
  if (!p) return u;
  return u ? `${p}\n\n${u}` : p;
}

window.Catalog = { ensure, preamble, composeSystemPrompt };
