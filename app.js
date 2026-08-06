// A plugin window never gets window.api, Node, or the filesystem — the whole
// capability it has is window.pluginApi, scoped to the table(s) this plugin
// declared in dracondex-plugin.json.
// See https://github.com/LDKTC/App-DraconDex/blob/main/docs/PLUGINS.md
//
// window.extApi is the pre-v4.2.0 alias for the same object; falling back to it
// keeps this page working on older builds of the app.
const api = window.pluginApi || window.extApi || null;

// Must match a `tables[].name` in the manifest. The real SQLite table is
// plg_<plugin id>_<name>, but that name is never used from in here.
const TABLE = "notes";

const form = document.getElementById("note-form");
const titleInput = document.getElementById("note-title");
const bodyInput = document.getElementById("note-body");
const ratingInput = document.getElementById("note-rating");
const submitBtn = document.getElementById("submit-btn");
const cancelBtn = document.getElementById("cancel-btn");
const list = document.getElementById("note-list");
const empty = document.getElementById("empty");
const errorBox = document.getElementById("error");

// null = the form adds a new row; a number = it updates that row.
let editingId = null;

document.getElementById("close-btn").onclick = () => window.close();

function showError(e) {
  errorBox.textContent = String(e?.message || e);
  errorBox.hidden = false;
}

function clearError() {
  errorBox.hidden = true;
}

function startEdit(note) {
  editingId = note.id;
  titleInput.value = note.title ?? "";
  bodyInput.value = note.body ?? "";
  ratingInput.value = note.rating ?? "";
  submitBtn.textContent = "Save changes";
  cancelBtn.hidden = false;
  titleInput.focus();
}

function resetForm() {
  editingId = null;
  form.reset();
  submitBtn.textContent = "Add note";
  cancelBtn.hidden = true;
}

// Rows come back newest-first (the app orders by id DESC) with the SQLite
// `id` column added on top of the columns declared in the manifest.
async function render() {
  const notes = await api.table.query(TABLE, {});
  list.replaceChildren();
  empty.hidden = notes.length > 0;

  for (const note of notes) {
    const li = document.createElement("li");

    const text = document.createElement("div");
    text.className = "note-text";
    // textContent, not innerHTML — a note is user data, never markup.
    const title = document.createElement("strong");
    title.textContent = note.title ?? "(untitled)";
    const meta = document.createElement("span");
    meta.className = "muted";
    meta.textContent = [
      note.rating == null ? null : `${note.rating}/10`,
      note.created_at,
    ].filter(Boolean).join(" · ");
    text.append(title, document.createElement("br"), meta);
    if (note.body) {
      const body = document.createElement("p");
      body.textContent = note.body;
      text.appendChild(body);
    }

    const editBtn = document.createElement("button");
    editBtn.textContent = "Edit";
    editBtn.onclick = () => startEdit(note);

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Delete";
    removeBtn.onclick = async () => {
      try {
        await api.table.delete(TABLE, note.id);
        if (editingId === note.id) resetForm();
        await render();
      } catch (e) { showError(e); }
    };

    li.append(text, editBtn, removeBtn);
    list.appendChild(li);
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearError();
  // Only keys that match a declared column are accepted — anything else is
  // rejected by the app with "unknown column".
  const row = {
    title: titleInput.value,
    body: bodyInput.value || null,
    rating: ratingInput.value === "" ? null : Number(ratingInput.value),
  };
  try {
    if (editingId == null) {
      row.created_at = new Date().toISOString().slice(0, 10);
      await api.table.insert(TABLE, row);
    } else {
      await api.table.update(TABLE, editingId, row);
    }
    resetForm();
    await render();
  } catch (err) { showError(err); }
});

cancelBtn.addEventListener("click", resetForm);

async function start() {
  if (!api) {
    document.getElementById("offline").hidden = false;
    form.hidden = true;
    return;
  }
  try {
    // Not required — just the handy way to see what the app actually created
    // for this table: { columns: [{ name, type }, ...] }.
    console.log(await api.table.getSchema(TABLE));
    await render();
  } catch (e) { showError(e); }
}

start();
