'use strict';
// Rendering. The whole page is one of three views (chat / sessions / settings)
// drawn into #root, plus renderStream() which patches only the streaming
// bubble — redrawing everything on every token would reset the scroll position
// and lose the composer's focus.
//
// Nothing stored is ever interpolated into an HTML string. Message bodies come
// from the model and from the user, so they are built with textContent and the
// tiny inline-markdown pass below works on DOM nodes, not markup.

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

const root = () => document.getElementById('root');

// Replaced by the "Fetch models" button with what the account can actually
// reach. Lives here rather than in Chat because it is a transient UI aid, not
// something worth a row in the config table.
let modelOptions = null;

// --- message body ----------------------------------------------------------
// A deliberately small subset: fenced code blocks and `inline code`. Both are
// created as elements with textContent, so a reply containing markup renders
// as the characters the model actually wrote.
function renderBody(container, text) {
  const parts = String(text).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // Odd chunks are inside a fence. Drop an opening language tag line.
      const body = part.replace(/^[a-zA-Z0-9_+-]*\n/, '');
      const pre = el('pre', 'code-block');
      pre.appendChild(el('code', null, body));
      container.appendChild(pre);
      return;
    }
    for (const line of part.split('\n')) {
      const p = el('p', 'md-line');
      renderInline(p, line);
      container.appendChild(p);
    }
  });
}

