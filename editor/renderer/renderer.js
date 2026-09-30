const log = document.getElementById("log");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendButton = document.getElementById("send");
const stopButton = document.getElementById("stop");
const modelSelect = document.getElementById("model-select");
const effortSelect = document.getElementById("effort-select");
const usageBar = document.getElementById("usage");
const activityLabel = document.getElementById("activity");

// Long-running tools get a status bar note, since the camera moves on its own while they run.
const ACTIVITY = {
  look_at_scene: "Agent is looking at the scene…",
  request_review: "Critic is reviewing…",
};
const activeTools = new Map();

function refreshActivity() {
  const latest = [...activeTools.values()].pop();
  activityLabel.hidden = !latest;
  activityLabel.replaceChildren(icon("spinner", "spin"), latest ?? "");
}
const mode3dButton = document.getElementById("mode-3d");
const mode2dButton = document.getElementById("mode-2d");
const headingLabel = document.getElementById("camera-heading");
const viewerDot = document.getElementById("viewer-dot");
const viewerLabel = document.getElementById("viewer-label");
const viewport = document.getElementById("viewport");
const viewportMessage = document.getElementById("viewport-message");
const propList = document.getElementById("prop-list");
const propCount = document.getElementById("prop-count");
const mapName = document.getElementById("map-name");
const unsavedMark = document.getElementById("unsaved");
const undoButton = document.getElementById("undo");
const redoButton = document.getElementById("redo");
const exportForm = document.getElementById("export-form");
const exportName = document.getElementById("export-name");

// An icon from the sprite in index.html.
function icon(name, className = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `icon ${className}`.trim());
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

