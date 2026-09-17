const log = document.getElementById("log");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendButton = document.getElementById("send");
const stopButton = document.getElementById("stop");
const modelSelect = document.getElementById("model-select");
const usageBar = document.getElementById("usage");
const activityLabel = document.getElementById("activity");

// Long-running tools get a status bar note, since the camera moves on its own while they run.
const ACTIVITY = {
  look_at_scene: "Agent sahneye bakıyor…",
  request_review: "Eleştirmen inceliyor…",
};
const activeTools = new Map();

function refreshActivity() {
  const latest = [...activeTools.values()].pop();
  activityLabel.hidden = !latest;
  activityLabel.textContent = latest ?? "";
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

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function renderInline(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");
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
  if (value && !thinkingEl) {
    thinkingEl = document.createElement("div");
    thinkingEl.className = "thinking";
    thinkingEl.textContent = "Çalışıyor…";
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
      return `"${args.query}" aranıyor`;
    case "place_prop": {
      const side = args.right === 0 ? "" : args.right > 0 ? `, ${fmt(args.right)}m sağ` : `, ${fmt(-args.right)}m sol`;
      const up = args.up ? `, ${fmt(args.up)}m yukarı` : "";
      const folder = args.folder ? ` → ${args.folder}` : "";
      return `${args.model} · ${fmt(args.forward)}m ileri${side}${up}, ${fmt(args.heading ?? 0)}°${folder}`;
    }
    case "check_props":
      return args.ids?.length ? args.ids.map((id) => `#${id}`).join(", ") : "tüm harita";
    case "look_at_scene":
      return `${(args.views ?? ["top", "south", "east"]).join(", ")}${args.ids?.length ? ` · ${args.ids.length} obje` : ""}`;
    case "request_review":
      return `${args.checklist?.length ?? 0} maddelik kontrol listesi · ${args.ids?.length ?? 0} obje`;
    case "undo_last_change":
      return "önceki isteğin değişiklikleri";
    case "redo_last_undo":
      return "son geri alınan";
    case "set_folder":
      return `${(args.ids ?? []).map((id) => `#${id}`).join(", ")} → ${args.folder ?? "klasörsüz"}`;
    case "set_visibility": {
      const target = args.folder ? `"${args.folder}" klasörü` : (args.ids ?? []).map((id) => `#${id}`).join(", ");
      return `${target} ${args.visible ? "göster" : "gizle"}`;
    }
    case "export_fivem_resource":
      return `${args.name} resource'u`;
    case "list_props":
      return args.radius ? `${fmt(args.radius)}m içindeki objeler` : "tüm objeler";
    case "move_prop": {
      const parts = [];
      if (args.forward) parts.push(args.forward > 0 ? `${fmt(args.forward)}m ileri` : `${fmt(-args.forward)}m geri`);
      if (args.right) parts.push(args.right > 0 ? `${fmt(args.right)}m sağ` : `${fmt(-args.right)}m sol`);
      if (args.up) parts.push(args.up > 0 ? `${fmt(args.up)}m yukarı` : `${fmt(-args.up)}m aşağı`);
      if (args.turn) parts.push(`${fmt(args.turn)}° dön`);
      return `#${args.id} · ${parts.join(", ") || "değişiklik yok"}`;
    }
    case "delete_prop":
      return `#${args.id}`;
    case "get_camera_view":
      return "kamera konumu";
    case "save_map":
      return `${args.name}.ymap olarak kaydediliyor`;
    default:
      return JSON.stringify(args);
  }
}

const TOOL_LABELS = {
  search_props: "Prop ara",
  place_prop: "Yerleştir",
  list_props: "Objeleri listele",
  move_prop: "Taşı",
  delete_prop: "Sil",
  check_props: "Kontrol et",
  look_at_scene: "Sahneye bak",
  request_review: "Eleştirmen",
  undo_last_change: "Geri al",
  redo_last_undo: "İleri al",
  set_folder: "Klasöre taşı",
  set_visibility: "Görünürlük",
  export_fivem_resource: "FiveM'e aktar",
  get_camera_view: "Kamera",
  save_map: "Kaydet",
};

function onToolUse({ id, name, input: args }) {
  const card = document.createElement("details");
  card.className = "tool";
  const summary = document.createElement("summary");
  summary.innerHTML = `<span class="name">${escapeHtml(TOOL_LABELS[name] ?? name)}</span> · ${escapeHtml(describeTool(name, args ?? {}))}`;
  const body = document.createElement("pre");
  body.textContent = JSON.stringify(args, null, 2);
  card.append(summary, body);
  toolCards.set(id, { card, summary, body, name });
  append(card);
  if (ACTIVITY[name]) {
    activeTools.set(id, ACTIVITY[name]);
    refreshActivity();
  }
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
  card.appendChild(shots);
  card.open = true;
}

function addReview(card, verdict) {
  const box = document.createElement("div");
  box.className = "review";
  const headline = document.createElement("div");
  headline.className = verdict.pass ? "met" : "unmet";
  headline.textContent = `${verdict.pass ? "Geçti" : "Kaldı"} · tur ${verdict.round}/${verdict.maxRounds}: ${verdict.summary}`;
  box.appendChild(headline);
  const list = document.createElement("ul");
  for (const item of verdict.checklist ?? []) {
    const li = document.createElement("li");
    li.className = item.met ? "met" : "unmet";
    li.textContent = `${item.met ? "✓" : "✗"} ${item.item}${item.note ? ` — ${item.note}` : ""}`;
    list.appendChild(li);
  }
  for (const issue of verdict.issues ?? []) {
    const li = document.createElement("li");
    li.className = "unmet";
    li.textContent = `${issue.ids.map((id) => `#${id}`).join(", ")}: ${issue.problem} → ${issue.fix}`;
    list.appendChild(li);
  }
  box.appendChild(list);
  card.appendChild(box);
  card.open = !verdict.pass;
}

const ISSUE_LABELS = {
  overlap: "başka objeyle çakışıyor",
  world_collision: "dünyaya giriyor",
  floating: "havada",
  overhang: "kenarı boşta",
  buried: "gömülü",
  steep_ground: "eğimli zemin",
  no_ground: "altında zemin yok",
};

function describeIssues(issues = []) {
  return [...new Set(issues.map((issue) => ISSUE_LABELS[issue.type] ?? issue.type))].join(", ");
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
      entry.card.classList.add(verdict.pass ? "ok" : "warn");
      entry.summary.insertAdjacentHTML("beforeend", ` <span class="note">— ${verdict.pass ? "geçti" : "kaldı"} (tur ${verdict.round}/${verdict.maxRounds})</span>`);
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
        note = "zemin bulunamadı, havada";
      } else if (result.validation && !result.validation.ok) {
        status = "warn";
        note = describeIssues(result.validation.issues) || "kontrol tamamlanamadı";
      }
    } catch {}
  }
  if (!isError && entry.name === "check_props") {
    try {
      const result = JSON.parse(text);
      status = result.problems.length ? "warn" : "ok";
      note = result.problems.length ? `${result.problems.length} objede sorun` : "sorun yok";
    } catch {
      note = "sorun yok";
    }
  }
  if (!isError && entry.name === "search_props") {
    try {
      note = `${JSON.parse(text).length} sonuç`;
    } catch {
      note = "sonuç yok";
    }
  }
  if (isError) note = text.slice(0, 120);
  entry.card.classList.add(status);
  if (note) entry.summary.insertAdjacentHTML("beforeend", ` <span class="note">— ${escapeHtml(note)}</span>`);
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text), null, 2);
  } catch {}
  entry.body.textContent += `\n\n→ ${pretty}`;
}