function renderInline(parent, line) {
  const segments = String(line).split(/(`[^`]+`)/);
  for (const seg of segments) {
    if (seg.startsWith('`') && seg.endsWith('`') && seg.length > 2) {
      parent.appendChild(el('code', 'inline-code', seg.slice(1, -1)));
    } else if (seg) {
      parent.appendChild(document.createTextNode(seg));
    }
  }
}

// --- chat view -------------------------------------------------------------
function buildChat() {
  const wrap = el('div', 'chat');
  const stream = el('div', 'stream');
  stream.id = 'stream';

  if (!Chat.messages.length && !Chat.sending) {
    const empty = el('div', 'empty');
    empty.appendChild(el('h3', null, 'Codex'));
    const ctx = Chat.moduleContext?.moduleName;
    empty.appendChild(el('p', null, ctx ? `Ask about ${ctx}, or anything else.` : 'Ask anything.'));
    stream.appendChild(empty);
  }

  for (const m of Chat.messages) stream.appendChild(buildBubble(m));

  if (Chat.sending) {
    const live = buildBubble({ role: 'assistant', content: Chat.streamText }, true);
    live.id = 'live-bubble';
    stream.appendChild(live);
  }
  wrap.appendChild(stream);

  if (Chat.error) {
    const bar = el('div', 'errbar');
    bar.appendChild(el('span', null, Chat.error));
    const retry = el('button', 'btn btn-s', 'Retry');
    retry.onclick = () => ChatActions.retryLast();
    bar.appendChild(retry);
    wrap.appendChild(bar);
  }

  wrap.appendChild(buildComposer());
  return wrap;
}

function buildBubble(m, live = false) {
  const row = el('div', `row ${m.role === 'assistant' ? 'assistant' : 'user'}`);
  const bubble = el('div', 'bubble');

  if (live && Chat.streamReasoning) {
    const think = el('details', 'reasoning');
    think.appendChild(el('summary', null, 'Reasoning…'));
    think.appendChild(el('div', 'reasoning-body', Chat.streamReasoning));
    bubble.appendChild(think);
  }

  const body = el('div', 'body');
  if (m.content) renderBody(body, m.content);
  else if (live) body.appendChild(el('p', 'md-line dim', '…'));
  bubble.appendChild(body);

  if (m.error) bubble.appendChild(el('div', 'bubble-err', m.error));
  if (m.out_tokens != null) bubble.appendChild(el('div', 'meta', `${m.in_tokens ?? '?'} in · ${m.out_tokens} out`));

  row.appendChild(bubble);
  return row;
}

function buildComposer() {
  const form = el('form', 'composer');
  const input = el('textarea', 'input');
  input.id = 'composer-input';
  input.rows = 1;
  input.placeholder = Chat.sending ? 'Waiting for Codex…' : 'Message Codex…';
  input.disabled = Chat.sending;
  // Enter sends, Shift+Enter is a newline — the convention every chat UI uses,
  // and the reason this is a textarea rather than an input.
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  };
  input.oninput = () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  };
  form.appendChild(input);

  const send = el('button', 'btn btn-p', Chat.sending ? 'Stop' : 'Send');
  send.type = Chat.sending ? 'button' : 'submit';
  if (Chat.sending) send.onclick = () => ChatActions.stop();
  form.appendChild(send);

  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value;
    input.value = '';
    input.style.height = 'auto';
    ChatActions.send(text);
  };
  return form;
}

// --- sessions view ---------------------------------------------------------
function buildSessions() {
  const wrap = el('div', 'pane');
  wrap.appendChild(el('div', 'pane-label', 'Conversations'));
  if (!Chat.sessions.length) wrap.appendChild(el('p', 'dim', 'No conversations yet.'));

  for (const s of Chat.sessions) {
    const row = el('div', `li ${s.id === Chat.sessionId ? 'sel' : ''}`);
    const name = el('span', 'li-name', s.title || 'Untitled');
    name.onclick = () => ChatActions.selectSession(s.id);
    row.appendChild(name);
    if (s.module_key) row.appendChild(el('span', 'tag', 'module'));
    const del = el('button', 'btn btn-g btn-i', '×');
    del.title = 'Delete';
    del.onclick = () => ChatActions.removeSession(s.id);
    row.appendChild(del);
    wrap.appendChild(row);
  }
  return wrap;
}

// --- settings view ---------------------------------------------------------
function field(label, node, hint) {
  const fg = el('div', 'fg');
  fg.appendChild(el('label', null, label));
  fg.appendChild(node);
  if (hint) fg.appendChild(el('div', 'hint', hint));
  return fg;
}

function input(id, value, { type = 'text', placeholder = '' } = {}) {
  const node = el('input');
  node.id = id;
  node.type = type;
  node.value = value ?? '';
  node.placeholder = placeholder;
  return node;
}

// Reports the outcome of a settings action in the notice slot without a full
// re-boot — used by the buttons that talk to the network.
async function withNotice(fn) {
  try {
    await fn();
  } catch (e) {
    Chat.notice = String(e?.message || e);
  }
  Chat.settings = await Provider.readSettings();
  render();
}

function buildApiSection(s) {
  const wrap = el('div');
  const key = input('cfg-api-key', s.apiKey, { type: 'password', placeholder: 'sk-…' });
  wrap.appendChild(field('OpenAI API key', key,
    'Stored in this plugin\'s own table, in plain text — same as the app stores its other credentials.'));
  const save = el('button', 'btn btn-p', 'Save key');
  save.onclick = () => ChatActions.saveSettings({ api_key: key.value.trim() });
  wrap.appendChild(save);
  return wrap;
}

function buildOauthSection(s) {
  const wrap = el('div');
  const signedIn = !!s.oauth.accessToken;

  wrap.appendChild(el('div', 'notice',
    'OpenAI publishes no supported API for driving a ChatGPT subscription from a third-party app, and this '
    + 'plugin does not invent one. Local CLI below is the practical way into this mode; "Sign in" is a '
    + 'standard OAuth 2.0 + PKCE client pointed at endpoints you supply, useful only if you already have your '
    + 'own client for the undocumented ChatGPT backend. API key mode remains the fully supported path either way.'));

  // --- sign in ---
  wrap.appendChild(el('div', 'pane-label', 'Sign in'));
  wrap.appendChild(el('div', 'hint',
    'DraconDex captures the redirect on a random loopback port (http://127.0.0.1:<random>/callback). '
    + 'A provider that requires one exact pre-registered redirect URI — OpenAI\'s own Codex client wants '
    + 'http://localhost:1455/auth/callback — will refuse that, so this works only with an OAuth client that '
    + 'accepts dynamic loopback ports. If yours does not, use Local CLI below instead.'));

  const clientId = input('cfg-client-id', s.oauth.clientId, { placeholder: 'app_…' });
  const authorizeUrl = input('cfg-authorize-url', s.oauth.authorizeUrl, { placeholder: Provider.OAUTH_AUTHORIZE_DEFAULT });
  const tokenUrl = input('cfg-token-url', s.oauth.tokenUrl, { placeholder: Provider.OAUTH_TOKEN_DEFAULT });
  const scope = input('cfg-scope', s.oauth.scope, { placeholder: 'optional' });
  wrap.appendChild(field('Client ID', clientId));
  wrap.appendChild(field('Authorize URL', authorizeUrl));
  wrap.appendChild(field('Token URL', tokenUrl));
  wrap.appendChild(field('Scope', scope));

  const row = el('div', 'row-actions');
  const save = el('button', 'btn btn-s', 'Save');
  save.onclick = () => ChatActions.saveSettings({
    oauth_client_id: clientId.value.trim(),
    oauth_authorize_url: authorizeUrl.value.trim(),
    oauth_token_url: tokenUrl.value.trim(),
    oauth_scope: scope.value.trim(),
  });
  row.appendChild(save);

  const auth = el('button', 'btn btn-p', signedIn ? 'Sign out' : 'Sign in');
  auth.onclick = () => withNotice(async () => {
    if (signedIn) { await Provider.oauthSignOut(); Chat.notice = 'Signed out.'; }
    else { await Provider.oauthSignIn(); Chat.notice = 'Signed in.'; }
  });
  row.appendChild(auth);
  wrap.appendChild(row);
  wrap.appendChild(el('div', 'hint', signedIn
    ? `Signed in.${s.oauth.expiresAt ? ` Token expires ${new Date(s.oauth.expiresAt).toLocaleString()}.` : ''}`
    : 'Not signed in.'));

  // --- Local CLI ---
  wrap.appendChild(el('div', 'pane-label', 'Local CLI'));
  wrap.appendChild(el('div', 'hint',
    'Already signed in with the Codex CLI? `codex login` writes an access token to ~/.codex/auth.json — '
    + 'paste it here. It is stored and refreshed exactly like one obtained by signing in above. This plugin '
    + 'never runs the CLI itself — a plugin page has no process access to do that, by design — it only '
    + 'accepts whatever token `codex login` already produced.'));

  const access = input('cfg-access-token', s.oauth.accessToken, { type: 'password', placeholder: 'access token' });
  const refresh = input('cfg-refresh-token', s.oauth.refreshToken, { type: 'password', placeholder: 'refresh token (optional)' });
  const account = input('cfg-account-id', s.oauth.accountId, { placeholder: 'account id (optional)' });
  wrap.appendChild(field('Access token', access));
  wrap.appendChild(field('Refresh token', refresh, 'Without one, the token cannot be renewed when it expires.'));
  wrap.appendChild(field('ChatGPT account id', account, 'Sent as chatgpt-account-id. Needed when the token spans several workspaces.'));

  const saveToken = el('button', 'btn btn-p', 'Save token');
  saveToken.onclick = () => ChatActions.saveSettings({
    oauth_access_token: access.value.trim(),
    oauth_refresh_token: refresh.value.trim(),
    oauth_account_id: account.value.trim(),
    // A pasted token carries no expiry, so clear any stale one rather than
    // letting it trigger a refresh the moment the next request goes out.
    oauth_expires_at: '',
  });
  wrap.appendChild(saveToken);
  return wrap;
}

function buildModelSection(s) {
  const wrap = el('div');
  wrap.appendChild(el('div', 'pane-label', 'Model'));

  const model = input('cfg-model', s.model, { placeholder: Provider.DEFAULT_MODEL });
  model.setAttribute('list', 'model-options');
  const list = el('datalist');
  list.id = 'model-options';
  for (const id of modelOptions || Provider.MODEL_SUGGESTIONS) {
    const opt = el('option');
    opt.value = id;
    list.appendChild(opt);
  }
  const modelRow = el('div', 'row-actions');
  modelRow.append(model, list);
  const fetchBtn = el('button', 'btn btn-s', 'Fetch models');
  fetchBtn.title = 'Replace the suggestions with the models these credentials can reach';
  fetchBtn.onclick = () => withNotice(async () => {
    modelOptions = await Provider.fetchModels(Chat.settings);
    Chat.notice = `${modelOptions.length} models available.`;
  });
  modelRow.appendChild(fetchBtn);
  // Free text, not a dropdown: model ids turn over faster than this plugin
  // does, and a frozen list would lock the user out of a model they can use.
  wrap.appendChild(field('Model', modelRow,
    'Any model id the endpoint accepts. The list is a suggestion, not a limit.'));
  model.onchange = () => ChatActions.saveSettings({ model: model.value.trim() });

  const effort = el('select');
  effort.id = 'cfg-effort';
  for (const value of ['', ...Provider.EFFORTS]) {
    const opt = el('option', null, value || 'default');
    opt.value = value;
    if (value === s.effort) opt.selected = true;
    effort.appendChild(opt);
  }
  effort.onchange = () => ChatActions.saveSettings({ effort: effort.value });
  wrap.appendChild(field('Reasoning effort', effort,
    'Higher effort thinks longer and costs more. Only reasoning models accept this.'));

  const summary = el('input');
  summary.type = 'checkbox';
  summary.id = 'cfg-reasoning-summary';
  summary.checked = s.reasoningSummary;
  summary.onchange = () => ChatActions.saveSettings({ reasoning_summary: summary.checked ? '1' : '0' });
  const summaryWrap = el('div', 'check');
  summaryWrap.appendChild(summary);
  summaryWrap.appendChild(el('span', null, 'Show a summary of the model\'s reasoning'));
  wrap.appendChild(field('Reasoning summary', summaryWrap));

  const maxTokens = input('cfg-max-tokens', String(s.maxOutputTokens), { type: 'number' });
  maxTokens.onchange = () => ChatActions.saveSettings({ max_output_tokens: maxTokens.value });
  wrap.appendChild(field('Max output tokens', maxTokens));

  const system = el('textarea');
  system.id = 'cfg-system';
  system.rows = 3;
  system.value = s.systemPrompt;
  system.placeholder = 'Optional instructions';
  system.onchange = () => ChatActions.saveSettings({ system_prompt: system.value });
  wrap.appendChild(field('System prompt', system));
  return wrap;
}

function buildEndpointSection(s) {
  const wrap = el('div');
  wrap.appendChild(el('div', 'pane-label', 'Endpoint'));
  const base = input('cfg-base-url', s.baseUrlOverridden ? s.baseUrl : '', { placeholder: Provider.defaultBaseUrl(s.mode) });
  const row = el('div', 'row-actions');
  row.appendChild(base);
  const save = el('button', 'btn btn-s', 'Save');
  save.onclick = () => ChatActions.saveSettings({ base_url: base.value.trim() });
  row.appendChild(save);
  wrap.appendChild(field('Base URL', row,
    `Leave blank for this mode's default. Requests go to <base>/responses, and the host only allows `
    + `${Provider.ALLOWED_ORIGINS.join(', ')}.`));
  return wrap;
}