// A borderless icon button; the action doesn't bubble to the row it sits in.
function iconButton(name, title, onClick, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-btn small ${className}`.trim();
  button.title = title;
  button.appendChild(icon(name));
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return button;
}

// ---------- toasts ----------

const toastBox = document.getElementById("toasts");
const TOAST_ICONS = { info: "sparkles", success: "check", warning: "alert", error: "alert" };
// How long each kind stays; errors stay until closed.
const TOAST_MS = { info: 4000, success: 4000, warning: 8000, error: 0 };

// A short message in the corner. level: info | success | warning | error. action: { label, run }.
function toast(level, title, message, action) {
  const el = document.createElement("div");
  el.className = `toast ${level}`;
  el.setAttribute("role", level === "error" ? "alert" : "status");
  const text = document.createElement("div");
  text.className = "toast-text";
  const head = document.createElement("div");
  head.className = "toast-title";
  head.textContent = title;
  text.appendChild(head);
  if (message) {
    const body = document.createElement("div");
    body.className = "toast-message";
    body.textContent = message;
    text.appendChild(body);
  }
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      action.run();
      close();
    });
    text.appendChild(button);
  }
  const closeButton = iconButton("x", "Dismiss", () => close());
  el.append(icon(TOAST_ICONS[level] ?? "sparkles", "toast-icon"), text, closeButton);
  el.title = "Click to see all notifications";
  text.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    close();
    setChatView("notifications");
  });
  recordNotification(level, title, message);

  let timer = null;
  const arm = () => {
    if (TOAST_MS[level]) timer = setTimeout(close, TOAST_MS[level]);
  };
  function close() {
    clearTimeout(timer);
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 180);
  }
  el.addEventListener("mouseenter", () => clearTimeout(timer)); // reading it shouldn't make it vanish
  el.addEventListener("mouseleave", arm);

  toastBox.appendChild(el);
  while (toastBox.children.length > 4) toastBox.firstElementChild.remove();
  arm();
  return close;
}

// ---------- notification history ----------

// Everything shown as a toast, newest first, kept across restarts so what happened earlier can be looked up.
const NOTIFICATIONS_KEY = "notifications";
const MAX_NOTIFICATIONS = 200;
let notifications = [];
try {
  notifications = JSON.parse(localStorage.getItem(NOTIFICATIONS_KEY) ?? "[]");
} catch {
  notifications = [];
}
let notificationFilter = "all";
const notificationsView = document.getElementById("notifications-view");
const notificationList = document.getElementById("notif-list");
const notificationsButton = document.getElementById("open-notifications");
const notificationBadge = document.getElementById("notif-badge");

function saveNotifications() {
  localStorage.setItem(NOTIFICATIONS_KEY, JSON.stringify(notifications.slice(0, MAX_NOTIFICATIONS)));
}

function recordNotification(level, title, message) {
  notifications.unshift({
    time: Date.now(),
    level,
    title,
    message: message ?? "",
    project: typeof currentProjectName === "function" ? currentProjectName() : "",
    read: chatView === "notifications",
  });
  notifications.length = Math.min(notifications.length, MAX_NOTIFICATIONS);
  saveNotifications();
  renderNotificationBadge();
  if (chatView === "notifications") renderNotifications();
}

// Unread count, coloured by the worst unread level.
function renderNotificationBadge() {
  const unread = notifications.filter((n) => !n.read);
  notificationBadge.hidden = unread.length === 0;
  notificationBadge.textContent = unread.length > 99 ? "99+" : String(unread.length);
  const worst = unread.some((n) => n.level === "error") ? "error" : unread.some((n) => n.level === "warning") ? "warning" : "";
  notificationBadge.className = `notif-badge ${worst}`;
  notificationsButton.title = unread.length ? `Notifications (${unread.length} unread)` : "Notifications";
}

function markNotificationsRead() {
  if (!notifications.some((n) => !n.read)) return;
  for (const n of notifications) n.read = true;
  saveNotifications();
  renderNotificationBadge();
}

function dayLabel(time) {
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  if (time >= startOfToday) return "Today";
  if (time >= startOfToday - 86400000) return "Yesterday";
  return new Date(time).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

function renderNotifications() {
  const shown = notificationFilter === "problems" ? notifications.filter((n) => n.level === "error" || n.level === "warning") : notifications;
  notificationList.replaceChildren();
  if (!shown.length) {
    const empty = document.createElement("li");
    empty.className = "notif-empty";
    empty.append(icon("bell"), notificationFilter === "problems" ? "No warnings or errors." : "No notifications yet.");
    notificationList.appendChild(empty);
    return;
  }
  let day = null;
  for (const n of shown) {
    const label = dayLabel(n.time);
    if (label !== day) {
      day = label;
      const header = document.createElement("li");
      header.className = "notif-day";
      header.textContent = label;
      notificationList.appendChild(header);
    }
    const li = document.createElement("li");
    li.className = `notif ${n.level}`;
    const text = document.createElement("div");
    text.className = "notif-text";
    const title = document.createElement("div");
    title.className = "notif-title";
    title.textContent = n.title;
    text.appendChild(title);
    if (n.message) {
      const message = document.createElement("div");
      message.className = "notif-message";
      message.textContent = n.message;
      text.appendChild(message);
    }
    const meta = document.createElement("div");
    meta.className = "notif-meta";
    meta.textContent = [new Date(n.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), n.project].filter(Boolean).join(" · ");
    text.appendChild(meta);
    li.append(icon(TOAST_ICONS[n.level] ?? "sparkles", "notif-icon"), text);
    notificationList.appendChild(li);
  }
}

for (const button of document.querySelectorAll("#notif-filter button")) {
  button.addEventListener("click", () => {
    notificationFilter = button.dataset.filter;
    for (const b of document.querySelectorAll("#notif-filter button")) b.classList.toggle("active", b === button);
    renderNotifications();
  });
}

document.getElementById("notif-clear").addEventListener("click", () => {
  notifications = [];
  saveNotifications();
  renderNotificationBadge();
  renderNotifications();
});

const toolCards = new Map();
let busy = false;
let thinkingEl = null;
let undoSteps = 0;
let redoSteps = 0;
let editingTree = false; // pause periodic refreshes while a name is being typed
const collapsedFolders = new Set();

function scrollToEnd() {
  log.scrollTop = log.scrollHeight;
}

function append(el) {
  if (thinkingEl && el !== thinkingEl) log.insertBefore(el, thinkingEl);
  else log.appendChild(el);
  scrollToEnd();
}

function setBusy(value) {
  busy = value;
  undoButton.disabled = value || undoSteps === 0;
  redoButton.disabled = value || redoSteps === 0;
  sendButton.disabled = value;
  stopButton.disabled = !value;
  sendButton.hidden = value;
  stopButton.hidden = !value;
  if (value && !thinkingEl) {
    thinkingEl = document.createElement("div");
    thinkingEl.className = "thinking";
    thinkingEl.append(icon("spinner", "spin"), "Working…");
    log.appendChild(thinkingEl);
    scrollToEnd();
  } else if (!value && thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
  }
}

function fmt(n) {
  return Number.isFinite(n) ? Number(n.toFixed(2)).toString() : "?";
}

function describeTool(name, args) {
  switch (name) {
    case "search_props":
      return `searching "${args.query}"`;
    case "place_prop": {
      const side = args.right === 0 ? "" : args.right > 0 ? `, ${fmt(args.right)}m right` : `, ${fmt(-args.right)}m left`;
      const up = args.up ? `, ${fmt(args.up)}m up` : "";
      const folder = args.folder ? ` → ${args.folder}` : "";
      return `${args.model} · ${fmt(args.forward)}m ahead${side}${up}, ${fmt(args.heading ?? 0)}°${folder}`;
    }
    case "check_props":
      return args.ids?.length ? args.ids.map((id) => `#${id}`).join(", ") : "whole map";
    case "look_at_scene":
      return `${(args.views ?? settings?.look.views ?? []).join(", ")}${args.ids?.length ? ` · ${args.ids.length} props` : ""}`;
    case "request_review":
      return `${args.checklist?.length ?? 0}-item checklist · ${args.ids?.length ?? 0} props`;
    case "undo_last_change":
      return "changes from the previous request";
    case "redo_last_undo":
      return "last undone change";
    case "set_folder":
      return `${(args.ids ?? []).map((id) => `#${id}`).join(", ")} → ${args.folder ?? "no folder"}`;
    case "set_visibility": {
      const target = args.folder ? `folder "${args.folder}"` : (args.ids ?? []).map((id) => `#${id}`).join(", ");
      return `${args.visible ? "show" : "hide"} ${target}`;
    }
    case "export_map":
      return `${EXPORT_LABELS[args.target] ?? args.target} · ${args.name}`;
    case "list_props":
      return args.radius ? `props within ${fmt(args.radius)}m` : "all props";
    case "move_prop": {
      const parts = [];
      if (args.north) parts.push(args.north > 0 ? `${fmt(args.north)}m north` : `${fmt(-args.north)}m south`);
      if (args.east) parts.push(args.east > 0 ? `${fmt(args.east)}m east` : `${fmt(-args.east)}m west`);
      if (args.forward) parts.push(args.forward > 0 ? `${fmt(args.forward)}m ahead` : `${fmt(-args.forward)}m back`);
      if (args.right) parts.push(args.right > 0 ? `${fmt(args.right)}m right` : `${fmt(-args.right)}m left`);
      if (args.up) parts.push(args.up > 0 ? `${fmt(args.up)}m up` : `${fmt(-args.up)}m down`);
      if (args.face_id !== undefined) parts.push(`face #${args.face_id}`);
      if (args.world_heading !== undefined) parts.push(`heading ${fmt(args.world_heading)}°`);
      if (args.turn) parts.push(`turn ${fmt(args.turn)}°`);
      return `#${args.id} · ${parts.join(", ") || "no change"}`;
    }
    case "delete_prop":
      return `#${args.id}`;
    case "get_camera_view":
      return "camera position";
    case "save_map":
      return `saving as ${args.name}.ymap`;
    default:
      return JSON.stringify(args);
  }
}

const TOOL_LABELS = {
  search_props: "Search props",
  place_prop: "Place",
  list_props: "List props",
  move_prop: "Move",
  delete_prop: "Delete",
  check_props: "Check",
  look_at_scene: "Look at scene",
  request_review: "Critic",
  undo_last_change: "Undo",
  redo_last_undo: "Redo",
  set_folder: "Move to folder",
  set_visibility: "Visibility",
  export_map: "Export",
  get_camera_view: "Camera",
  save_map: "Save",
};

const TOOL_ICONS = {
  search_props: "search",
  place_prop: "pin-map",
  list_props: "list",
  move_prop: "move",
  delete_prop: "trash",
  check_props: "list-checks",
  look_at_scene: "camera",
  request_review: "shield",
  undo_last_change: "undo",
  redo_last_undo: "redo",
  set_folder: "folder",
  set_visibility: "eye",
  export_map: "export",
  get_camera_view: "focus",
};

