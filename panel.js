'use strict';
// Bootstrap for the docked-panel entry (panel.html).
//
// Two things differ from the standalone window (app.js):
//
// 1. The host draws the panel header and its close button, so there is no
//    title bar here.
// 2. The panel can ask the host which module is open — but only because the
//    manifest declares `permissions.context: ["module"]` and the user saw that
//    at install time. The host replies with null if it was not granted, so
//    this must work either way.
//
// The panel is reloaded whenever DraconDex re-renders its pane, so this runs
// often and start-up has to be cheap and idempotent. Everything it needs comes
// back out of the plugin's own tables.

const panelApi = (window.pluginApi || window.extApi || {}).panel || null;

// Waits briefly for the host's context reply, then boots regardless — a host
// that never answers (or was never asked, because the permission wasn't
// granted) must not leave the panel stuck on a blank page.
function requestModuleContext(timeoutMs = 400) {
  if (!panelApi) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; off?.(); resolve(value); } };
    const off = panelApi.onMessage((msg) => { if (msg?.type === 'context') finish(msg.context || null); });
    panelApi.send({ type: 'getContext' });
    setTimeout(() => finish(null), timeoutMs);
  });
}

async function start() {
  if (!Store.api) {
    document.getElementById('offline').hidden = false;
    return;
  }
  const moduleContext = await requestModuleContext();
  try {
    await ChatActions.boot({ moduleContext });
  } catch (e) {
    const root = document.getElementById('root');
    root.replaceChildren();
    const err = document.createElement('p');
    err.className = 'error';
    err.textContent = String(e?.message || e);
    root.appendChild(err);
    return;
  }
  // The host can also push context later — e.g. if it starts sharing it after
  // the first exchange — so keep listening past boot.
  panelApi?.onMessage((msg) => {
    if (msg?.type === 'context') ChatActions.setModuleContext(msg.context || null);
  });
}

start();