window.editor.onEvent((event) => {
  switch (event.kind) {
    case "ready":
      modelSelect.title = `Şu an kullanılan: ${event.model}`;
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
    case "text": {
      const el = document.createElement("div");
      el.className = "msg assistant";
      el.innerHTML = renderInline(event.text);
      append(el);
      break;
    }
    case "tool_use":
      onToolUse(event);
      break;
    case "tool_result":
      onToolResult(event);
      break;
    case "done":
      setBusy(false);
      activeTools.clear();
      refreshActivity();
      refreshState();
      if (!event.ok && event.error) {
        const el = document.createElement("div");
        el.className = "error";
        el.textContent = event.error;
        append(el);
      }
      break;
    case "fatal": {
      setBusy(false);
      const el = document.createElement("div");
      el.className = "error";
      el.textContent = `Agent başlatılamadı: ${event.message}`;
      append(el);
      break;
    }
  }
});

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  const el = document.createElement("div");
  el.className = "msg user";
  el.textContent = text;
  append(el);
  input.value = "";
  setBusy(true);
  window.editor.send(text);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

stopButton.addEventListener("click", () => window.editor.interrupt());

document.getElementById("reset").addEventListener("click", async () => {
  await window.editor.reset();
  setBusy(false);
  toolCards.clear();
  log.innerHTML = '<div class="hint">Yeni sohbet başladı. Sahnedeki objeler yerinde duruyor.</div>';
  usage.turn = usage.session = usage.context = null; // a new session starts its own totals
  renderUsage();
});

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
    notice(`Hata: ${errorMessage(err)}`);
  } finally {
    refreshState();
  }
}