function onToolUse({ id, name, input: args }, replay = false) {
  const card = document.createElement("details");
  card.className = "tool";
  const summary = document.createElement("summary");
  const label = document.createElement("span");
  label.className = "name";
  label.textContent = TOOL_LABELS[name] ?? name;
  const desc = document.createElement("span");
  desc.className = "desc";
  desc.textContent = describeTool(name, args ?? {});
  const note = document.createElement("span");
  note.className = "note";
  const status = icon(replay ? "check" : "spinner", `tool-status ${replay ? "" : "spin"}`);
  summary.append(icon(TOOL_ICONS[name] ?? "tool", "tool-icon"), label, desc, note, status);
  summary.title = `${label.textContent} · ${desc.textContent}`;
  const body = document.createElement("pre");
  body.textContent = JSON.stringify(args, null, 2);
  card.append(summary, body);
  toolCards.set(id, { card, summary, body, name, note, status });
  append(card);
  if (ACTIVITY[name] && !replay) {
    activeTools.set(id, ACTIVITY[name]);
    refreshActivity();
  }
}

// Images go right under the summary, before the raw arguments.
// Cards with images or a review show those; the raw arguments and result stay behind a toggle.
function makeRich(card) {
  if (card.classList.contains("rich")) return;
  card.classList.add("rich");
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "raw-toggle";
  toggle.textContent = "Raw data";
  toggle.addEventListener("click", () => card.classList.toggle("show-raw"));
  card.querySelector("pre").before(toggle);
}

function addShots(card, images) {
  const shots = document.createElement("div");
  shots.className = "shots";
  for (const src of images) {
    const img = document.createElement("img");
    img.src = src;
    img.addEventListener("click", () => img.classList.toggle("expanded"));
    shots.appendChild(img);
  }
  card.querySelector("summary").after(shots);
  makeRich(card);
  card.open = true;
}

