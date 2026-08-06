# DraconDex-Plugin-Codex

A Codex (OpenAI) chat session for
[DraconDex](https://github.com/LDKTC/App-DraconDex), docked in place of the
Module Inspector.

Install it, open any module, and a **🤖** button appears next to the Module
Inspector toggle. Click it and the Inspector dock is replaced by a chat panel
scoped to that module. It also runs as a standalone window if you'd rather have
the room.

This is the OpenAI sibling of
[DraconDex-Plugin-Claude](https://github.com/LDKTC/DraconDex-Plugin-Claude) —
same layout, same panel behaviour, different provider. Both can be installed at
once; they use different plugin ids and therefore different tables.

> Requires **DraconDex 4.3.0+** for the docked panel. On 4.2.x it still installs
> and works as a plain window (Settings → Plugin → Launch) — there is just no
> button in the main window, because the panel API doesn't exist there yet.

## Connecting

Two modes, in Settings inside the plugin. Both send
`Authorization: Bearer …`; they differ in where the token comes from and which
endpoint it is spent at.

### API key — supported, works today

Paste an [OpenAI API key](https://platform.openai.com/api-keys). Requests go to
`https://api.openai.com/v1/responses`. That's the whole setup.

### Subscription (OAuth) — read this first

OpenAI publishes **no supported API** for driving a ChatGPT subscription from a
third-party app, and this plugin does not invent one. What this mode implements
is a standard **OAuth 2.0 + PKCE** client against endpoints *you* supply, and it
posts to the undocumented ChatGPT backend
(`https://chatgpt.com/backend-api/codex/responses`), which may refuse an
unfamiliar client. There are two ways in:

**1. Sign in** — fill in a client ID, authorize URL and token URL (the
`auth.openai.com` endpoints are prefilled), then press Sign in. Your system
browser opens and DraconDex captures the redirect, because a plugin page cannot
listen on a port. The token exchange happens inside the plugin, so a client
secret never leaves it, and access tokens are refreshed before they expire.

> **The catch.** DraconDex's redirect receiver binds a **random** loopback port
> — `http://127.0.0.1:<random>/callback`
> ([`src/db/oauth-loopback.js`](https://github.com/LDKTC/App-DraconDex/blob/main/src/db/oauth-loopback.js)
> calls `srv.listen(0)`). A provider that requires one exact pre-registered
> redirect URI will reject that, and OpenAI's own Codex client requires
> `http://localhost:1455/auth/callback`. So this path works only with an OAuth
> client that accepts dynamic loopback ports, per
> [RFC 8252 §7.3](https://www.rfc-editor.org/rfc/rfc8252#section-7.3).

**2. Paste a token** — for everyone the catch applies to. If you have already
signed in elsewhere (`codex login` writes `~/.codex/auth.json`), paste the
access token — plus the refresh token if you want it renewed automatically, and
a ChatGPT account id if your token spans several workspaces. It is stored and
used exactly like one obtained by signing in.

If neither fits, use API key mode.

## What it can do

- Streams replies as they arrive, with **Stop**
- Any model id the endpoint accepts — the picker is a free-text field with
  suggestions, plus a **Fetch models** button that replaces them with what your
  credentials can actually reach
- Reasoning effort (`minimal` … `xhigh`) and an optional streamed summary of the
  model's reasoning
- Optional system prompt, adjustable max output tokens, overridable base URL
- One conversation per module, kept separate, plus a History tab
- Surfaces refusals, cut-off responses, rate limits and API errors as
  themselves, with **Retry** — rather than swallowing them

Not included: tool use / function calling, file attachments, and server-side
conversation state (`store` is `false`; the transcript is replayed from this
plugin's own tables each turn).

## Where your data goes

- **Conversations** live in this plugin's own SQLite tables inside your vault
  (`plg_codex_chat_session` / `_message` / `_config`). They are never sent
  anywhere except to the endpoint you configured, as conversation history.
- **Your API key and OAuth tokens** are stored in that same `config` table **in
  plain text**. DraconDex has no encrypted credential store — it keeps its own
  Google Drive client secret the same way — so this is consistent with the rest
  of the app, not better than it. Treat your vault file accordingly.
- **Network access** is restricted by the manifest to `https://api.openai.com`,
  `https://auth.openai.com` and `https://chatgpt.com`, and nothing else.
  DraconDex shows those hosts in the install preview before you confirm, and
  enforces them at runtime — a base URL pointing anywhere else is refused.

## The manifest

```json
{
  "id": "codex_chat",
  "name": "Codex Chat",
  "entry": "index.html",
  "files": ["index.html", "panel.html", "…"],
  "panels": [
    { "id": "chat", "title": "Codex", "icon": "🤖", "entry": "panel.html" }
  ],
  "permissions": {
    "net": ["https://api.openai.com", "https://auth.openai.com", "https://chatgpt.com"],
    "context": ["module"]
  },
  "tables": [ "…" ]
}
```

`panels` and `permissions` are the DraconDex 4.3.0 additions; everything else is
the plugin format from 4.2.0. Full rules are in
[App-DraconDex's `docs/PLUGINS.md`](https://github.com/LDKTC/App-DraconDex/blob/main/docs/PLUGINS.md).

`permissions.context: ["module"]` lets the panel receive the open module's id,
name and kind — enough to keep one conversation per module and to title it.
Nothing about the module's *content* is shared.

Note that `permissions.net` also gates OAuth: DraconDex checks the authorize
URL's origin against this same list before opening the browser, which is why the
auth hosts are declared here and not only the API host.

## Structure

| File | Purpose |
| --- | --- |
| `dracondex-plugin.json` | Manifest: id, files, panel, permissions, table schema. |
| `index.html` + `app.js` | Standalone-window entry (draws its own title bar). |
| `panel.html` + `panel.js` | Docked-panel entry; asks the host for module context. |
| `src/store.js` | The three tables, via `window.pluginApi.table.*`. |
| `src/provider.js` | Responses API client + both auth modes. |
| `src/chat.js` | Session and turn state; no DOM. |
| `src/ui.js` | Rendering. Builds nodes, never HTML strings. |
| `style.css` | Dark theme matching the app; works at 290px and at 900px. |
| `scripts/validate-manifest.mjs` | Local manifest check. Not shipped — it isn't in `files`. |

Both entries load the same four `src/` scripts and differ only in chrome.

### A constraint worth knowing if you fork this

A docked panel is **reloaded whenever DraconDex re-renders its pane** — editing
a tag on the module is enough. Nothing may live only in a variable. Every
message is written to the table at the moment it exists (the question before the
request goes out, the answer as soon as the stream ends), and the panel rebuilds
itself from the tables on every load. A reply that was still streaming when a
reload happened is the only thing that can be lost.

## Developing

```bash
node scripts/validate-manifest.mjs        # same rules the app enforces on install
node --check app.js panel.js src/*.js
```

Then in DraconDex: **Settings → Plugin → Plugins**, paste this repo's link,
confirm the preview. Reinstalling after a change means uninstalling first (the
same `id` can't install twice), and **uninstalling permanently deletes this
plugin's conversations** — so don't develop against a vault you care about.

## License

MIT, see [LICENSE](LICENSE).
