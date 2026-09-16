import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { EditorSession } from "./agent.js";
import { codewalker, CodeWalkerError, setHistoryGroup } from "./codewalker.js";
import { exportFivemResource } from "./export.js";
import { layout } from "./layout.js";
import type { UiEvent, ViewerStatus } from "./events.js";

const editorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(editorDir, "..");
const mapsDir = process.env.MAP_OUTPUT_DIR ?? path.join(repoDir, "maps");
const codewalkerExe =
  process.env.CODEWALKER_EXE ?? path.join(repoDir, "codewalker", "CodeWalker", "bin", "Debug", "net48", "CodeWalker.exe");

let window: BrowserWindow | null = null;
let session: EditorSession | null = null;
let codewalkerProcess: ChildProcess | null = null;
let viewer: ViewerStatus = { state: "starting" };
let viewportBounds: { x: number; y: number; width: number; height: number } | null = null;
let boundsSent = false;

// ---------- settings ----------

interface Settings {
  model?: string; // undefined = account default
}

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

function loadSettings(): Settings {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8")) as Settings;
  } catch {
    return {};
  }
}

let settings: Settings = {};

function emit(event: UiEvent) {
  window?.webContents.send("agent:event", event);
}

function setViewer(next: ViewerStatus) {
  viewer = next;
  window?.webContents.send("viewer:status", viewer);
}

// ---------- embedded CodeWalker ----------