function addReview(card, verdict) {
  const box = document.createElement("div");
  box.className = "review";
  const head = document.createElement("div");
  head.className = "review-head";
  const badge = document.createElement("span");
  badge.className = `review-badge ${verdict.pass ? "pass" : "fail"}`;
  badge.textContent = verdict.pass ? "Passed" : "Failed";
  const summary = document.createElement("span");
  summary.textContent = verdict.summary;
  head.append(badge, summary);
  const list = document.createElement("ul");
  const row = (className, iconName, text) => {
    const li = document.createElement("li");
    li.className = className;
    const span = document.createElement("span");
    span.textContent = text;
    li.append(icon(iconName), span);
    list.appendChild(li);
  };
  for (const item of verdict.checklist ?? []) {
    row(item.met ? "met" : "unmet", item.met ? "check" : "x", `${item.item}${item.note ? ` — ${item.note}` : ""}`);
  }
  for (const issue of verdict.issues ?? []) {
    row("issue", "alert", `${issue.ids.map((id) => `#${id}`).join(", ")}: ${issue.problem} → ${issue.fix}`);
  }
  box.append(head, list);
  card.querySelector("summary").after(box);
  makeRich(card);
  card.open = !verdict.pass;
}

const ISSUE_LABELS = {
  overlap: "overlaps another prop",
  world_collision: "clips into the world",
  floating: "floating",
  overhang: "overhangs an edge",
  buried: "buried",
  steep_ground: "steep ground",
  no_ground: "no ground below",
};

function describeIssues(issues = []) {
  return [...new Set(issues.map((issue) => ISSUE_LABELS[issue.type] ?? issue.type))].join(", ");
}

const STATUS_ICONS = { ok: "check", warn: "alert", err: "x" };

function setToolStatus(entry, status, note) {
  entry.done = true;
  entry.card.classList.add(status);
  entry.status.replaceWith((entry.status = icon(STATUS_ICONS[status], "tool-status")));
  entry.note.textContent = note;
  if (note) entry.summary.title += ` — ${note}`;
}

// Steps still waiting for a result when a turn ends (stopped, or cut off) stop spinning.
function finishPendingTools() {
  for (const entry of toolCards.values()) {
    if (entry.done) continue;
    entry.done = true;
    entry.card.classList.add("unfinished");
    entry.status.replaceWith((entry.status = icon("x", "tool-status")));
    entry.note.textContent = "not finished";
  }
}

function onToolResult({ id, isError, text, images }) {
  if (activeTools.delete(id)) refreshActivity();
  const entry = toolCards.get(id);
  if (!entry) return;
  if (!isError && images?.length) addShots(entry.card, images);
  if (!isError && entry.name === "request_review") {
    try {
      const verdict = JSON.parse(text);
      addReview(entry.card, verdict);
      setToolStatus(entry, verdict.pass ? "ok" : "warn", `${verdict.pass ? "passed" : "failed"} · ${verdict.round}/${verdict.maxRounds}`);
      return;
    } catch {}
  }
  let status = isError ? "err" : "ok";
  let note = "";
  if (!isError && (entry.name === "place_prop" || entry.name === "move_prop")) {
    try {
      const result = JSON.parse(text);
      if (result.grounded === false) {
        status = "warn";
        note = "no ground found, floating";
      } else if (result.validation && !result.validation.ok) {
        status = "warn";
        note = describeIssues(result.validation.issues) || "check could not complete";
      }
    } catch {}
  }
  if (!isError && entry.name === "check_props") {
    try {
      const result = JSON.parse(text);
      status = result.problems.length ? "warn" : "ok";
      note = result.problems.length ? `problems on ${result.problems.length} props` : "no problems";
    } catch {
      note = "no problems";
    }
  }
  if (!isError && entry.name === "search_props") {
    try {
      note = `${JSON.parse(text).length} results`;
    } catch {
      note = "no results";
    }
  }
  if (isError) note = text.slice(0, 120);
  setToolStatus(entry, status, note);
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {}
  entry.body.textContent += `\n\n→ ${pretty}`;
}

// A copy button for a chat message; appears on hover.
function copyButton(text) {
  const button = iconButton("copy", "Copy", async () => {
    await window.editor.copyText(text);
    button.replaceChildren(icon("check"));
    setTimeout(() => button.replaceChildren(icon("copy")), 1200);
  }, "copy");
  return button;
}

function addUserMessage(text) {
  const el = document.createElement("div");
  el.className = "msg user";
  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = text;
  el.append(body, copyButton(text));
  append(el);
  return el;
}

function addAssistantMessage(text) {
  const el = document.createElement("div");
  el.className = "msg assistant";
  const body = document.createElement("div");
  body.className = "msg-body markdown";
  body.innerHTML = renderMarkdown(text);
  el.append(body, copyButton(text));
  append(el);
}

function addError(text) {
  const el = document.createElement("div");
  el.className = "error";
  const span = document.createElement("span");
  span.textContent = text;
  el.append(icon("alert"), span);
  append(el);
}

// Renders one event, live or from a reopened chat's history (replay: no status bar or busy state changes).
function handleEvent(event, replay = false) {
  switch (event.kind) {
    case "ready":
      modelSelect.title = `In use: ${event.model}`;
      break;
    case "thread":
      onThreadStarted(event.id);
      break;
    case "user":
      addUserMessage(event.text);
      break;
    case "interrupted":
      notice("Stopped.");
      break;
    case "usage":
      usage.turn = event.turn;
      usage.session = event.session;
      renderUsage();
      break;
    case "context":
      usage.context = event;
      renderUsage();
      break;
    case "rate_limit":
      usage.rateLimit = event;
      renderUsage();
      break;
    case "text":
      addAssistantMessage(event.text);
      break;
    case "tool_use":
      onToolUse(event, replay);
      break;
    case "tool_result":
      onToolResult(event);
      break;
    case "done":
      setBusy(false);
      finishPendingTools();
      activeTools.clear();
      refreshActivity();
      refreshState();
      onTurnDone();
      if (!event.ok && event.error) {
        addError(event.error);
        if (!replay) toast("error", "The agent stopped with an error", event.error);
      }
      break;
    case "fatal":
      setBusy(false);
      addError(`Agent failed to start: ${event.message}`);
      toast("error", "The agent couldn't start", event.message);
      break;
    case "notify":
      if (!replay) toast(event.level, event.title, event.message);
      break;
  }
}

window.editor.onEvent((event) => handleEvent(event));

// Empties the conversation view (for a new or a different chat).
function clearChat() {
  setBusy(false);
  toolCards.clear();
  activeTools.clear();
  refreshActivity();
  log.replaceChildren();
  usage.turn = usage.session = usage.context = null; // each conversation has its own totals
  renderUsage();
}

const SUGGESTIONS = [
  "Set up a camp in front of me: a fire in the middle, 3 benches around it, 2 tents behind.",
  "Build a small roadside checkpoint with barriers, cones and a tent.",
  "Turn this spot into a picnic area with tables, benches and trash cans.",
];

// The empty-chat screen: what the app does and a few requests to start from.
function showWelcome() {
  const box = document.createElement("div");
  box.className = "welcome";
  const logo = document.createElement("img");
  logo.src = "../assets/icon.png";
  logo.alt = "";
  const title = document.createElement("div");
  title.className = "welcome-title";
  title.textContent = appInfo?.name ?? "";
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent = "Click the 3D view and fly the camera with WASD and the mouse to where you want to build, then describe what you want.";
  const chips = document.createElement("div");
  chips.className = "suggestions";
  for (const text of SUGGESTIONS) {
    const chip = document.createElement("button");
    chip.type = "button";
    const label = document.createElement("span");
    label.textContent = text;
    chip.append(icon("sparkles"), label);
    chip.addEventListener("click", () => {
      input.value = text;
      input.focus();
    });
    chips.appendChild(chip);
  }
  box.append(logo, title, hint, chips);
  log.appendChild(box);
}

// The composer grows with its text, up to a limit.
function fitInput() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
}
input.addEventListener("input", fitInput);

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  const welcome = log.querySelector(".welcome");
  welcome?.remove();
  const bubble = addUserMessage(text);
  input.value = "";
  fitInput();
  setBusy(true);
  window.editor.send(text).catch((err) => {
    // Not sent: take the message back so nothing is lost.
    setBusy(false);
    bubble?.remove();
    if (welcome && !log.querySelector(".msg")) log.prepend(welcome);
    input.value = text;
    fitInput();
    toast("error", "Message not sent", errorMessage(err));
  });
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

stopButton.addEventListener("click", () => window.editor.interrupt());

// ---------- map actions ----------

// ipcRenderer.invoke wraps errors as "Error invoking remote method '...': Error: <message>".
function errorMessage(err) {
  return String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}

function notice(text, action) {
  const el = document.createElement("div");
  el.className = "notice";
  el.textContent = text;
  if (action) {
    const button = document.createElement("button");
    button.textContent = action.label;
    button.addEventListener("click", action.run);
    el.appendChild(button);
  }
  append(el);
}

async function runMapAction(action) {
  try {
    await action();
  } catch (err) {
    toast("error", "That didn't work", errorMessage(err));
  } finally {
    refreshState();
  }
}

async function undo() {
  if (busy || undoSteps === 0) return;
  await runMapAction(async () => {
    const result = await window.editor.undo();
    toast("info", "Undone", `${result.reverted} change${result.reverted === 1 ? "" : "s"} reverted. Ctrl+Y redoes.`);
  });
}

async function redo() {
  if (busy || redoSteps === 0) return;
  await runMapAction(async () => {
    const result = await window.editor.redo();
    toast("info", "Redone", `${result.reverted} change${result.reverted === 1 ? "" : "s"} restored.`);
  });
}

undoButton.addEventListener("click", undo);
redoButton.addEventListener("click", redo);

document.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement;
  if (typing || !e.ctrlKey) return;
  const key = e.key.toLowerCase();
  if (key === "z" && !e.shiftKey) {
    e.preventDefault();
    undo();
  } else if (key === "y" || (key === "z" && e.shiftKey)) {
    e.preventDefault();
    redo();
  }
});

document.getElementById("new-folder").addEventListener("click", (e) => {
  e.preventDefault();
  startNameEdit(propList, "", async (name) => {
    await window.editor.createFolder(name);
  });
});

const exportTarget = document.getElementById("export-target");
const exportTargetHint = document.getElementById("export-target-hint");
const EXPORT_LABELS = {};
let exportTargets = [];

