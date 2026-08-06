'use strict';
// Persistence. Everything this plugin remembers lives in the three tables it
// declared in dracondex-plugin.json, reached through window.pluginApi.table.*
// — there is no other storage available to a plugin, and none is wanted:
// running as a docked panel means the page is reloaded whenever the host
// re-renders its pane, so anything held only in a variable is gone. Every
// write here happens at the moment the state changes, not on some later flush.
//
// window.extApi is the pre-v4.2.0 alias for the same object; falling back to it
// keeps this page working on older builds of the app.
const api = window.pluginApi || window.extApi || null;

const T_SESSION = 'session';
const T_MESSAGE = 'message';
const T_CONFIG = 'config';

const nowIso = () => new Date().toISOString();

// --- config (key/value) ----------------------------------------------------
// Small enough that reading the whole table once and caching it beats a query
// per key: the settings form touches a dozen keys in a row on every render.
let configCache = null;

async function configAll() {
  if (configCache) return configCache;
  const rows = await api.table.query(T_CONFIG, {});
  configCache = new Map();
  // query() returns newest id first, so the first row seen for a key is the
  // most recently written one — earlier duplicates (if a race ever wrote two)
  // are ignored rather than overwriting it.
  for (const r of rows) if (!configCache.has(r.ckey)) configCache.set(r.ckey, { id: r.id, value: r.cvalue });
  return configCache;
}

async function getConfig(key, fallback = null) {
  const all = await configAll();
  const hit = all.get(key);
  return hit ? hit.value : fallback;
}

async function setConfig(key, value) {
  const all = await configAll();
  const hit = all.get(key);
  const stored = value == null ? null : String(value);
  if (hit) {
    await api.table.update(T_CONFIG, hit.id, { cvalue: stored });
    hit.value = stored;
  } else {
    const { id } = await api.table.insert(T_CONFIG, { ckey: key, cvalue: stored });
    all.set(key, { id, value: stored });
  }
}

// --- sessions --------------------------------------------------------------
async function listSessions() {
  const rows = await api.table.query(T_SESSION, {});
  return rows.sort((a, b) => String(b.update_at || '').localeCompare(String(a.update_at || '')));
}

async function createSession({ title, model, systemPrompt = null, moduleKey = null }) {
  const at = nowIso();
  const { id } = await api.table.insert(T_SESSION, {
    title, model, system_prompt: systemPrompt, module_key: moduleKey, create_at: at, update_at: at,
  });
  return { id, title, model, system_prompt: systemPrompt, module_key: moduleKey, create_at: at, update_at: at };
}

async function touchSession(id, patch = {}) {
  await api.table.update(T_SESSION, id, { ...patch, update_at: nowIso() });
}

// Deleting a session leaves its messages orphaned unless we sweep them: the
// plugin table API has no foreign keys and no cascade, so the cleanup is ours.
async function deleteSession(id) {
  const messages = await api.table.query(T_MESSAGE, { session_ref: id });
  for (const m of messages) await api.table.delete(T_MESSAGE, m.id);
  await api.table.delete(T_SESSION, id);
}

// --- messages --------------------------------------------------------------
// Oldest first: `filter` is exact-match only and results come back newest id
// first, so the ordering a transcript needs is done here.
async function listMessages(sessionId) {
  const rows = await api.table.query(T_MESSAGE, { session_ref: sessionId });
  return rows.sort((a, b) => a.id - b.id);
}

async function addMessage(sessionId, { role, content, inTokens = null, outTokens = null, error = null }) {
  const { id } = await api.table.insert(T_MESSAGE, {
    session_ref: sessionId, role, content, create_at: nowIso(),
    in_tokens: inTokens, out_tokens: outTokens, error,
  });
  return id;
}

async function updateMessage(id, patch) {
  await api.table.update(T_MESSAGE, id, patch);
}

async function deleteMessage(id) {
  await api.table.delete(T_MESSAGE, id);
}

window.Store = {
  api, nowIso,
  getConfig, setConfig,
  listSessions, createSession, touchSession, deleteSession,
  listMessages, addMessage, updateMessage, deleteMessage,
};
