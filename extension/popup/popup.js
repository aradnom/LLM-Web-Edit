// The popup is one page with four views, all about the site in the active tab:
//   home     changes active in this tab (plus any still being worked on)
//   changes  every change for the site
//   detail   one change: its controls, the conversation so far, and a box to ask for an update
//   new      describe a new change
// "New change" lives in the header so every view has it.

const viewRoot = document.getElementById("view");
const siteLabel = document.getElementById("site");
const notice = document.getElementById("notice");
const backButton = document.getElementById("back");
const newButton = document.getElementById("newChange");

const POLL_MS = 2000;

const state = {
  tabId: null,
  supported: true,
  hostname: null,
  changes: [],
  loaded: false,
  /** Where we are, and how we got here (for Back). */
  view: "home",
  detailId: null,
  history: [],
  /** Text typed into the new-change box, kept across re-renders. */
  draft: "",
  /** Text typed into the update box on the detail view; belongs to `detailId`. */
  updateDraft: "",
  sending: false,
};

let pollTimer = null;

const send = (message) => browser.runtime.sendMessage(message);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child !== null && child !== false && child !== undefined));
  return node;
}

function showNotice(text, kind = "") {
  notice.textContent = text;
  notice.className = kind;
}

const isWorking = (change) => change.status === "preprocessing" || change.status === "running";
const isApplicable = (change) => change.hasCss || change.hasJs;

const formatWhen = (iso) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

function describeKinds(change) {
  return [change.hasCss && "CSS", change.hasJs && "JS"].filter(Boolean).join(" + ");
}

function describeState(change) {
  if (change.status === "preprocessing") return "Preparing snapshot…";
  if (change.status === "running") return "Claude is working…";
  if (change.status === "error") return "Failed";
  if (!isApplicable(change)) return "Nothing to apply";
  if (change.result && change.result.status === "partial") return "Partial";
  return null;
}

// ---- Navigation ------------------------------------------------------------

function go(view, detailId = null) {
  state.history.push({ view: state.view, detailId: state.detailId });
  if (detailId !== state.detailId) state.updateDraft = "";
  state.view = view;
  state.detailId = detailId;
  showNotice("");
  render();
}

function goBack() {
  const previous = state.history.pop() || { view: "home", detailId: null };
  if (previous.detailId !== state.detailId) state.updateDraft = "";
  state.view = previous.view;
  state.detailId = previous.detailId;
  showNotice("");
  render();
}

// ---- Data ------------------------------------------------------------------

async function refresh() {
  clearTimeout(pollTimer);
  const outcome = await send({ type: "site", tabId: state.tabId });
  state.loaded = true;
  if (outcome.ok) {
    Object.assign(state, outcome.result);
    if (notice.dataset.source === "load") {
      showNotice("");
      delete notice.dataset.source;
    }
  } else {
    showNotice(outcome.error, "error");
    notice.dataset.source = "load";
  }
  render();
  // Keep watching while Claude is working on anything for this site.
  if (state.changes.some(isWorking)) pollTimer = setTimeout(refresh, POLL_MS);
}

async function applyChange(change) {
  // Must be the first thing the click does: Firefox only allows a permission
  // prompt directly from a user action. Resolves straight away when the
  // permission is already held.
  if (change.hasJs && !(await browser.permissions.request({ permissions: ["userScripts"] }))) {
    showNotice("Running generated scripts needs the user scripts permission.", "error");
    return;
  }
  const outcome = await send({ type: "apply", id: change.id, tabId: state.tabId });
  if (outcome.ok) showNotice(outcome.result.reloaded ? "Page reloaded with the updated change." : "");
  else showNotice(outcome.error, "error");
  delete notice.dataset.source;
  await refresh();
}

async function removeChange(change) {
  const outcome = await send({ type: "discard", id: change.id, tabId: state.tabId });
  if (outcome.ok) showNotice(outcome.result.reloaded ? "Page reloaded without the change." : "");
  else showNotice(outcome.error, "error");
  delete notice.dataset.source;
  await refresh();
}

async function setPersistent(change, enabled) {
  // As with Apply, the permission prompt has to come first in the click.
  const allowed = !enabled || !change.hasJs || (await browser.permissions.request({ permissions: ["userScripts"] }));
  if (allowed) {
    const outcome = await send({ type: "persist", id: change.id, tabId: state.tabId, enabled });
    showNotice(outcome.ok ? "" : outcome.error, outcome.ok ? "" : "error");
  } else {
    showNotice("Running generated scripts needs the user scripts permission.", "error");
  }
  delete notice.dataset.source;
  await refresh(); // also puts the checkbox back if the change did not take
}