async function undo() {
  if (busy || undoSteps === 0) return;
  await runMapAction(async () => {
    const result = await window.editor.undo();
    notice(`Geri alındı (${result.reverted} değişiklik).`);
  });
}

async function redo() {
  if (busy || redoSteps === 0) return;
  await runMapAction(async () => {
    const result = await window.editor.redo();
    notice(`İleri alındı (${result.reverted} değişiklik).`);
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

document.getElementById("new-map").addEventListener("click", () =>
  runMapAction(async () => {
    if (await window.editor.newMap()) notice("Yeni boş harita. İlk obje yerleştirildiğinde oluşturulacak.");
  }),
);

document.getElementById("open-map").addEventListener("click", () =>
  runMapAction(async () => {
    if (await window.editor.openMap()) notice("Harita açıldı, kamera haritanın bulunduğu yere götürüldü.");
  }),
);

document.getElementById("export").addEventListener("click", () => {
  exportForm.hidden = !exportForm.hidden;
  if (exportForm.hidden) return;
  if (!exporting) exportStatus.hidden = true;
  if (!exportName.value) {
    const current = (mapName.dataset.file || "").replace(/\.ymap$/i, "").toLowerCase().replace(/[^a-z0-9_-]+/g, "_");
    exportName.value = current && current !== "map1" ? current : "";
  }
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
    showExportStatus("err", name ? "Geçersiz ad: sadece küçük harf, rakam, _ ve - kullanılabilir." : "Bir resource adı yaz.");
    exportName.focus();
    return;
  }

  exporting = true;
  exportSubmit.disabled = true;
  exportSubmit.textContent = "Aktarılıyor…";
  showExportStatus("working", "Harita kaydediliyor ve resource klasörü oluşturuluyor…");
  try {
    const result = await window.editor.exportMap(name);
    showExportStatus("ok", `Hazır: ${result.entityCount} obje → ${result.resourceDir}`, {
      label: "Klasörü aç",
      run: () => window.editor.showFolder(result.resourceDir),
    });
  } catch (err) {
    showExportStatus("err", `Aktarılamadı: ${errorMessage(err)}`);
  } finally {
    exporting = false;
    exportSubmit.disabled = false;
    exportSubmit.textContent = "Aktar";
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
  five_hour: "5 saatlik limit",
  seven_day: "Haftalık limit",
  seven_day_opus: "Haftalık Opus limiti",
  seven_day_sonnet: "Haftalık Sonnet limiti",
};

function usagePart(text, title, cls) {
  const span = document.createElement("span");
  span.textContent = text;
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
        `Son istek: ${tokens(sent)} giriş · ${tokens(t.output)} çıkış`,
        `Önbellekten okunan: ${tokens(t.cacheRead)}\nÖnbelleğe yazılan: ${tokens(t.cacheWrite)}\nÖnbelleksiz giriş: ${tokens(t.input)}\n(Sadece ana döngü)`,
      ),
    );
  }
  if (usage.session) {
    const s = usage.session;
    const total = s.input + s.cacheRead + s.cacheWrite + s.output;
    parts.push(
      usagePart(
        `Oturum: ${tokens(total)} token · ≈$${s.costUsd.toFixed(2)}`,
        "Bu sohbetteki toplam. Tutar API liste fiyatıyla tahmindir; abonelikte ayrıca ücretlendirilmez, abonelik limitinden düşer.",
      ),
    );
  }
  if (usage.context) {
    const c = usage.context;
    const pct = Math.round(c.percentage);
    parts.push(
      usagePart(`Bağlam: %${pct}`, `${tokens(c.usedTokens)} / ${tokens(c.maxTokens)} token. Dolunca eski mesajlar özetlenir; "Yeni sohbet" sıfırlar.`, pct >= 80 ? "warn" : ""),
    );
  }
  if (usage.rateLimit && usage.rateLimit.utilization !== undefined) {
    const r = usage.rateLimit;
    const pct = Math.round(r.utilization <= 1 ? r.utilization * 100 : r.utilization);
    const resets = r.resetsAt ? `\nSıfırlanma: ${new Date(r.resetsAt * 1000).toLocaleString("tr-TR")}` : "";
    const cls = r.status === "rejected" ? "err" : r.status === "allowed_warning" ? "warn" : "";
    parts.push(usagePart(`${LIMIT_LABELS[r.limitType] ?? "Abonelik limiti"}: %${pct}`, `Durum: ${r.status}${resets}`, cls));
  }
  usageBar.replaceChildren(...parts);
  usageBar.hidden = parts.length === 0;
}

async function loadModels() {
  try {
    const { models, selected } = await window.editor.models();
    modelSelect.replaceChildren();
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.value;
      option.textContent = model.value === "default" ? `Varsayılan (${model.description.split(" · ")[0]})` : model.displayName;
      option.title = model.description;
      modelSelect.appendChild(option);
    }
    // A saved model that the account no longer offers falls back to the default entry.
    modelSelect.value = models.some((m) => m.value === selected) ? selected : "default";
    modelSelect.disabled = false;
  } catch (err) {
    modelSelect.replaceChildren(new Option("Model listesi alınamadı"));
    modelSelect.title = errorMessage(err);
  }
}