function buildSettings() {
  const s = Chat.settings;
  const wrap = el('div', 'pane');

  if (Chat.notice) wrap.appendChild(el('div', 'notice', Chat.notice));

  wrap.appendChild(el('div', 'pane-label', 'Connection'));

  const modeRow = el('div', 'seg');
  for (const [value, label] of [['api', 'API key'], ['oauth', 'Subscription (OAuth)']]) {
    const b = el('button', `btn btn-s ${s.mode === value ? 'active' : ''}`, label);
    b.onclick = () => ChatActions.saveSettings({ mode: value });
    modeRow.appendChild(b);
  }
  wrap.appendChild(field('Mode', modeRow));

  wrap.appendChild(s.mode === 'api' ? buildApiSection(s) : buildOauthSection(s));
  wrap.appendChild(buildEndpointSection(s));
  wrap.appendChild(buildModelSection(s));

  if (!Provider.hasHostNet()) {
    wrap.appendChild(el('div', 'notice',
      'This DraconDex version has no plugin network API, so requests go straight from this page '
      + 'and are subject to the browser\'s cross-origin rules. Update the app if requests fail.'));
  }
  return wrap;
}

// --- shell -----------------------------------------------------------------
function buildTabs() {
  const bar = el('div', 'tabs');
  for (const [view, label] of [['chat', 'Chat'], ['sessions', 'History'], ['settings', 'Settings']]) {
    const b = el('button', `tab ${Chat.view === view ? 'active' : ''}`, label);
    b.onclick = () => { Chat.view = view; render(); };
    bar.appendChild(b);
  }
  const add = el('button', 'btn btn-g btn-i', '+');
  add.title = 'New conversation';
  add.onclick = () => ChatActions.newSession();
  bar.appendChild(add);
  return bar;
}