async function loadExportTargets() {
  exportTargets = await window.editor.exportTargets();
  exportTarget.replaceChildren(...exportTargets.map((t) => new Option(t.label, t.id)));
  for (const t of exportTargets) EXPORT_LABELS[t.id] = t.label;
  exportTarget.value = settings?.export?.target ?? exportTargets[0]?.id;
  showExportTargetHint();
}

function showExportTargetHint() {
  exportTargetHint.textContent = exportTargets.find((t) => t.id === exportTarget.value)?.description ?? "";
}

exportTarget.addEventListener("change", showExportTargetHint);

document.getElementById("export").addEventListener("click", () => {
  exportForm.hidden = !exportForm.hidden;
  if (exportForm.hidden) return;
  if (!exporting) exportStatus.hidden = true;
  if (!exportName.value) exportName.value = mapName.dataset.slug ?? "";
  exportName.focus();
});

document.getElementById("export-cancel").addEventListener("click", () => (exportForm.hidden = true));

const exportSubmit = document.getElementById("export-submit");
const exportStatus = document.getElementById("export-status");
let exporting = false;

function showExportStatus(kind, text, action) {
  exportStatus.hidden = false;
  exportStatus.className = `form-status ${kind}`;
  exportStatus.replaceChildren();
  const label = document.createElement("span");
  label.textContent = text;
  exportStatus.appendChild(label);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", action.run);
    exportStatus.appendChild(button);
  }
}

exportForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (exporting) return;
  const name = exportName.value.trim();
  if (!/^[a-z0-9_-]+$/.test(name)) {
    showExportStatus("err", name ? "Invalid name: use only lowercase letters, digits, _ and -." : "Enter a name.");
    exportName.focus();
    return;
  }

  exporting = true;
  exportSubmit.disabled = true;
  exportSubmit.textContent = "Exporting…";
  const target = exportTarget.value;
  showExportStatus("working", `Saving the map and exporting for ${EXPORT_LABELS[target] ?? target}…`);
  try {
    const result = await window.editor.exportMap(name, target);
    showExportStatus("ok", `Done: ${result.entityCount} props → ${result.path}. ${result.nextSteps}`, {
      label: "Show",
      run: () => window.editor.showFolder(result.path),
    });
  } catch (err) {
    showExportStatus("err", `Export failed: ${errorMessage(err)}`);
  } finally {
    exporting = false;
    exportSubmit.disabled = false;
    exportSubmit.textContent = "Export";
    refreshState();
  }
});

// ---------- model and usage ----------

const usage = { turn: null, session: null, context: null, rateLimit: null };

function tokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const LIMIT_LABELS = {
  five_hour: "5-hour limit",
  seven_day: "Weekly limit",
  seven_day_opus: "Weekly Opus limit",
  seven_day_sonnet: "Weekly Sonnet limit",
};

// pct: draws a small meter after the text.
function usagePart(text, title, cls, pct) {
  const span = document.createElement("span");
  span.append(text);
  if (pct !== undefined) {
    const meter = document.createElement("span");
    meter.className = "meter";
    const fill = document.createElement("i");
    fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    meter.appendChild(fill);
    span.appendChild(meter);
  }
  if (title) span.title = title;
  if (cls) span.className = cls;
  return span;
}

function renderUsage() {
  const parts = [];
  if (usage.turn) {
    const t = usage.turn;
    const sent = t.input + t.cacheRead + t.cacheWrite;
    parts.push(
      usagePart(
        `Last: ${tokens(sent)} in · ${tokens(t.output)} out`,
        `Cache read: ${tokens(t.cacheRead)}\nCache write: ${tokens(t.cacheWrite)}\nUncached input: ${tokens(t.input)}\n(Main loop only)`,
      ),
    );
  }
  if (usage.session) {
    const s = usage.session;
    const total = s.input + s.cacheRead + s.cacheWrite + s.output;
    parts.push(
      usagePart(
        `Chat: ${tokens(total)} · ≈$${s.costUsd.toFixed(2)}`,
        "Total for this chat. The amount is an estimate at API list prices; on a subscription it isn't billed separately but counts against your plan limits.",
      ),
    );
  }
  if (usage.context) {
    const c = usage.context;
    const pct = Math.round(c.percentage);
    parts.push(
      usagePart(`Context ${pct}%`, `${tokens(c.usedTokens)} / ${tokens(c.maxTokens)} tokens. When full, older messages are summarized; "New chat" resets it.`, pct >= 80 ? "warn" : "", pct),
    );
  }
  if (usage.rateLimit && usage.rateLimit.utilization !== undefined) {
    const r = usage.rateLimit;
    const pct = Math.round(r.utilization <= 1 ? r.utilization * 100 : r.utilization);
    const resets = r.resetsAt ? `\nResets: ${new Date(r.resetsAt * 1000).toLocaleString("en-GB")}` : "";
    const cls = r.status === "rejected" ? "err" : r.status === "allowed_warning" ? "warn" : "";
    parts.push(usagePart(`${LIMIT_LABELS[r.limitType] ?? "Plan limit"} ${pct}%`, `Status: ${r.status}${resets}`, cls, pct));
  }
  usageBar.replaceChildren(...parts);
  usageBar.hidden = parts.length === 0;
}

// ---------- settings ----------

let settings = null; // as saved by the main process
let models = []; // ModelInfo[] for the signed-in account

const EFFORT_LABELS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
const VIEW_LABELS = { top: "Top", north: "North", east: "East", south: "South", west: "West", eye_level: "Eye level" };
const CAMERA_KEYS = ["moveSpeed", "sensitivity", "smoothing", "fovDegrees"];
const DEFAULT_CAMERA = { moveSpeed: 1, sensitivity: 1, smoothing: 10, fovDegrees: 57, invertMouse: false };

const settingsView = document.getElementById("settings-view");
const settingsStatus = document.getElementById("settings-status");
const settingsButton = document.getElementById("open-settings");
const criticEnabled = document.getElementById("set-critic-enabled");
const criticModel = document.getElementById("set-critic-model");
const criticEffort = document.getElementById("set-critic-effort");
const criticRounds = document.getElementById("set-critic-rounds");
const criticTurns = document.getElementById("set-critic-turns");
const lookViews = document.getElementById("set-look-views");