function nativeHandle(win: BrowserWindow): string {
  const buffer = win.getNativeWindowHandle();
  return (buffer.length >= 8 ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0))).toString();
}

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function launchViewer(win: BrowserWindow) {
  // Something may still own the API port: a standalone CodeWalker, or the embedded one of a previous
  // editor that is still shutting down (it closes itself about a second after its host window goes).
  // Attaching to the latter would run against a stale, dying process.
  const deadline = Date.now() + 15_000;
  for (;;) {
    let status;
    try {
      status = await codewalker.status();
    } catch {
      break; // nothing is listening, which is what we want
    }
    if (!status.embedded) {
      setViewer({ state: "error", message: "Ayrı bir CodeWalker penceresi açık. Onu kapatıp editörü yeniden başlat." });
      return;
    }
    if (Date.now() > deadline) {
      setViewer({ state: "error", message: "Önceki CodeWalker hâlâ çalışıyor. Görev Yöneticisi'nden CodeWalker.exe'yi kapatıp editörü yeniden başlat." });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!fs.existsSync(codewalkerExe)) {
    setViewer({ state: "error", message: `CodeWalker bulunamadı: ${codewalkerExe}` });
    return;
  }

  const handle = nativeHandle(win);
  log(`spawning ${codewalkerExe} embed=${handle}`);
  const child = spawn(codewalkerExe, [`embed=${handle}`], { cwd: path.dirname(codewalkerExe), stdio: "ignore" });
  codewalkerProcess = child;
  child.on("error", (err) => log(`spawn error: ${err.message}`));
  child.on("exit", (code) => {
    log(`CodeWalker exited with code ${code}`);
    if (codewalkerProcess === child) codewalkerProcess = null;
    boundsSent = false;
    if (window) setViewer({ state: "error", message: `CodeWalker kapandı (çıkış kodu ${code}).` });
  });

  // Keep watching for the whole session: CodeWalker takes a while to load the game and can also
  // stop answering later.
  let lastState = "";
  while (codewalkerProcess === child && window) {
    let next: ViewerStatus;
    try {
      const status = await codewalker.status();
      if (!boundsSent && viewportBounds) {
        await codewalker.setEmbedBounds(viewportBounds);
        boundsSent = true;
        log(`viewport bounds sent: ${JSON.stringify(viewportBounds)}`);
      }
      next = status.worldLoaded ? { state: "ready", propCount: status.propCount } : { state: "loading" };
    } catch (err) {
      next = { state: "starting" };
      if (lastState !== "starting") log(`status check failed: ${err instanceof Error ? err.message : err}`);
    }
    if (next.state !== lastState) log(`viewer state: ${lastState || "(none)"} -> ${next.state}`);
    lastState = next.state;
    if (codewalkerProcess === child) setViewer(next);
    await new Promise((resolve) => setTimeout(resolve, next.state === "ready" ? 3000 : 1000));
  }
}

ipcMain.handle("viewer:bounds", async (_event, bounds: { x: number; y: number; width: number; height: number }) => {
  viewportBounds = bounds;
  try {
    await codewalker.setEmbedBounds(bounds);
    boundsSent = true;
  } catch {
    boundsSent = false; // not up yet; launchViewer sends it once CodeWalker answers
  }
});

ipcMain.handle("viewer:status", () => viewer);

ipcMain.handle("viewer:release-focus", async () => {
  try {
    await codewalker.releaseEmbedFocus();
  } catch {
    // CodeWalker not up: focus is already ours.
  }
});

ipcMain.handle("props:list", async () => {
  try {
    return await codewalker.listProps();
  } catch {
    return [];
  }
});

ipcMain.handle("props:delete", async (_event, id: number) => {
  await codewalker.deleteProp(id, `ui-${Date.now()}`);
});

// ---------- map files and history ----------

ipcMain.handle("map:state", async () => {
  try {
    const [status, props] = await Promise.all([codewalker.status(), layout.props()]);
    return { status, props, folders: layout.listFolders() };
  } catch {
    return null;
  }
});

async function confirmDiscard(action: string): Promise<boolean> {
  if (!window) return false;
  const { response } = await dialog.showMessageBox(window, {
    type: "warning",
    buttons: ["Değişiklikleri at", "İptal"],
    defaultId: 1,
    cancelId: 1,
    message: "Haritada kaydedilmemiş değişiklikler var.",
    detail: `${action} kaydedilmemiş değişiklikler kaybolacak. Kaydetmek için önce "FiveM'e aktar" kullan.`,
  });
  return response === 0;
}

function isUnsavedError(err: unknown) {
  return err instanceof CodeWalkerError && err.details.unsaved === true;
}

// Runs a map-replacing action, asking before throwing away unsaved edits. Returns false if cancelled.
async function withDiscardConfirmation(action: string, run: (discard: boolean) => Promise<unknown>) {
  try {
    await run(false);
    return true;
  } catch (err) {
    if (!isUnsavedError(err)) throw err;
    if (!(await confirmDiscard(action))) return false;
    await run(true);
    return true;
  }
}

ipcMain.handle("map:new", () =>
  withDiscardConfirmation("Yeni harita başlatılırsa", async (discard) => {
    await codewalker.newMap(discard);
    layout.reset();
  }),
);

ipcMain.handle("map:open", async () => {
  if (!window) return false;
  const picked = await dialog.showOpenDialog(window, {
    title: "Harita aç",
    defaultPath: mapsDir,
    filters: [{ name: "GTA V harita", extensions: ["ymap"] }],
    properties: ["openFile"],
  });
  if (picked.canceled || picked.filePaths.length === 0) return false;
  const file = picked.filePaths[0];
  return withDiscardConfirmation("Başka harita açılırsa", async (discard) => {
    await codewalker.openMap(file, discard);
    await layout.load(file);
  });
});

ipcMain.handle("camera:mode", (_event, mode: "3d" | "2d") => codewalker.camera.setMode(mode));
ipcMain.handle("camera:preset", (_event, name: "eye_level" | "bird" | "north") => codewalker.camera.preset(name));
ipcMain.handle("camera:rotate", (_event, degrees: number) => codewalker.camera.rotate(degrees));
ipcMain.handle("camera:zoom", (_event, factor: number) => codewalker.camera.zoom(factor));
ipcMain.handle("camera:focus", (_event, ids?: number[]) => codewalker.camera.focus(ids));

ipcMain.handle("map:undo", () => codewalker.undo());
ipcMain.handle("map:redo", () => codewalker.redo());

ipcMain.handle("layout:create-folder", (_event, name: string) => layout.createFolder(name));
ipcMain.handle("layout:rename-folder", (_event, from: string, to: string) => layout.renameFolder(from, to));
ipcMain.handle("layout:delete-folder", (_event, name: string) => layout.deleteFolder(name));
ipcMain.handle("layout:assign", (_event, ids: number[], folder: string | null) => layout.assign(ids, folder));
ipcMain.handle("layout:folder-hidden", (_event, name: string, hidden: boolean) => layout.setFolderHidden(name, hidden));
ipcMain.handle("layout:prop-hidden", (_event, id: number, hidden: boolean) => codewalker.setVisibility([id], !hidden));

ipcMain.handle("map:export", (_event, name: string) => exportFivemResource(name, mapsDir));

ipcMain.handle("shell:show-folder", (_event, folder: string) => {
  if (path.resolve(folder).startsWith(path.resolve(mapsDir))) return shell.openPath(folder);
});

// ---------- agent ----------

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("");
  }
  return "";
}