function render() {
  const host = root();
  if (!host) return;
  host.replaceChildren();
  host.appendChild(buildTabs());
  if (Chat.view === 'settings') host.appendChild(buildSettings());
  else if (Chat.view === 'sessions') host.appendChild(buildSessions());
  else host.appendChild(buildChat());
  scrollToEnd();
  if (Chat.view === 'chat' && !Chat.sending) document.getElementById('composer-input')?.focus();
}

// Token-by-token patch of just the live bubble. A full render() here would
// reset the scroll position and blur the composer on every delta.
function renderStream() {
  const bubble = document.getElementById('live-bubble');
  if (!bubble) return;
  const body = bubble.querySelector('.body');
  if (body) { body.replaceChildren(); renderBody(body, Chat.streamText || '…'); }
  if (Chat.streamReasoning) {
    let think = bubble.querySelector('.reasoning-body');
    if (!think) {
      const details = el('details', 'reasoning');
      details.appendChild(el('summary', null, 'Reasoning…'));
      think = el('div', 'reasoning-body');
      details.appendChild(think);
      bubble.prepend(details);
    }
    think.textContent = Chat.streamReasoning;
  }
  scrollToEnd();
}

// Only auto-scroll when the user is already at the bottom — yanking the view
// down while they are reading back through the transcript is worse than
// letting new content arrive off-screen.
function scrollToEnd() {
  const stream = document.getElementById('stream');
  if (!stream) return;
  const atBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 120;
  if (atBottom) stream.scrollTop = stream.scrollHeight;
}

window.UI = { render, renderStream };