// Saves a partial change (null = back to default); the main process applies it and returns what was stored.
async function saveSettings(patch) {
  try {
    const result = await window.editor.updateSettings(patch);
    settings = result.settings;
    showSettingsError(result.applyError);
  } catch (err) {
    showSettingsError(errorMessage(err));
  }
  renderSettings();
}

function showSettingsError(message) {
  settingsStatus.hidden = !message;
  settingsStatus.textContent = message ?? "";
  if (message && chatView !== "settings") toast("warning", "Setting saved but not applied", message);
}

const modelInfo = (value) => models.find((m) => m.value === (value ?? "default"));
const effortLevels = (model) => (model?.supportsEffort ? model.supportedEffortLevels ?? [] : []);

function fillModelSelect(select, first) {
  select.replaceChildren();
  if (first) select.appendChild(new Option(first.label, first.value));
  for (const model of models) {
    const label = model.value === "default" ? `Default (${model.description.split(" · ")[0]})` : model.displayName;
    const option = new Option(label, model.value);
    option.title = model.description;
    select.appendChild(option);
  }
}

// Offers only the levels the model supports. A saved level it doesn't support shows as the default,
// which is also what the model falls back to.
function fillEffortSelect(select, model, selected, defaultLabel) {
  const levels = effortLevels(model);
  select.replaceChildren(new Option(defaultLabel, "default"));
  for (const level of levels) select.appendChild(new Option(EFFORT_LABELS[level] ?? level, level));
  select.value = selected && levels.includes(selected) ? selected : "default";
  select.disabled = levels.length === 0;
  select.title = levels.length ? "How much the model thinks" : "This model has no reasoning levels";
}

async function loadModels() {
  try {
    [models, settings] = await Promise.all([window.editor.models(), window.editor.getSettings()]);
    fillModelSelect(modelSelect);
    fillModelSelect(criticModel, { label: "Same as builder", value: "same" });
    modelSelect.disabled = false;
  } catch (err) {
    modelSelect.replaceChildren(new Option("Couldn't load models"));
    modelSelect.title = errorMessage(err);
    settings ??= await window.editor.getSettings().catch(() => null);
  }
  renderSettings();
}

function renderSettings() {
  if (!settings) return;

  if (models.length) {
    // A saved model that the account no longer offers falls back to the default entry.
    modelSelect.value = modelInfo(settings.model) ? settings.model ?? "default" : "default";
    fillEffortSelect(effortSelect, modelInfo(modelSelect.value), settings.effort, "Default");
  }

  const c = settings.critic;
  criticEnabled.checked = c.enabled;
  const sameModel = !c.model || !modelInfo(c.model);
  criticModel.value = sameModel ? "same" : c.model;
  fillEffortSelect(
    criticEffort,
    modelInfo(sameModel ? modelSelect.value : c.model),
    c.effort,
    sameModel ? "Same as builder" : "Default",
  );
  criticRounds.value = c.maxRounds;
  criticTurns.value = c.maxTurns;
  criticModel.disabled = !c.enabled || models.length === 0;
  criticRounds.disabled = criticTurns.disabled = !c.enabled;
  if (!c.enabled) criticEffort.disabled = true;
  for (const el of [criticModel, criticEffort, criticRounds, criticTurns]) {
    el.closest(".setting").classList.toggle("disabled", !c.enabled);
  }

  for (const box of lookViews.querySelectorAll("input")) box.checked = settings.look.views.includes(box.value);

  for (const key of CAMERA_KEYS) {
    const input = document.getElementById(`set-camera-${key}`);
    input.value = settings.camera[key];
    formatRange(input);
  }
  document.getElementById("set-camera-invertMouse").checked = settings.camera.invertMouse;
}

function formatRange(input) {
  const output = settingsView.querySelector(`output[data-for="${input.id}"]`);
  const value = Number(input.value);
  const format = output.dataset.format;
  output.textContent = format === "x" ? `${value.toFixed(1)}x` : `${value}${format ?? ""}`;
}

// The chat panel shows the chat, the settings or the notifications. Nothing can be drawn over the 3D view, so
// the other two take the chat's place.
let chatView = "chat";
const VIEW_TITLES = { settings: "Settings", notifications: "Notifications" };

function setChatView(view) {
  chatView = view;
  const chat = view === "chat";
  settingsView.hidden = view !== "settings";
  notificationsView.hidden = view !== "notifications";
  log.hidden = !chat;
  showComposer(chat);
  document.getElementById("new-chat").hidden = !chat;
  document.getElementById("close-settings").hidden = chat;
  chatTitleEl.textContent = chat ? chatTitle : VIEW_TITLES[view];
  settingsButton.classList.toggle("active", view === "settings");
  notificationsButton.classList.toggle("active", view === "notifications");
  if (view === "settings") renderSettings();
  if (view === "notifications") {
    markNotificationsRead();
    renderNotifications();
  }
  if (chat) scrollToEnd();
}

function setSettingsOpen(open) {
  setChatView(open ? "settings" : "chat");
}

settingsButton.addEventListener("click", () => setChatView(chatView === "settings" ? "chat" : "settings"));
notificationsButton.addEventListener("click", () => setChatView(chatView === "notifications" ? "chat" : "notifications"));
document.getElementById("close-settings").addEventListener("click", () => setChatView("chat"));
renderNotificationBadge();

modelSelect.addEventListener("change", async () => {
  const label = modelSelect.selectedOptions[0].textContent;
  const patch = { model: modelSelect.value === "default" ? null : modelSelect.value };
  // Keep the reasoning level only if the new model has it.
  if (settings.effort && !effortLevels(modelInfo(modelSelect.value)).includes(settings.effort)) patch.effort = null;
  await saveSettings(patch);
  toast("info", `Model: ${label}`, "Applies from the next reply; the chat is kept.");
});

effortSelect.addEventListener("change", async () => {
  const label = effortSelect.selectedOptions[0].textContent;
  await saveSettings({ effort: effortSelect.value === "default" ? null : effortSelect.value });
  toast("info", `Reasoning: ${label}`, "Applies from the next reply.");
});

