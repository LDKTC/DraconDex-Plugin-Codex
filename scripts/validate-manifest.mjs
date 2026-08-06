#!/usr/bin/env node
// Local pre-flight for dracondex-plugin.json — mirrors validateManifest in
// App-DraconDex's src/db/plugin-manifest.js, so a manifest that passes here
// is one the app will accept on install. Zero dependencies; run it with
//   node scripts/validate-manifest.mjs [path/to/dracondex-plugin.json]
//
// On top of the app's rules it also checks things the app can only discover
// mid-install: that every path in `files` actually exists in the repo, that
// none of them is over the 2 MB per-file cap, and that the composed table
// name `plg_<id>_<name>` still fits.
//
// This file is NOT part of the plugin — it isn't listed in `files`, so the app
// never downloads it.
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const PLUGIN_ID_RE = /^[a-z0-9_]{1,20}$/;
const PLUGIN_TABLE_RE = /^[a-z0-9_]{1,20}$/;
const PLUGIN_COLUMN_RE = /^[a-z][a-z0-9_]{0,29}$/;
const FULL_TABLE_RE = /^plg_[a-z0-9_]{1,41}$/;
const COL_TYPES = new Set(['TEXT', 'INTEGER', 'REAL']);
const RESERVED_COLS = new Set(['id', 'rowid', 'oid', '_rowid_']);
const MAX_TABLES = 10;
const MAX_COLS = 25;
const MAX_FILES = 30;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const manifestPath = resolve(process.argv[2] || 'dracondex-plugin.json');
const root = dirname(manifestPath);
const errors = [];
const warnings = [];

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (e) {
  console.error(`✗ ${manifestPath}: ${e.message}`);
  process.exit(1);
}

const { id, name, version, entry, files, tables } = manifest;

if (!PLUGIN_ID_RE.test(String(id || ''))) errors.push('invalid or missing "id" (^[a-z0-9_]{1,20}$)');
if (!name || typeof name !== 'string' || name.length > 80) errors.push('invalid or missing "name" (string, max 80 chars)');
if (version != null && (typeof version !== 'string' || version.length > 40)) errors.push('invalid "version" (string, max 40 chars)');
if (!entry || typeof entry !== 'string') errors.push('invalid or missing "entry"');
else if (!/\.html?$/i.test(entry)) warnings.push(`"entry" is "${entry}" — the app opens it with loadFile, so it should be an HTML file`);

if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) {
  errors.push(`"files" must be a non-empty array of at most ${MAX_FILES} entries`);
} else {
  for (const f of files) {
    if (typeof f !== 'string' || !f || f.includes('..') || f.startsWith('/') || f.includes('\\')) {
      errors.push(`unsafe file path: ${f}`);
      continue;
    }
    // Not an app rule — but a file the app can't fetch fails the install.
    try {
      const bytes = statSync(resolve(root, f)).size;
      if (bytes > MAX_FILE_BYTES) errors.push(`"${f}" is ${bytes} bytes, over the ${MAX_FILE_BYTES} byte per-file cap`);
    } catch {
      errors.push(`"${f}" is listed in "files" but does not exist in the repo`);
    }
  }
  if (entry && !files.includes(entry)) errors.push('"entry" must be listed in "files"');
}

const tableList = Array.isArray(tables) ? tables : [];
if (tableList.length > MAX_TABLES) errors.push(`too many tables (max ${MAX_TABLES})`);
const seenTables = new Set();
for (const t of tableList) {
  const tname = String(t?.name || '');
  if (!t || !PLUGIN_TABLE_RE.test(tname)) { errors.push(`invalid table name: ${t?.name}`); continue; }
  if (seenTables.has(tname)) errors.push(`duplicate table name: ${tname}`);
  seenTables.add(tname);
  if (PLUGIN_ID_RE.test(String(id || '')) && !FULL_TABLE_RE.test(`plg_${id}_${tname}`)) {
    errors.push(`composed table name "plg_${id}_${tname}" is too long (id + table name must fit in 41 chars)`);
  }

  const cols = Array.isArray(t.columns) ? t.columns : [];
  if (cols.length === 0 || cols.length > MAX_COLS) errors.push(`table "${tname}" must have 1-${MAX_COLS} columns`);
  const seenCols = new Set();
  for (const c of cols) {
    const cname = String(c?.name || '');
    if (!c || !PLUGIN_COLUMN_RE.test(cname)) { errors.push(`invalid column name in table "${tname}": ${c?.name}`); continue; }
    if (RESERVED_COLS.has(cname.toLowerCase())) errors.push(`reserved column name: ${cname}`);
    if (!COL_TYPES.has(String(c.type || '').toUpperCase())) errors.push(`invalid column type for "${cname}": ${c.type} (TEXT, INTEGER or REAL)`);
    if (seenCols.has(cname)) errors.push(`duplicate column name: ${cname}`);
    seenCols.add(cname);
  }
}

for (const w of warnings) console.warn(`! ${w}`);
if (errors.length) {
  console.error(`✗ ${manifestPath}`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
const tableSummary = tableList.map((t) => `plg_${id}_${t.name}`).join(', ') || 'none';
console.log(`✓ ${manifest.name} (${id}) v${version ?? '—'}`);
console.log(`  files:  ${files.length} (entry: ${entry})`);
console.log(`  tables: ${tableSummary}`);
