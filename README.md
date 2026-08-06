# DraconDex-Plugin-Template

Starter template for building a [DraconDex](https://github.com/LDKTC/App-DraconDex)
plugin. Use this repo as a base: fork/use-as-template it, edit the manifest and
the files it lists, push, then install it in the app by pasting your repo's
link.

> Requires **DraconDex 4.2.0+**, where the feature was renamed from
> "Github Extensions" to **Plugin** and installing became a single pasted URL.
> Plugins written for 4.0/4.1 keep working unchanged — see
> [Legacy: extensions](#legacy-plugins-written-before-v420) at the bottom.

DraconDex plugins are **not** scripts running inside the main app. Each plugin
opens in its own window with **no access to the main app's data or
`window.api`** — only to the SQLite table(s) it declares for itself, through
`window.pluginApi`. For the full architecture and the honest list of what this
does and doesn't protect against, see
[App-DraconDex's `docs/PLUGINS.md`](https://github.com/LDKTC/App-DraconDex/blob/main/docs/PLUGINS.md).

## Quick start

1. Use this repo as a template (or fork it).
2. Edit `dracondex-plugin.json` — pick your own `id`, `name`, and the tables
   you want. The `id` becomes part of real DB table names, so choose it once
   and don't change it after people install.
3. Edit `index.html` / `app.js` / `style.css`, or replace them entirely — just
   keep every file the plugin loads listed in the manifest's `files`.
4. Check the manifest before you push: `node scripts/validate-manifest.mjs`
   (no dependencies; the same rules the app enforces).
5. Push, then install it from DraconDex: **Settings → Plugin → Plugins**,
   paste your repo link, confirm the preview.

## Structure

| File | Purpose |
| --- | --- |
| `dracondex-plugin.json` | Manifest: id, name, version, entry point, files, and table schema. |
| `index.html` | Entry point (must be listed in `files` and match `entry`). |
| `app.js` | Plugin logic. Talks to its own table via `window.pluginApi.table.*`. |
| `style.css` | Optional styling. Mirrors the app's dark theme tokens. |
| `scripts/validate-manifest.mjs` | Local manifest check. Not shipped — it isn't in `files`. |

Only the paths listed in `files` are ever downloaded, so repo-side extras
(README, scripts, CI, tests) cost the user nothing.

## Manifest (`dracondex-plugin.json`)

```json
{
  "id": "example_plugin",
  "name": "Example Plugin",
  "version": "0.1.0",
  "entry": "index.html",
  "files": ["index.html", "app.js", "style.css"],
  "tables": [
    {
      "name": "notes",
      "columns": [
        { "name": "title", "type": "TEXT" },
        { "name": "rating", "type": "INTEGER" }
      ]
    }
  ]
}
```

Rules the app enforces on install (`validateManifest` in App-DraconDex's
`src/db/plugin-manifest.js`):

- `id` — `^[a-z0-9_]{1,20}$`. Becomes part of the plugin's real DB table
  names, so pick it deliberately. Two plugins with the same `id` cannot be
  installed side by side (`already_installed`).
- `name` — string, max 80 characters.
- `version` — optional string, max 40 characters.
- `entry` — an HTML file, and it must also appear in `files`.
- `files` — 1 to 30 relative paths (no `..`, no leading `/`, no `\`), each
  fetched individually and capped at 2 MB. Subdirectories are fine
  (`ui/panel.js`). The app does not crawl your repo — only files listed here
  are downloaded.
- `tables` — up to 10 tables, each with 1 to 25 columns.
  - table `name`: `^[a-z0-9_]{1,20}$`, and `id`+`name` together must stay
    within 41 characters (the real table is `plg_<id>_<name>`).
  - column `name`: `^[a-z][a-z0-9_]{0,29}$`, and cannot be `id`, `rowid`,
    `oid`, or `_rowid_`.
  - column `type`: `TEXT`, `INTEGER`, or `REAL` only — no `DEFAULT`, `CHECK`,
    or `FOREIGN KEY` support.

Every table also gets an implicit `id INTEGER PRIMARY KEY AUTOINCREMENT` that
you don't declare and can't override; it's the `id` you pass to `update` and
`delete`.

## The `window.pluginApi` surface

Inside a plugin window there is **no `window.api`**, no Node, and no
filesystem — only:

```js
await window.pluginApi.table.getSchema(localName)      // { columns: [{ name, type }, …] }
await window.pluginApi.table.query(localName, filter)  // rows, newest id first
await window.pluginApi.table.insert(localName, row)    // { id }
await window.pluginApi.table.update(localName, id, row)// { changes }
await window.pluginApi.table.delete(localName, id)     // { changes }
```

- `localName` is the `name` you declared under `tables` (e.g. `"notes"`), not
  the internal `plg_*` table name.
- `filter` is an object of exact-match column equalities ANDed together;
  `{}` returns everything. There is no operator syntax, no raw SQL, and no
  pagination — filter and sort the rest in JS.
- Keys in `filter` and `row` must be declared columns, or the call rejects with
  `unknown column: …`.
- Every call is scoped to the tables *this* plugin declared — ownership is
  resolved from the calling window itself, not from anything the page sends,
  so there is no way to reach another plugin's data or the main app's data.
- Calls reject with `not an owned table` if `localName` isn't one of yours.

## Writing the window itself

Plugin windows are created frameless (`frame: false`, 900×650, min 480×360,
dark `#050506` background). Practical consequences:

- **Draw your own title bar.** Give it `-webkit-app-region: drag` so the
  window can be moved, and `-webkit-app-region: no-drag` on every button
  inside it. `index.html` + `style.css` here show the minimum version.
- **Give the user a way out** — `window.close()` works; there is no OS close
  button. (The app's plugin list also has a **Stop** button.)
- **The app's stylesheets are not injected.** Ship whatever CSS you need in
  your own `files`.
- `window.prompt()` is unsupported in Electron renderers — use your own UI.
- Nothing sanitizes your rendering: treat stored rows as data and use
  `textContent`, not `innerHTML`.

## Installing your plugin for testing

In the DraconDex app: **Settings → Plugin → Plugins**, paste your repo link
and confirm the preview. Accepted link shapes include:

| Shape | Example |
| --- | --- |
| HTTPS + `.git` | `https://github.com/acme/my-plugin.git` |
| Plain HTTPS | `https://github.com/acme/my-plugin` |
| SSH / scp | `git@github.com:acme/my-plugin.git` |
| No scheme | `github.com/acme/my-plugin` |
| Shorthand | `acme/my-plugin` (assumed GitHub) |
| Explicit branch | `https://github.com/acme/my-plugin/tree/dev` |
| GitLab | `https://gitlab.com/acme/team/my-plugin.git` |

Only **github.com** and **gitlab.com** are supported — other hosts are
rejected with `unsupported_host`. With no branch in the link the app tries
`main`, then `master`. The manifest is looked up as `dracondex-plugin.json`
first, then `dracondex-extension.json`.

The preview shows the name/version/id, the files it will download, and the
tables it will create — it touches neither disk nor DB. Installing re-fetches
and re-validates everything from the URL alone.

Reinstalling after a change means **uninstall first** (same `id` can't install
twice), and uninstalling **permanently deletes that plugin's files and
tables** — so don't develop against data you care about.

## Legacy: plugins written before v4.2.0

Nothing to change. `window.extApi` still exists as an alias for the same
object, and `dracondex-extension.json` is still found as a fallback manifest
name. Existing installs were migrated in place (`ext_*` tables → `plg_*`,
`extensions/` → `plugins/`). New plugins should use the `pluginApi` /
`dracondex-plugin.json` names; `app.js` here falls back to `extApi` only so
the same page also runs on 4.0/4.1.

## License

MIT, see [LICENSE](LICENSE).