modelSelect.addEventListener("change", async () => {
  const option = modelSelect.selectedOptions[0];
  try {
    await window.editor.setModel(modelSelect.value);
    notice(`Model: ${option.textContent}. Sonraki yanıtlardan itibaren geçerli, sohbet korunur.`);
  } catch (err) {
    notice(`Model değiştirilemedi: ${errorMessage(err)}`);
  }
});

loadModels();

// ---------- camera ----------

const COMPASS = ["K", "KB", "B", "GB", "G", "GD", "D", "KD"]; // heading is counter-clockwise from north

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
  headingLabel.textContent = state.mode === "2d" ? "Harita: kuzey yukarıda" : `Yön: ${COMPASS[Math.round(state.heading / 45) % 8]}`;
}

async function runCamera(action) {
  try {
    showCamera(await action());
  } catch (err) {
    notice(`Kamera: ${errorMessage(err)}`);
  }
}

mode3dButton.addEventListener("click", () => runCamera(() => window.editor.cameraMode("3d")));
mode2dButton.addEventListener("click", () => runCamera(() => window.editor.cameraMode("2d")));
document.getElementById("focus-all").addEventListener("click", async () => {
  try {
    const result = await window.editor.cameraFocus();
    headingLabel.textContent =
      result.clusters > 1
        ? `Grup ${result.cluster}/${result.clusters} · ${result.focused} obje`
        : `${result.focused} obje`;
  } catch (err) {
    notice(`Kamera: ${errorMessage(err)}`);
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
for (const id of ["scene-panel", "chat-panel", "view-toolbar", "status-bar"]) {
  document.getElementById(id).addEventListener("pointerdown", () => window.editor.releaseViewportFocus(), true);
}
window.addEventListener("resize", reportViewportBounds);
reportViewportBounds();

function showViewerStatus(status) {
  switch (status.state) {
    case "starting":
      viewerDot.className = "dot";
      viewerLabel.textContent = "CodeWalker başlatılıyor…";
      viewportMessage.textContent = "CodeWalker başlatılıyor…";
      break;
    case "loading":
      viewerDot.className = "dot";
      viewerLabel.textContent = "GTA V dünyası yükleniyor…";
      viewportMessage.textContent = "GTA V dünyası yükleniyor…";
      break;
    case "ready":
      viewerDot.className = "dot on";
      viewerLabel.textContent = "Hazır";
      reportViewportBounds();
      refreshState();
      break;
    case "error":
      viewerDot.className = "dot off";
      viewerLabel.textContent = "CodeWalker hatası";
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
  const { status, props, folders } = state;

  undoSteps = status.undoSteps;
  redoSteps = status.redoSteps;
  undoButton.disabled = busy || undoSteps === 0;
  redoButton.disabled = busy || redoSteps === 0;
  unsavedMark.hidden = !status.unsaved;
  mapName.dataset.file = status.mapName ?? "";
  mapName.textContent = status.mapName ?? "Yeni harita";
  showCameraMode(status.cameraMode);
  propCount.textContent = String(props.length);

  renderTree(props, folders);
}

function eyeButton(hidden, title, onToggle) {
  const button = document.createElement("button");
  button.className = "eye";
  button.textContent = hidden ? "○" : "●";
  button.title = hidden ? `${title} göster` : `${title} gizle`;
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    button.disabled = true;
    runMapAction(() => onToggle(!hidden));
  });
  return button;
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
  input.placeholder = "Klasör adı";
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
  name.textContent = `#${prop.id} ${prop.name}`;
  name.title = `Konum: ${prop.position.map((v) => v.toFixed(1)).join(", ")}\nÇift tıkla: kameraya odakla · sürükle: klasöre taşı`;
  li.addEventListener("dblclick", () => runCamera(() => window.editor.cameraFocus([prop.id])));
  const meta = document.createElement("span");
  meta.className = "prop-meta";
  meta.textContent = `${prop.distance.toFixed(0)}m`;
  const del = document.createElement("button");
  del.textContent = "×";
  del.title = "Sil (geri alınabilir)";
  del.addEventListener("click", () => {
    del.disabled = true;
    runMapAction(() => window.editor.deleteProp(prop.id));
  });
  li.append(eyeButton(prop.hidden, "Objeyi", (hidden) => window.editor.setPropHidden(prop.id, hidden)), name, meta, del);
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
    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.textContent = collapsed ? "▸" : "▾";
    const name = document.createElement("span");
    name.className = "prop-name";
    name.textContent = folder.name;
    name.title = "Çift tıkla: yeniden adlandır";
    const count = document.createElement("span");
    count.className = "prop-meta";
    count.textContent = String(members.length);
    const del = document.createElement("button");
    del.textContent = "×";
    del.title = "Klasörü sil (objeler silinmez, klasörsüz kalır)";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      runMapAction(() => window.editor.deleteFolder(folder.name));
    });

    header.append(
      twisty,
      eyeButton(folder.hidden, "Klasörü", (hidden) => window.editor.setFolderHidden(folder.name, hidden)),
      name,
      count,
      del,
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
    rootRow.textContent = loose.length ? "Klasörsüz" : "Klasörsüz (klasörden çıkarmak için buraya bırak)";
    makeDropTarget(rootRow, null);
    propList.appendChild(rootRow);
  }
  for (const prop of loose) propList.appendChild(propRow(prop, false));

  if (!props.length && !folders.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Henüz obje yok";
    propList.appendChild(li);
  }
}
setInterval(() => {
  if (!busy) refreshState();
}, 4000);
input.focus();