async function submitNewChange(request) {
  state.sending = true;
  showNotice("Capturing page and sending…");
  render();
  const outcome = await send({ type: "submit", tabId: state.tabId, request });
  state.sending = false;
  if (!outcome.ok) {
    showNotice(outcome.error, "error");
    render();
    return;
  }
  state.draft = "";
  state.updateDraft = "";
  showNotice("");
  // Land on the new change's detail, with Back leading home rather than to the form.
  state.view = "detail";
  state.detailId = outcome.result.id;
  state.history = [];
  await refresh();
}

async function submitUpdate(change, request) {
  state.sending = true;
  showNotice("Capturing page and sending…");
  render();
  const outcome = await send({ type: "update", id: change.id, tabId: state.tabId, request });
  state.sending = false;
  if (outcome.ok) {
    state.updateDraft = "";
    showNotice("");
  } else {
    showNotice(outcome.error, "error");
  }
  delete notice.dataset.source;
  await refresh();
  if (outcome.ok) viewRoot.scrollTop = viewRoot.scrollHeight;
}

// ---- Shared pieces ---------------------------------------------------------

/** Apply/Remove for a change, or nothing if it has nothing to apply. */
function toggleButton(change) {
  if (!isApplicable(change)) return null;
  if (change.stale) {
    return el("button", {
      type: "button",
      textContent: "Apply update",
      title: change.applied.js ? "The old script cannot be un-run, so this reloads the page." : "",
      onclick: () => applyChange(change),
    });
  }
  if (change.applied) {
    return el("button", {
      type: "button",
      textContent: "Remove",
      title: change.applied.js ? "Scripts cannot be un-run, so this reloads the page." : "",
      onclick: () => removeChange(change),
    });
  }
  return el("button", { type: "button", textContent: "Apply", onclick: () => applyChange(change) });
}

function changeRow(change) {
  const meta = [
    describeKinds(change),
    formatWhen(change.createdAt),
    change.persistent && "Always on",
    change.stale && "Update not applied",
    describeState(change),
  ]
    .filter(Boolean)
    .join(" · ");
  return el(
    "li",
    {},
    el(
      "button",
      { type: "button", className: "row-main", onclick: () => go("detail", change.id) },
      el(
        "div",
        { className: "row-name" },
        change.applied ? el("span", { className: "dot", title: "Active in this tab" }) : null,
        change.name,
      ),
      el("div", { className: "row-meta" + (change.status === "error" ? " error" : ""), textContent: meta }),
    ),
    toggleButton(change),
  );
}

const changeList = (changes) => el("ul", { className: "changes" }, ...changes.map(changeRow));

// ---- Views -----------------------------------------------------------------

function renderHome() {
  if (!state.supported) return [el("p", { className: "empty", textContent: "Web Edit works on http and https pages." })];
  if (!state.loaded) return [];

  const active = state.changes.filter((change) => change.applied);
  const working = state.changes.filter(isWorking);
  const total = state.changes.length;

  return [
    working.length > 0 && el("section", {}, el("h2", { textContent: "In progress" }), changeList(working)),
    el(
      "section",
      {},
      el("h2", { textContent: "Active on this page" }),
      active.length > 0
        ? changeList(active)
        : el("p", {
            className: "empty",
            textContent: total > 0 ? "No changes are active in this tab." : "No changes for this site yet.",
          }),
    ),
    total > 0 &&
      el("button", {
        type: "button",
        className: "link",
        textContent: `All changes for this site (${total})`,
        onclick: () => go("changes"),
      }),
  ];
}

function renderChanges() {
  return [
    el(
      "section",
      {},
      el("h2", { textContent: "All changes" }),
      state.changes.length > 0
        ? changeList(state.changes) // already ordered: active first, then newest
        : el("p", { className: "empty", textContent: "No changes for this site yet." }),
    ),
  ];
}

function renderDetail() {
  const change = state.changes.find((candidate) => candidate.id === state.detailId);
  if (!change) return [el("p", { className: "empty", textContent: state.loaded ? "This change no longer exists." : "" })];

  const meta = [
    change.stale ? "Active in this tab (before the latest update)" : change.applied ? "Active in this tab" : "Not active",
    describeKinds(change) || "No files",
    formatWhen(change.createdAt),
  ].join(" · ");

  return [
    el(
      "section",
      {},
      el("p", { className: "detail-name", textContent: change.name }),
      el("p", { className: "detail-meta", textContent: meta }),
    ),
    // Controls sit above the text so they are reachable without scrolling.
    isApplicable(change) &&
      el(
        "div",
        { className: "actions" },
        toggleButton(change),
        // "Apply update" takes the toggle's place, so offer Remove beside it.
        change.stale && el("button", { type: "button", textContent: "Remove", onclick: () => removeChange(change) }),
        el(
          "label",
          { className: "check" },
          el("input", {
            type: "checkbox",
            checked: change.persistent,
            // click, not change: the permission prompt needs a direct user action.
            onclick: (event) => setPersistent(change, event.target.checked),
          }),
          "Always apply on this site",
        ),
      ),
    el("section", { className: "stream" }, ...change.turns.flatMap((turn, index) => turnMessages(change, turn, index))),
    updateForm(change),
  ];
}

