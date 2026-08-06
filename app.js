'use strict';
// Bootstrap for the standalone-window entry (index.html). The docked-panel
// twin is panel.js; the only differences are the window chrome this file owns
// and the module context panel.js asks the host for.

document.getElementById('close-btn').onclick = () => window.close();

async function start() {
  if (!Store.api) {
    // Opened outside DraconDex: there is no table to read or write, so show
    // the notice rather than a chat UI that cannot remember anything.
    document.getElementById('offline').hidden = false;
    return;
  }
  try {
    await ChatActions.boot();
  } catch (e) {
    const root = document.getElementById('root');
    root.replaceChildren();
    const err = document.createElement('p');
    err.className = 'error';
    err.textContent = String(e?.message || e);
    root.appendChild(err);
  }
}

start();