// Flattens SDK messages into the few event kinds the chat UI renders.
function forward(message: SDKMessage) {
  switch (message.type) {
    case "assistant":
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) {
          emit({ kind: "text", text: block.text });
        } else if (block.type === "tool_use") {
          emit({ kind: "tool_use", id: block.id, name: block.name.replace(/^mcp__codewalker__/, ""), input: block.input });
        }
      }
      break;
    case "user":
      if (Array.isArray(message.message.content)) {
        for (const block of message.message.content) {
          if (typeof block === "object" && block.type === "tool_result") {
            emit({ kind: "tool_result", id: block.tool_use_id, isError: !!block.is_error, text: toolResultText(block.content) });
          }
        }
      }
      break;
    case "system":
      if (message.subtype === "init") emit({ kind: "ready", model: message.model });
      break;
    case "rate_limit_event": {
      const info = message.rate_limit_info;
      emit({ kind: "rate_limit", status: info.status, limitType: info.rateLimitType, utilization: info.utilization, resetsAt: info.resetsAt });
      break;
    }
    case "result": {
      setHistoryGroup(undefined);
      // usage is this turn's main loop; modelUsage and total_cost_usd are cumulative for the session.
      const session = Object.values(message.modelUsage).reduce(
        (sum, m) => ({
          input: sum.input + m.inputTokens,
          output: sum.output + m.outputTokens,
          cacheRead: sum.cacheRead + m.cacheReadInputTokens,
          cacheWrite: sum.cacheWrite + m.cacheCreationInputTokens,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      );
      emit({
        kind: "usage",
        turn: {
          input: message.usage.input_tokens,
          output: message.usage.output_tokens,
          cacheRead: message.usage.cache_read_input_tokens,
          cacheWrite: message.usage.cache_creation_input_tokens,
        },
        session: { ...session, costUsd: message.total_cost_usd },
      });
      void emitContextUsage();
      emit({
        kind: "done",
        ok: message.subtype === "success" && !message.is_error,
        error: message.subtype === "success" ? (message.is_error ? message.result : undefined) : message.errors.join("\n") || message.subtype,
      });
      break;
    }
  }
}

async function emitContextUsage() {
  try {
    const usage = await session?.contextUsage();
    if (usage) emit({ kind: "context", usedTokens: usage.totalTokens, maxTokens: usage.maxTokens, percentage: usage.percentage });
  } catch {
    // Informational only.
  }
}

function ensureSession(): EditorSession {
  if (session) return session;
  const created = new EditorSession(forward, { mapsDir, workDir: editorDir, model: process.env.MAP_EDITOR_MODEL ?? settings.model });
  session = created;
  created.start().catch((err: unknown) => {
    emit({ kind: "fatal", message: err instanceof Error ? err.message : String(err) });
    if (session === created) session = null;
  });
  return created;
}

ipcMain.handle("agent:send", (_event, text: string) => {
  // Everything the agent changes while answering this message becomes one undo step.
  setHistoryGroup(`turn-${Date.now()}`);
  ensureSession().send(text);
});

ipcMain.handle("agent:interrupt", async () => {
  await session?.interrupt();
});

ipcMain.handle("agent:reset", () => {
  session?.close();
  session = null;
  ensureSession(); // keep a live session so the model list stays available
});

ipcMain.handle("agent:models", async () => {
  const models = await ensureSession().supportedModels();
  return { models, selected: settings.model ?? "default" };
});

ipcMain.handle("agent:set-model", async (_event, value: string) => {
  settings.model = value === "default" ? undefined : value;
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  await session?.setModel(settings.model);
});

ipcMain.handle("maps:open", () => shell.openPath(mapsDir));

// ---------- app lifecycle ----------

// CodeWalker is hosted as a native child window over the viewport. With DirectComposition,
// Chromium composites its output above child windows, which hides the 3D view entirely.
app.commandLine.appendSwitch("disable-direct-composition");

app.whenReady().then(() => {
  fs.mkdirSync(mapsDir, { recursive: true });
  settings = loadSettings();
  window = new BrowserWindow({
    width: 1600,
    height: 900,
    title: "GTA Map Editor",
    backgroundColor: "#16181d",
    webPreferences: {
      preload: path.join(editorDir, "dist", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // No menu bar, so the web content starts at the window's client origin and the viewport
  // coordinates we send to CodeWalker line up with the parent client area.
  window.removeMenu();
  window.loadFile(path.join(editorDir, "renderer", "index.html"));
  window.on("closed", () => (window = null));

  // Ask before closing with unsaved edits; the check is async, so cancel once and re-close.
  let closeConfirmed = false;
  window.on("close", (event) => {
    if (closeConfirmed) return;
    event.preventDefault();
    void (async () => {
      let unsaved = false;
      try {
        unsaved = (await codewalker.status()).unsaved;
      } catch {
        // CodeWalker gone: nothing left to lose.
      }
      if (unsaved && !(await confirmDiscard("Editör kapatılırsa"))) return;
      closeConfirmed = true;
      window?.close();
    })();
  });
  const win = window;
  window.webContents.once("did-finish-load", () => void launchViewer(win));
});

app.on("window-all-closed", () => {
  session?.close();
  codewalkerProcess?.kill();
  app.quit();
});