/** One request and its answer, as two messages in the stream. */
function turnMessages(change, turn, index) {
  const isLast = index === change.turns.length - 1;
  let label = "Claude";
  let reply;
  if (turn.result) {
    if (turn.result.status !== "done") label += ` · ${turn.result.status}`;
    reply = el("div", { className: "block", textContent: turn.result.message || "(no message)" });
  } else if (turn.error) {
    label += " · failed";
    reply = el("div", { className: "block error", textContent: turn.error });
  } else if (isLast && isWorking(change)) {
    reply = el("div", { className: "block empty", textContent: describeState(change) });
  } else {
    reply = el("div", { className: "block empty", textContent: "(no reply)" });
  }
  return [
    el(
      "div",
      { className: "msg user" },
      el("h2", { textContent: `${index === 0 ? "You" : "You · update"} · ${formatWhen(turn.at)}` }),
      el("div", { className: "block", textContent: turn.request }),
    ),
    el("div", { className: "msg claude" }, el("h2", { textContent: label }), reply),
  ];
}

/** The box under the stream for asking Claude to revise this change. */
function updateForm(change) {
  const busy = state.sending || isWorking(change);
  const field = el("textarea", {
    id: "update",
    rows: 3,
    value: state.updateDraft,
    disabled: busy,
    placeholder: isWorking(change) ? "Claude is working…" : "Ask for an update to this change",
    oninput: () => (state.updateDraft = field.value),
  });
  const submit = () => {
    const request = field.value.trim();
    if (request && !busy) submitUpdate(change, request);
  };
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
  });
  return el(
    "section",
    { className: "update" },
    field,
    el("div", { className: "actions" }, el("button", { type: "button", textContent: "Send update", disabled: busy, onclick: submit })),
  );
}

function renderNew() {
  const field = el("textarea", {
    id: "request",
    rows: 6,
    value: state.draft,
    disabled: state.sending,
    placeholder: "Add a release date sort to the product dropdown",
    oninput: () => (state.draft = field.value),
  });
  const submit = () => {
    const request = field.value.trim();
    if (request && !state.sending) submitNewChange(request);
  };
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) submit();
  });
  // Focus after the node is in the document.
  queueMicrotask(() => field.focus());
  return [
    el("label", { htmlFor: "request", textContent: "What should change on this page?" }),
    field,
    el(
      "div",
      { className: "actions" },
      el("button", { type: "button", textContent: "Send", disabled: state.sending, onclick: submit }),
    ),
  ];
}

const views = { home: renderHome, changes: renderChanges, detail: renderDetail, new: renderNew };

function render() {
  siteLabel.textContent = state.hostname || "Web Edit";
  backButton.hidden = state.view === "home";
  newButton.hidden = state.view === "new" || !state.supported;
  // A background refresh must not rebuild a form that is being typed into;
  // it only needs rebuilding when it switches between editable and sending.
  const field = viewRoot.querySelector("textarea");
  if (state.view === "new" && field && field.disabled === state.sending) return;
  // The detail view is rebuilt under its update box (after Apply, or a poll),
  // so carry the caret across.
  const focused = field && field === document.activeElement ? { start: field.selectionStart, end: field.selectionEnd } : null;
  viewRoot.replaceChildren(...views[state.view]().filter(Boolean));
  const rebuilt = viewRoot.querySelector("textarea#update");
  if (focused && rebuilt && !rebuilt.disabled) {
    rebuilt.focus();
    rebuilt.setSelectionRange(focused.start, focused.end);
  }
}

// ---- Wiring ----------------------------------------------------------------

backButton.addEventListener("click", goBack);
newButton.addEventListener("click", () => go("new"));

document.getElementById("options").addEventListener("click", (event) => {
  event.preventDefault();
  browser.runtime.openOptionsPage();
});

// The popup belongs to one tab for its whole life: it closes on any tab switch.
browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
  state.tabId = tab.id;
  refresh();
});