criticEnabled.addEventListener("change", () => saveSettings({ critic: { enabled: criticEnabled.checked } }));
criticModel.addEventListener("change", () => {
  const model = criticModel.value === "same" ? null : criticModel.value;
  const level = settings.critic.effort;
  const keep = level && effortLevels(modelInfo(model ?? modelSelect.value)).includes(level);
  saveSettings({ critic: { model, effort: keep ? level : null } });
});
criticEffort.addEventListener("change", () =>
  saveSettings({ critic: { effort: criticEffort.value === "default" ? null : criticEffort.value } }),
);
criticRounds.addEventListener("change", () => saveSettings({ critic: { maxRounds: Number(criticRounds.value) } }));
criticTurns.addEventListener("change", () => saveSettings({ critic: { maxTurns: Number(criticTurns.value) } }));

for (const [view, label] of Object.entries(VIEW_LABELS)) {
  const row = document.createElement("label");
  const box = document.createElement("input");
  box.type = "checkbox";
  box.value = view;
  box.addEventListener("change", () => {
    const views = [...lookViews.querySelectorAll("input:checked")].map((b) => b.value);
    if (views.length === 0) {
      box.checked = true; // keep at least one view
      return;
    }
    saveSettings({ look: { views } });
  });
  row.append(box, label);
  lookViews.appendChild(row);
}

for (const key of CAMERA_KEYS) {
  const input = document.getElementById(`set-camera-${key}`);
  input.addEventListener("input", () => formatRange(input));
  input.addEventListener("change", () => saveSettings({ camera: { [key]: Number(input.value) } }));
}
document.getElementById("set-camera-invertMouse").addEventListener("change", (e) =>
  saveSettings({ camera: { invertMouse: e.target.checked } }),
);
document.getElementById("camera-defaults").addEventListener("click", () => saveSettings({ camera: DEFAULT_CAMERA }));

loadModels().then(loadExportTargets);

// ---------- camera ----------

const COMPASS = ["N", "NW", "W", "SW", "S", "SE", "E", "NE"]; // heading is counter-clockwise from north

function showCameraMode(mode) {
  const is2d = mode === "2d";
  mode3dButton.classList.toggle("active", !is2d);
  mode2dButton.classList.toggle("active", is2d);
  for (const el of document.querySelectorAll(".only-3d")) el.hidden = is2d;
  for (const el of document.querySelectorAll(".only-2d")) el.hidden = !is2d;
}

function showCamera(state) {
  if (!state?.mode) return;
  showCameraMode(state.mode);
  headingLabel.textContent = state.mode === "2d" ? "Map: north is up" : `Facing: ${COMPASS[Math.round(state.heading / 45) % 8]}`;
}

async function runCamera(action) {
  try {
    showCamera(await action());
  } catch (err) {
    toast("error", "Camera", errorMessage(err));
  }
}

mode3dButton.addEventListener("click", () => runCamera(() => window.editor.cameraMode("3d")));
mode2dButton.addEventListener("click", () => runCamera(() => window.editor.cameraMode("2d")));
document.getElementById("focus-all").addEventListener("click", async () => {
  try {
    const result = await window.editor.cameraFocus();
    headingLabel.textContent =
      result.clusters > 1
        ? `Group ${result.cluster}/${result.clusters} · ${result.focused} props`
        : `${result.focused} props`;
  } catch (err) {
    toast("error", "Camera", errorMessage(err));
  }
});
for (const button of document.querySelectorAll("[data-preset]")) {
  button.addEventListener("click", () => runCamera(() => window.editor.cameraPreset(button.dataset.preset)));
}
for (const button of document.querySelectorAll("[data-rotate]")) {
  button.addEventListener("click", () => runCamera(() => window.editor.cameraRotate(Number(button.dataset.rotate))));
}
for (const button of document.querySelectorAll("[data-zoom]")) {
  button.addEventListener("click", () => runCamera(() => window.editor.cameraZoom(Number(button.dataset.zoom))));
}

// ---------- embedded 3D view ----------

// CodeWalker's window is a native child window laid over #viewport, so it needs physical pixels.
function reportViewportBounds() {
  const rect = viewport.getBoundingClientRect();
  const scale = window.devicePixelRatio;
  window.editor.setViewportBounds({
    x: Math.round(rect.left * scale),
    y: Math.round(rect.top * scale),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  });
}
new ResizeObserver(reportViewportBounds).observe(viewport);

// Clicking the sidebar doesn't pull keyboard focus back from the embedded 3D view on its own.
for (const id of ["projects-panel", "scene-panel", "chat-panel", "view-toolbar", "status-bar"]) {
  document.getElementById(id).addEventListener("pointerdown", () => window.editor.releaseViewportFocus(), true);
}
window.addEventListener("resize", reportViewportBounds);
reportViewportBounds();

// The loading screen behind the 3D view: visible while CodeWalker starts, and while a project opens (the
// view is moved out of the way meanwhile).
function showViewportLoading(title, detail = "") {
  const card = document.createElement("div");
  card.className = "viewport-loading";
  const heading = document.createElement("div");
  heading.className = "viewport-loading-title";
  heading.textContent = title;
  card.append(icon("spinner", "spin"), heading);
  if (detail) {
    const sub = document.createElement("div");
    sub.className = "viewport-loading-detail";
    sub.textContent = detail;
    card.appendChild(sub);
  }
  viewportMessage.replaceChildren(card);
}

let switchingTo = null; // project name while one is opening

// A project switch: the map, the scene list and the chat all change, so it is shown as one clear step.
function beginSwitch(name) {
  switchingTo = name;
  document.body.classList.add("switching");
  document.getElementById("progress").hidden = false;
  showViewportLoading(name ? `Opening ${name}` : "Opening project", "Loading the map and its chats…");
}

function endSwitch() {
  switchingTo = null;
  document.body.classList.remove("switching");
  document.getElementById("progress").hidden = true;
  showViewportLoading("Loading map…");
}

function showViewerStatus(status) {
  switch (status.state) {
    case "starting":
      viewerDot.className = "dot";
      viewerLabel.textContent = "Starting CodeWalker…";
      showViewportLoading("Starting CodeWalker…");
      break;
    case "loading":
      viewerDot.className = "dot";
      viewerLabel.textContent = "Loading the GTA V world…";
      showViewportLoading("Loading the GTA V world…", "This takes a little while the first time.");
      break;
    case "ready":
      viewerDot.className = "dot on";
      viewerLabel.textContent = "Ready";
      // Only shows while the view is out of the way (a project switch).
      if (!switchingTo) showViewportLoading("Loading map…");
      reportViewportBounds();
      refreshState();
      break;
    case "error":
      viewerDot.className = "dot off";
      viewerLabel.textContent = "CodeWalker error";
      viewportMessage.textContent = status.message;
      break;
  }
}
window.editor.onViewerStatus(showViewerStatus);
window.editor.viewerStatus().then(showViewerStatus);

