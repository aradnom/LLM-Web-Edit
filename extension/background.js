const DEFAULT_SERVER_URL = "http://127.0.0.1:7411";

async function getSettings() {
  const { serverUrl, token } = await browser.storage.local.get(["serverUrl", "token"]);
  return {
    serverUrl: (serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, ""),
    token: token || "",
  };
}

async function callServer(path, { method = "GET", body } = {}) {
  const { serverUrl, token } = await getSettings();
  if (!token) throw new Error("No server token set. Open the extension's options and paste it in.");

  let response;
  try {
    response = await fetch(serverUrl + path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`Could not reach the server at ${serverUrl}. Is it running?`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Server responded ${response.status}`);
  return data;
}

// Runs `worker` over `items` with a bounded number in flight, so a page with
// hundreds of scripts doesn't open hundreds of connections at once.
async function forEachLimited(items, limit, worker) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await worker(items[next++]);
  });
  await Promise.all(lanes);
}

// "force-cache" asks for the copy the page itself was served, which is both
// faster and more likely to match what is actually running.
async function fetchText(url) {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

// Fills in what the page couldn't provide itself: external scripts, and
// stylesheets it wasn't allowed to read (cross-origin without CORS). Fetching
// from here means the extension's host permissions apply.
async function fetchMissingAssets(snapshot) {
  const pending = [
    ...snapshot.stylesheets
      .filter((sheet) => sheet.css === null && sheet.href)
      .map((sheet) => ({ target: sheet, url: sheet.href, field: "css" })),
    ...snapshot.scripts
      .filter((script) => script.code === null && script.url)
      .map((script) => ({ target: script, url: script.url, field: "code" })),
  ];
  await forEachLimited(pending, 8, async ({ target, url, field }) => {
    try {
      target[field] = await fetchText(url);
      delete target.error;
    } catch (err) {
      target.error = `fetch failed: ${err.message}`;
    }
  });
}

// Reads the page in a tab: everything a change or an update is sent with.
async function capturePage(tabId) {
  const tab = await browser.tabs.get(tabId);

  let snapshot;
  try {
    const [injection] = await browser.scripting.executeScript({
      target: { tabId },
      files: ["capture.js"],
    });
    snapshot = injection && injection.result;
  } catch (err) {
    throw new Error(`Could not read this page: ${err.message}`);
  }
  if (!snapshot) throw new Error("Could not read this page.");

  // Best effort: the screenshot helps with "this looks wrong" requests but the
  // change can proceed without it. Taken before the asset fetches so it shows
  // the page as it was when the DOM was read.
  const screenshot = await browser.tabs.captureVisibleTab(tab.windowId, { format: "png" }).catch(() => null);

  const { url, title, ...rest } = snapshot;
  await fetchMissingAssets(rest);
  return { url, title, snapshot: { ...rest, screenshot } };
}

async function submitChange(tabId, request) {
  return callServer("/changes", { method: "POST", body: { ...(await capturePage(tabId)), request } });
}

// An update to an existing change. The page is captured afresh, since it may
// have changed since the last request; the server is told whether the change
// was applied in the tab, because then the capture includes its effects.
async function submitUpdate(id, tabId, request) {
  const page = await capturePage(tabId);
  const applied = Boolean((await getApplied())[appliedKey(tabId, id)]);
  return callServer(`/changes/${encodeURIComponent(id)}/followups`, {
    method: "POST",
    body: { ...page, request, applied },
  });
}

// ---- Applying changes -------------------------------------------------------

// What has been injected into which tab, keyed "<tabId>:<changeId>", so it
// can be undone. Session storage because none of it survives a browser restart.
const appliedKey = (tabId, id) => `${tabId}:${id}`;

async function getApplied() {
  return (await browser.storage.session.get("applied")).applied || {};
}

// Changes the user has switched to "always apply", keyed by change id. Each
// entry carries its own copy of the overlay, so they keep working when the
// server is not running.
async function getPersistent() {
  return (await browser.storage.local.get("persistent")).persistent || {};
}

const isWebPage = (url) => /^https?:/i.test(url || "");
const hostnameOf = (url) => (isWebPage(url) ? new URL(url).hostname.toLowerCase() : null);

function assertCanRunScripts() {
  // Generated code can only be run through the userScripts API, which is an
  // optional permission the popup requests on the click that needs it.
  if (browser.userScripts && browser.userScripts.execute) return;
  throw new Error(
    browser.userScripts
      ? "This Firefox version cannot run generated scripts (userScripts.execute is missing)."
      : "Permission to run user scripts was not granted.",
  );
}

/** Injects an overlay into a tab and records it as applied there. */
async function inject(tabId, id, { css, js, version }) {
  if (js) assertCanRunScripts();

  const applied = await getApplied();
  const key = appliedKey(tabId, id);
  const previous = applied[key];
  if (previous && previous.css) {
    await browser.scripting.removeCSS({ target: { tabId }, css: previous.css }).catch(() => {});
  }
  if (css) await browser.scripting.insertCSS({ target: { tabId }, css });

  if (js) {
    // MAIN world: behaviour changes need the page's own globals and handlers,
    // which an isolated world cannot see.
    const [outcome] = await browser.userScripts.execute({ target: { tabId }, js: [{ code: js }], world: "MAIN" });
    if (outcome && outcome.error) throw new Error(`The script failed: ${outcome.error}`);
  }

  // `version` is the change's updatedAt, so a later update shows up as stale.
  applied[key] = { css: css || null, js: Boolean(js), version: version || null };
  await browser.storage.session.set({ applied });
  return applied[key];
}

async function fetchOverlay(id, tabId) {
  const tab = await browser.tabs.get(tabId);
  const change = await callServer(`/changes/${encodeURIComponent(id)}`);
  const { css, js } = change.output || {};
  if (!css && !js) throw new Error("This change produced nothing to apply.");
  if (hostnameOf(tab.url) !== change.hostname) {
    throw new Error(`This change was made for ${change.hostname}, not this page.`);
  }
  return { hostname: change.hostname, css: css || null, js: js || null, version: change.updatedAt || null };
}

// Overlays waiting for a tab to finish reloading, tabId -> { items, resolve }.
// Only needed while a popup request is waiting on it, so memory is enough.
const afterReload = new Map();

function reloadThenInject(tabId, items) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      afterReload.delete(tabId);
      resolve();
    }, 30000);
    afterReload.set(tabId, {
      items,
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
    });
    browser.tabs.reload(tabId);
  });
}

// Applying over an earlier version of the same change (after an update): CSS
// is swapped in place, but a script that has run cannot be un-run, so the page
// is reloaded and the new version injected once it has loaded.
async function applyChange(id, tabId) {
  const overlay = await fetchOverlay(id, tabId);
  const previous = (await getApplied())[appliedKey(tabId, id)];
  if (!previous || !previous.js) return inject(tabId, id, overlay);

  if (overlay.js) assertCanRunScripts();
  const persistent = await getPersistent();
  if (persistent[id]) {
    // The page-load listener applies always-on changes itself; make sure it
    // has this version.
    persistent[id] = { ...persistent[id], ...overlay };
    await browser.storage.local.set({ persistent });
  }
  await reloadThenInject(tabId, persistent[id] ? [] : [[id, overlay]]);
  return { reloaded: true };
}

// CSS can be taken back out; a script that has run cannot, so that needs a
// reload (which the onUpdated listener below then records).
async function discardChange(id, tabId) {
  const applied = await getApplied();
  const key = appliedKey(tabId, id);
  const entry = applied[key];
  if (!entry) return { reloaded: false };
  if (entry.js) {
    await browser.tabs.reload(tabId);
    return { reloaded: true };
  }
  if (entry.css) await browser.scripting.removeCSS({ target: { tabId }, css: entry.css });
  delete applied[key];
  await browser.storage.session.set({ applied });
  return { reloaded: false };
}

// Turning "always apply" on stores the overlay and applies it to this tab if
// it is not there already; turning it off only stops future page loads.
async function setPersistent(id, tabId, enabled) {
  const persistent = await getPersistent();
  if (!enabled) {
    delete persistent[id];
    await browser.storage.local.set({ persistent });
    return { persistent: false };
  }
  const overlay = await fetchOverlay(id, tabId);
  if (overlay.js) assertCanRunScripts();
  persistent[id] = { ...overlay, savedAt: Date.now() };
  await browser.storage.local.set({ persistent });
  if (!(await getApplied())[appliedKey(tabId, id)]) await inject(tabId, id, overlay);
  return { persistent: true };
}

// Page loads drive two things. When a load starts, whatever was injected
// into the tab is gone, so its applied records are dropped. When the load
// completes, "always apply" changes for the site are injected: changes are
// written against a fully loaded page, so that is when they are applied.
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    const applied = await getApplied();
    const stale = Object.keys(applied).filter((key) => key.startsWith(`${tabId}:`));
    if (stale.length === 0) return;
    for (const key of stale) delete applied[key];
    await browser.storage.session.set({ applied });
    return;
  }
  if (changeInfo.status !== "complete") return;

  const hostname = hostnameOf(tab.url);
  if (!hostname) return;
  const persistent = await getPersistent();
  // Oldest first, so a later change layers over an earlier one the same way
  // each time.
  const matching = Object.entries(persistent)
    .filter(([, entry]) => entry.hostname === hostname)
    .sort(([, a], [, b]) => a.savedAt - b.savedAt);
  // Then anything that was waiting on this reload (see applyChange).
  const waiting = afterReload.get(tabId);
  afterReload.delete(tabId);
  for (const [id, overlay] of [...matching, ...(waiting ? waiting.items : [])]) {
    await inject(tabId, id, overlay).catch((err) => console.warn(`Web Edit: could not apply ${id}:`, err.message));
  }
  if (waiting) waiting.resolve();
});

// Everything the popup needs about the tab's site: its changes, each marked
// with whether it is active (applied) in this tab and whether it is set to
// always apply. Active ones come first.
async function describeSite(tabId) {
  const tab = await browser.tabs.get(tabId);
  const hostname = hostnameOf(tab.url);
  if (!hostname) return { supported: false, hostname: null, changes: [] };
  const changes = await callServer(`/changes?url=${encodeURIComponent(tab.url)}`);
  const applied = await getApplied();
  const persistent = await getPersistent();

  // An update may have revised an always-on change since its copy was stored.
  let refreshed = false;
  for (const change of changes) {
    const entry = persistent[change.id];
    if (!entry || change.status !== "finished" || !change.updatedAt || entry.version === change.updatedAt) continue;
    try {
      const { output } = await callServer(`/changes/${encodeURIComponent(change.id)}`);
      persistent[change.id] = {
        ...entry,
        css: (output && output.css) || null,
        js: (output && output.js) || null,
        version: change.updatedAt,
      };
      refreshed = true;
    } catch {
      // keep the old copy; the next look will try again
    }
  }
  if (refreshed) await browser.storage.local.set({ persistent });

  const marked = changes.map((change) => {
    const inTab = applied[appliedKey(tabId, change.id)] || null;
    return {
      ...change,
      applied: inTab,
      // Active in this tab, but in a version from before the latest update.
      stale: Boolean(inTab && change.status === "finished" && change.updatedAt && inTab.version !== change.updatedAt),
      persistent: Boolean(persistent[change.id]),
    };
  });
  // The server sends newest first; a stable sort keeps that within each group.
  marked.sort((a, b) => Boolean(b.applied) - Boolean(a.applied));
  return { supported: true, hostname, changes: marked };
}

const handlers = {
  submit: ({ tabId, request }) => submitChange(tabId, request),
  update: ({ id, tabId, request }) => submitUpdate(id, tabId, request),
  site: ({ tabId }) => describeSite(tabId),
  apply: ({ id, tabId }) => applyChange(id, tabId),
  discard: ({ id, tabId }) => discardChange(id, tabId),
  persist: ({ id, tabId, enabled }) => setPersistent(id, tabId, enabled),
  health: () => callServer("/health"),
};

browser.runtime.onMessage.addListener((message) => {
  const handler = handlers[message && message.type];
  if (!handler) return undefined;
  return handler(message).then(
    (result) => ({ ok: true, result }),
    (err) => ({ ok: false, error: err.message }),
  );
});