// ---------- props list ----------

async function refreshState() {
  if (editingTree) return;
  const state = await window.editor.mapState();
  if (!state || editingTree) return;
  const { status, props, folders, project } = state;

  undoSteps = status.undoSteps;
  redoSteps = status.redoSteps;
  undoButton.disabled = busy || undoSteps === 0;
  redoButton.disabled = busy || redoSteps === 0;
  unsavedMark.hidden = !status.unsaved; // autosave clears it within a few seconds
  mapName.dataset.slug = project?.slug ?? "";
  mapName.textContent = project?.name ?? "";
  mapName.title = project ? `${project.name}\nFolder: maps/${project.slug}` : "";
  showCameraMode(status.cameraMode);
  propCount.textContent = String(props.length);

  renderTree(props, folders);
}

function eyeButton(hidden, title, onToggle) {
  const button = iconButton(hidden ? "eye-off" : "eye", hidden ? `Show ${title}` : `Hide ${title}`, () => {
    button.disabled = true;
    runMapAction(() => onToggle(!hidden));
  }, "eye");
  return button;
}

function rowActions(...buttons) {
  const actions = document.createElement("div");
  actions.className = "row-actions";
  actions.append(...buttons);
  return actions;
}

// Rows accept dropped props: onto a folder moves them in, onto the top-level row moves them out.
function makeDropTarget(row, folder) {
  row.addEventListener("dragover", (e) => {
    if (!e.dataTransfer.types.includes("application/x-prop-id")) return;
    e.preventDefault();
    row.classList.add("drop-target");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    row.classList.remove("drop-target");
    const id = Number(e.dataTransfer.getData("application/x-prop-id"));
    if (id) runMapAction(() => window.editor.assignFolder([id], folder));
  });
}

// Replaces `anchor`'s content (or appends a row to the list) with a name input.
function startNameEdit(container, initial, commit, replaceRow) {
  editingTree = true;
  const row = document.createElement("li");
  const input = document.createElement("input");
  input.value = initial;
  input.placeholder = "Folder name";
  row.appendChild(input);
  if (replaceRow) replaceRow.replaceWith(row);
  else container.prepend(row);
  input.focus();
  input.select();

  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    editingTree = false;
    if (save && name && name !== initial) {
      await runMapAction(() => commit(name));
    } else {
      refreshState();
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish(true);
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

function propRow(prop, inFolder) {
  const li = document.createElement("li");
  li.className = `${inFolder ? "in-folder" : ""} ${prop.hidden ? "is-hidden" : ""}`;
  li.draggable = true;
  li.addEventListener("dragstart", (e) => e.dataTransfer.setData("application/x-prop-id", String(prop.id)));

  const name = document.createElement("span");
  name.className = "prop-name";
  const id = document.createElement("span");
  id.className = "prop-id";
  id.textContent = `#${prop.id}`;
  name.append(id, prop.name);
  li.title = `${prop.name}\nPosition: ${prop.position.map((v) => v.toFixed(1)).join(", ")}\nDouble-click: focus camera · drag: move to folder`;
  li.addEventListener("dblclick", () => runCamera(() => window.editor.cameraFocus([prop.id])));
  const meta = document.createElement("span");
  meta.className = "prop-meta";
  meta.textContent = `${prop.distance.toFixed(0)} m`;
  const del = iconButton("trash", "Delete (can be undone)", () => {
    del.disabled = true;
    runMapAction(() => window.editor.deleteProp(prop.id));
  }, "danger");
  li.append(
    icon("box"),
    name,
    meta,
    rowActions(eyeButton(prop.hidden, "prop", (hidden) => window.editor.setPropHidden(prop.id, hidden)), del),
  );
  return li;
}

function renderTree(props, folders) {
  propList.replaceChildren();
  const sorted = [...props].sort((a, b) => a.id - b.id);

  for (const folder of folders) {
    const members = sorted.filter((p) => p.folder === folder.name);
    const collapsed = collapsedFolders.has(folder.name);

    const header = document.createElement("li");
    header.className = `folder ${folder.hidden ? "is-hidden" : ""}`;
    const name = document.createElement("span");
    name.className = "prop-name";
    name.textContent = folder.name;
    name.title = "Double-click: rename";
    const count = document.createElement("span");
    count.className = "prop-meta";
    count.textContent = String(members.length);
    const del = iconButton("trash", "Delete folder (its props stay, without a folder)", () =>
      runMapAction(() => window.editor.deleteFolder(folder.name)), "danger");

    header.append(
      icon(collapsed ? "chevron-right" : "chevron-down", "twisty"),
      icon("folder"),
      name,
      count,
      rowActions(eyeButton(folder.hidden, "folder", (hidden) => window.editor.setFolderHidden(folder.name, hidden)), del),
    );
    header.addEventListener("click", () => {
      if (collapsed) collapsedFolders.delete(folder.name);
      else collapsedFolders.add(folder.name);
      refreshState();
    });
    name.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      startNameEdit(propList, folder.name, (to) => window.editor.renameFolder(folder.name, to), header);
    });
    makeDropTarget(header, folder.name);
    propList.appendChild(header);

    if (!collapsed) {
      for (const prop of members) propList.appendChild(propRow(prop, true));
    }
  }

  const loose = sorted.filter((p) => !p.folder);
  if (folders.length) {
    const rootRow = document.createElement("li");
    rootRow.className = "root-drop";
    rootRow.textContent = loose.length ? "No folder" : "No folder · drop here";
    makeDropTarget(rootRow, null);
    propList.appendChild(rootRow);
  }
  for (const prop of loose) propList.appendChild(propRow(prop, false));

  if (!props.length && !folders.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No props yet. Ask the agent to build something.";
    propList.appendChild(li);
  }
}
setInterval(() => {
  if (!busy) refreshState();
}, 4000);
input.focus();
