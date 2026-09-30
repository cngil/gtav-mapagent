import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { beginUserRequest, EditorSession, type AgentHost } from "./agent.js";
import { APP_ID, APP_NAME } from "./app-info.js";
import { codewalker, CodeWalkerError, setHistoryGroup } from "./codewalker.js";
import { EXPORT_TARGET_INFO, EXPORT_TARGETS, exportMap, type ExportTarget } from "./export.js";
import { layout } from "./layout.js";
import type { UiEvent, ViewerStatus } from "./events.js";
import { ProjectStore, type ProjectInfo } from "./projects.js";
import { getSettings, loadSettings, updateSettings, type SettingsPatch } from "./settings.js";
import { ThreadStore } from "./threads.js";
import { messageEvents, withEditorContext } from "./transcript.js";

// Identity first: the user data folder must be settled before anything reads it. It is keyed by APP_ID, so
// renaming the app keeps its settings and chats.
app.setName(APP_NAME);
app.setPath("userData", path.join(app.getPath("appData"), APP_ID));
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

const editorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = path.resolve(editorDir, "..");
const mapsDir = process.env.MAP_OUTPUT_DIR ?? path.join(repoDir, "maps");
const codewalkerExe =
  process.env.CODEWALKER_EXE ?? path.join(repoDir, "codewalker", "CodeWalker", "bin", "Debug", "net48", "CodeWalker.exe");
const userDataDir = app.getPath("userData");
// The agent works in its own folder under user data: the SDK files saved chats by working directory, so they
// stay together wherever the repository is. Every project shares it (see projects.ts).
const agentDir = path.join(userDataDir, "agent");

let window: BrowserWindow | null = null;
let session: EditorSession | null = null;
let codewalkerProcess: ChildProcess | null = null;
let viewer: ViewerStatus = { state: "starting" };
let viewportBounds: { x: number; y: number; width: number; height: number } | null = null;
let boundsSent = false;
let viewerHidden = false; // moved out of sight while a project is switched; bounds are kept for later

let projects: ProjectStore;
let chats: ThreadStore;
let project: ProjectInfo | null = null; // the open project
let loadedProjectId: string | null = null; // whose map CodeWalker has loaded; autosave only writes to its own project
let threadId: string | null = null; // the open chat; null for a new chat until its first reply
let busy = false; // the agent is answering; the scene is shared, so chats and projects can't be switched meanwhile
let sessionFirstMessage = false; // the next message is the conversation's first since it was started or reopened
let sessionResumed = false; // the conversation was reopened from history
let stopRequested = false; // the user pressed Stop during this turn

function emit(event: UiEvent) {
  window?.webContents.send("agent:event", event);
}

function setViewer(next: ViewerStatus) {
  viewer = next;
  window?.webContents.send("viewer:status", viewer);
}

function log(message: string) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// A toast in the UI for things that happen in the background. With a key, the same problem is reported once
// until clearNotice(key), so a check that runs every few seconds doesn't flood the screen.
const shownNotices = new Set<string>();
function notify(level: "info" | "success" | "warning" | "error", title: string, message?: string, key?: string) {
  log(`${level}: ${title}${message ? ` - ${message}` : ""}`);
  if (key) {
    if (shownNotices.has(key)) return;
    shownNotices.add(key);
  }
  emit({ kind: "notify", level, title, message });
}

function clearNotice(key: string) {
  shownNotices.delete(key);
}

// ---------- embedded CodeWalker ----------

// CodeWalker keeps camera settings in memory only, so they are sent again whenever it (re)starts.
async function pushCameraSettings() {
  await codewalker.camera.settings(getSettings().camera);
}

function nativeHandle(win: BrowserWindow): string {
  const buffer = win.getNativeWindowHandle();
  return (buffer.length >= 8 ? buffer.readBigUInt64LE(0) : BigInt(buffer.readUInt32LE(0))).toString();
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
      setViewer({ state: "error", message: "A separate CodeWalker window is open. Close it and restart the editor." });
      return;
    }
    if (Date.now() > deadline) {
      setViewer({ state: "error", message: "The previous CodeWalker is still running. End CodeWalker.exe in Task Manager and restart the editor." });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!fs.existsSync(codewalkerExe)) {
    setViewer({ state: "error", message: `CodeWalker not found: ${codewalkerExe}` });
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
    loadedProjectId = null;
    if (window) {
      setViewer({ state: "error", message: `CodeWalker exited (exit code ${code}).` });
      notify("error", "The 3D view stopped", `CodeWalker exited (exit code ${code}). Restart the editor to get it back.`);
    }
  });

  // Keep watching for the whole session: CodeWalker takes a while to load the game and can also
  // stop answering later.
  let lastState = "";
  while (codewalkerProcess === child && window) {
    let next: ViewerStatus;
    try {
      const status = await codewalker.status();
      if (!boundsSent && viewportBounds && !viewerHidden) {
        await codewalker.setEmbedBounds(viewportBounds);
        boundsSent = true;
        log(`viewport bounds sent: ${JSON.stringify(viewportBounds)}`);
      }
      next = status.worldLoaded ? { state: "ready", propCount: status.propCount } : { state: "loading" };
    } catch (err) {
      next = { state: "starting" };
      if (lastState !== "starting") log(`status check failed: ${errorText(err)}`);
    }
    if (next.state !== lastState) log(`viewer state: ${lastState || "(none)"} -> ${next.state}`);
    const becameReady = next.state === "ready" && lastState !== "ready";
    lastState = next.state;
    if (codewalkerProcess === child) setViewer(next);
    if (becameReady) {
      pushCameraSettings().catch((err: unknown) => notify("warning", "Camera settings not applied", errorText(err), "camera-settings"));
      loadProjectMap().catch((err: unknown) => notify("error", "The project's map couldn't be loaded", errorText(err), "map-load"));
    } else if (next.state === "ready" && (!busy || Date.now() - lastSaveAt > 30_000)) {
      // While the agent works, save now and then rather than after every placement: a long turn shouldn't
      // leave minutes of work unsaved.
      saveProject().catch(() => {}); // saveProject reports failures itself
    }
    await new Promise((resolve) => setTimeout(resolve, next.state === "ready" ? 3000 : 1000));
  }
}

ipcMain.handle("viewer:bounds", async (_event, bounds: { x: number; y: number; width: number; height: number }) => {
  viewportBounds = bounds;
  if (viewerHidden) return; // applied when the view comes back
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

// ---------- the project's map ----------

// Takes the 3D view out of sight (so the page's loading screen shows in its place) and brings it back. The
// window keeps its size: CodeWalker's renderer can't handle a tiny one.
async function hideViewer() {
  if (viewerHidden || !viewportBounds || viewer.state !== "ready") return;
  viewerHidden = true;
  await codewalker.releaseEmbedFocus().catch(() => {}); // keys would otherwise go to the invisible view
  await codewalker.setEmbedBounds({ ...viewportBounds, x: -20000, y: -20000 }).catch(() => {});
}

async function showViewer() {
  if (!viewerHidden) return;
  viewerHidden = false;
  if (viewportBounds) await codewalker.setEmbedBounds(viewportBounds).catch(() => (boundsSent = false));
}

// Loads the open project's map into CodeWalker, once the world is loaded (and again if CodeWalker restarts).
async function loadProjectMap() {
  const p = project;
  if (!p || viewer.state !== "ready" || loadedProjectId === p.id) return;
  if (fs.existsSync(p.ymapPath)) {
    await codewalker.openMap(p.ymapPath, true);
    await layout.load(p.ymapPath);
  } else {
    await codewalker.newMap(true); // a new project: the map file is written with the first autosave
    layout.reset();
  }
  loadedProjectId = p.id;
  window?.webContents.send("map:changed");
}

// Writes the open project's map and folder layout if they changed. Saves run one at a time.
let saving: Promise<unknown> = Promise.resolve();
let lastSaveAt = 0;
function saveProject(): Promise<void> {
  const run = saving.then(async () => {
    const p = project;
    if (!p || loadedProjectId !== p.id) return;
    lastSaveAt = Date.now();
    const status = await codewalker.status();
    if (status.unsaved && status.projectOpen) await codewalker.saveProject(p.ymapPath);
    if (status.unsaved || layout.dirty) await layout.save(p.ymapPath);
  });
  saving = run.then(
    () => clearNotice("autosave"),
    (err: unknown) => notify("error", "Autosave failed", `${errorText(err)}. Your changes are still in the editor; it will keep trying.`, "autosave"),
  );
  return run;
}

ipcMain.handle("map:state", async () => {
  try {
    const [status, props] = await Promise.all([codewalker.status(), layout.props()]);
    return { status, props, folders: layout.listFolders(), project: project && { id: project.id, name: project.name, slug: project.slug } };
  } catch {
    return null;
  }
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
ipcMain.handle("layout:prop-hidden", (_event, id: number, hidden: boolean) => layout.setPropsHidden([id], hidden));

// Saves the project, then exports it; name defaults to the project's.
async function exportProject(name: string | undefined, target: ExportTarget) {
  const p = project;
  if (!p || loadedProjectId !== p.id) throw new Error("The project's map isn't loaded yet.");
  await saveProject();
  return exportMap(p, name ?? p.slug, target);
}

ipcMain.handle("export:targets", () => EXPORT_TARGETS.map((id) => ({ id, ...EXPORT_TARGET_INFO[id] })));

ipcMain.handle("map:export", async (_event, name: string, target: ExportTarget) => {
  const result = await exportProject(name, target);
  updateSettings({ export: { target } });
  return result;
});

// Opens an export's folder, or shows an exported file in its folder.
ipcMain.handle("shell:show-folder", (_event, target: string) => {
  if (!path.resolve(target).startsWith(path.resolve(mapsDir))) return;
  if (fs.statSync(target, { throwIfNoEntry: false })?.isDirectory()) return shell.openPath(target);
  shell.showItemInFolder(target);
});

ipcMain.handle("clipboard:write", (_event, text: string) => clipboard.writeText(String(text)));

ipcMain.handle("app:info", () => ({ name: APP_NAME, version: app.getVersion() }));

// ---------- agent ----------

const host: AgentHost = { workDir: agentDir, exportMap: exportProject };

// Flattens SDK messages into the few event kinds the chat UI renders.
function forward(message: SDKMessage) {
  switch (message.type) {
    case "assistant":
    case "user":
      for (const event of messageEvents(message.type, message.message, false)) emit(event);
      break;
    case "system":
      if (message.subtype === "init") {
        emit({ kind: "ready", model: message.model });
        if (threadId !== message.session_id) {
          // A new chat got its id: file it under the open project. Projects can't change while the agent works.
          threadId = message.session_id;
          if (project) {
            const threads = projects.threads(project);
            threads.add(threadId);
            threads.lastThreadId = threadId;
          }
          emit({ kind: "thread", id: threadId });
        }
      }
      break;
    case "rate_limit_event": {
      const info = message.rate_limit_info;
      emit({ kind: "rate_limit", status: info.status, limitType: info.rateLimitType, utilization: info.utilization, resetsAt: info.resetsAt });
      break;
    }
    case "result": {
      setHistoryGroup(undefined);
      busy = false;
      saveProject().catch(() => {}); // saveProject reports failures itself
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
      const ok = message.subtype === "success" && !message.is_error;
      // A turn the user stopped ends with an execution error that means nothing to them.
      if (stopRequested && !ok) emit({ kind: "interrupted" });
      emit({
        kind: "done",
        ok,
        error: stopRequested ? undefined : message.subtype === "success" ? (message.is_error ? message.result : undefined) : message.errors.join("\n") || message.subtype,
      });
      stopRequested = false;
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

// The conversation for the open chat, started on first use: a new one, or the saved one being continued.
function ensureSession(): EditorSession {
  if (session) return session;
  const { model, effort } = getSettings();
  const resume = threadId ?? undefined;
  const created = new EditorSession(forward, { host, model: process.env.MAP_EDITOR_MODEL ?? model, effort, resume });
  session = created;
  sessionFirstMessage = true;
  sessionResumed = !!resume;
  created.start().catch((err: unknown) => {
    if (session !== created) return; // replaced by another chat meanwhile
    busy = false;
    session = null;
    emit({ kind: "fatal", message: errorText(err) });
  });
  return created;
}

function closeSession() {
  session?.close();
  session = null;
}

// A note for the agent at the start of a conversation (new or reopened): which project it is in and what the
// map holds now. Reopened chats are also warned that the scene may have moved on without them.
async function editorContext(): Promise<string | null> {
  if (!sessionFirstMessage) return null;
  sessionFirstMessage = false;
  const parts: string[] = [];
  if (sessionResumed) {
    parts.push("This chat was reopened from history; the map may have changed since the messages above (other chats of the project edit the same map).");
  }
  try {
    const status = await codewalker.status();
    parts.push(`Project: "${project?.name}". The map has ${status.propCount} props.`);
  } catch {
    // CodeWalker not answering; the agent will find out from its tools.
  }
  if (sessionResumed) parts.push("Prop ids from earlier messages may now belong to other props or to none: call list_props before changing existing props.");
  return parts.length ? parts.join(" ") : null;
}

function isSettled(id: string | null) {
  return !!(id && project && projects.threads(project).meta(id).settled);
}

ipcMain.handle("agent:send", async (_event, text: string) => {
  if (busy) throw new Error("The agent is still answering.");
  if (!project) throw new Error("No project is open.");
  if (isSettled(threadId)) throw new Error("This chat is settled. Unsettle it to continue, or start a new chat.");
  busy = true;
  stopRequested = false;
  try {
    // Everything the agent changes while answering this message becomes one undo step.
    setHistoryGroup(`turn-${Date.now()}`);
    beginUserRequest(text);
    ensureSession();
    const note = await editorContext();
    session!.send(note ? withEditorContext(note, text) : text);
  } catch (err) {
    busy = false;
    throw err;
  }
});

ipcMain.handle("agent:interrupt", async () => {
  if (busy) stopRequested = true;
  await session?.interrupt();
});

ipcMain.handle("agent:models", async () => ensureSession().supportedModels());

// ---------- projects and chats ----------

function assertIdle() {
  if (busy) throw new Error("The agent is still answering. Wait for it or press Stop first.");
}

function requireProject(id: string) {
  const p = projects.get(id);
  if (!p) throw new Error("This project no longer exists.");
  return p;
}

// Makes a chat the open one (null = a new chat), continuing its conversation when a message is sent.
function selectThread(id: string | null) {
  if (id === threadId) return;
  closeSession();
  threadId = id;
  if (project) projects.threads(project).lastThreadId = id ?? undefined;
}

// Opens a project, saving the one that was open, and one of its chats: the given one, a new one (null), or the
// one it had open last (undefined).
async function openProject(id: string, thread?: string | null) {
  const next = requireProject(id);
  if (project?.id !== id) {
    assertIdle();
    await saveProject(); // if this fails, stay where the unsaved work is
    closeSession();
    threadId = null;
    project = next;
    projects.lastProjectId = id;
    loadedProjectId = null;
    layout.reset();
    window?.webContents.send("map:changed");
    // The old map disappears and the camera jumps to the new one: show a loading screen instead of that, for
    // long enough to register even when the map is small.
    const started = Date.now();
    await hideViewer();
    try {
      await loadProjectMap(); // or once the world has loaded
    } finally {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 600 - (Date.now() - started))));
      await showViewer();
    }
    if (thread === undefined) {
      const last = projects.threads(next).lastThreadId;
      thread = last && (await chats.exists(last)) ? last : null;
    }
  }
  if (thread !== undefined && thread !== threadId) {
    assertIdle();
    if (thread && !(await chats.exists(thread))) throw new Error("This chat no longer exists.");
    selectThread(thread);
  }
}

// What the UI shows for the open project and chat.
async function openState() {
  const p = project!;
  const threads = projects.threads(p);
  const summary = threadId ? chats.summaries(threads, await chats.sessions()).find((t) => t.id === threadId) ?? null : null;
  const propCount = loadedProjectId === p.id ? await codewalker.status().then((s) => s.propCount, () => null) : null;
  return {
    project: { id: p.id, name: p.name, slug: p.slug, propCount },
    thread: summary,
    events: threadId ? await chats.history(threadId) : [],
  };
}

ipcMain.handle("projects:list", async () => {
  const sessions = await chats.sessions();
  return {
    currentProjectId: project?.id ?? null,
    currentThreadId: threadId,
    projects: projects.list().map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      threads: chats.summaries(projects.threads(p), sessions),
    })),
  };
});

ipcMain.handle("projects:current", () => openState());

ipcMain.handle("projects:open", async (_event, id: string) => {
  await openProject(id);
  return openState();
});

ipcMain.handle("projects:create", async (_event, name: string) => {
  assertIdle();
  const created = projects.create(name);
  await openProject(created.id, null);
  return openState();
});

// Returns null if the user cancels the file picker.
ipcMain.handle("projects:import", async () => {
  assertIdle();
  if (!window) return null;
  const picked = await dialog.showOpenDialog(window, {
    title: "Import a map as a new project",
    filters: [{ name: "GTA V map", extensions: ["ymap"] }],
    properties: ["openFile"],
  });
  if (picked.canceled || picked.filePaths.length === 0) return null;
  const created = projects.importYmap(picked.filePaths[0]);
  await openProject(created.id, null);
  return openState();
});

ipcMain.handle("projects:rename", (_event, id: string, name: string) => {
  projects.rename(id, name);
  if (project?.id === id) project = projects.get(id)!;
});

ipcMain.handle("projects:show-folder", (_event, id: string) => shell.openPath(requireProject(id).dir));

// Moves the project folder to the Recycle Bin and deletes its chats. Returns whether it was deleted.
ipcMain.handle("projects:delete", async (_event, id: string) => {
  const p = requireProject(id);
  if (project?.id === id) assertIdle();
  if (!window) return false;
  const threadIds = projects.threads(p).ids();
  const { response } = await dialog.showMessageBox(window, {
    type: "warning",
    buttons: ["Delete project", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Delete the project "${p.name}"?`,
    detail: `Its folder (map, layout and exports) goes to the Recycle Bin. Its ${threadIds.length} chat(s) are deleted for good.`,
  });
  if (response !== 0) return false;
  const wasOpen = project?.id === id;
  if (wasOpen) {
    closeSession();
    project = null;
    threadId = null;
    loadedProjectId = null;
  }
  await shell.trashItem(p.dir);
  projects.forget(id);
  for (const thread of threadIds) {
    await chats.remove(thread).catch((err: unknown) => log(`chat ${thread} not deleted: ${errorText(err)}`));
  }
  if (wasOpen) {
    const next = projects.list()[0] ?? projects.create("Untitled project");
    await openProject(next.id);
  }
  return true;
});

ipcMain.handle("threads:new", async (_event, projectId: string) => {
  await openProject(projectId, null);
  return openState();
});

ipcMain.handle("threads:open", async (_event, projectId: string, id: string) => {
  await openProject(projectId, id);
  return openState();
});

ipcMain.handle("threads:rename", (_event, id: string, title: string) => chats.rename(id, title));

ipcMain.handle("threads:pin", (_event, projectId: string, id: string, pinned: boolean) =>
  projects.threads(requireProject(projectId)).update(id, { pinned }),
);

// Settled chats are read-only until unsettled.
ipcMain.handle("threads:settle", (_event, projectId: string, id: string, settled: boolean) => {
  if (settled && id === threadId) assertIdle();
  projects.threads(requireProject(projectId)).update(id, { settled });
});

// Returns whether the chat was deleted (the user can cancel).
ipcMain.handle("threads:delete", async (_event, projectId: string, id: string, title: string) => {
  const p = requireProject(projectId);
  if (id === threadId) assertIdle();
  if (!window) return false;
  const { response } = await dialog.showMessageBox(window, {
    type: "warning",
    buttons: ["Delete", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    message: `Delete "${title}"?`,
    detail: "The conversation is removed for good. Props it placed stay in the map.",
  });
  if (response !== 0) return false;
  if (id === threadId) selectThread(null);
  await chats.remove(id);
  projects.threads(p).forget(id);
  return true;
});

// ---------- settings ----------

ipcMain.handle("settings:get", () => getSettings());

// Saves a partial change and applies it where it lives: the running conversation, CodeWalker's camera, or
// (critic and look settings) nothing, since those are read when used. Returns the saved settings and, if
// applying failed, why (the change is still saved).
ipcMain.handle("settings:set", async (_event, patch: SettingsPatch) => {
  const before = getSettings();
  const after = updateSettings(patch);
  let applyError: string | undefined;
  try {
    if (after.model !== before.model) await session?.setModel(after.model);
    if (after.effort !== before.effort) await session?.setEffort(after.effort);
  } catch (err) {
    applyError = errorText(err);
  }
  if (patch.camera && viewer.state === "ready") {
    try {
      await pushCameraSettings();
    } catch (err) {
      applyError = err instanceof CodeWalkerError && /unknown endpoint/.test(err.message)
        ? "This CodeWalker build doesn't support camera settings; close the editor and rebuild with npm run start:all."
        : errorText(err);
    }
  }
  return { settings: after, applyError };
});

// ---------- app lifecycle ----------

// CodeWalker is hosted as a native child window over the viewport. With DirectComposition,
// Chromium composites its output above child windows, which hides the 3D view entirely.
app.commandLine.appendSwitch("disable-direct-composition");

// Projects, older maps and chats brought into projects, and the project and chat that were open last time.
async function openStartProject() {
  projects = new ProjectStore(mapsDir, path.join(userDataDir, "state.json"));
  chats = new ThreadStore(agentDir);
  try {
    for (const p of projects.migrateLooseMaps()) log(`map moved into project "${p.name}"`);
    const legacyChats = path.join(userDataDir, "threads.json");
    if (fs.existsSync(legacyChats)) {
      for (const m of projects.migrateLegacyChats(legacyChats, await chats.sessions())) log(`chat "${m.chat}" moved to project "${m.project}"`);
    }
  } catch (err) {
    log(`migration failed: ${errorText(err)}`);
  }
  const start = projects.get(projects.lastProjectId ?? "") ?? projects.list()[0] ?? projects.create("Untitled project");
  project = start;
  projects.lastProjectId = start.id;
  const last = projects.threads(start).lastThreadId;
  threadId = last && (await chats.exists(last)) ? last : null;
}

app.whenReady().then(async () => {
  loadSettings(path.join(userDataDir, "settings.json"));
  await openStartProject();

  window = new BrowserWindow({
    width: 1600,
    height: 900,
    title: APP_NAME,
    icon: path.join(editorDir, "assets", process.platform === "win32" ? "icon.ico" : "icon.png"),
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
  // The window title is the app name, whatever the page's <title> says.
  window.on("page-title-updated", (event) => event.preventDefault());
  // Links in chat replies open in the browser, never in the editor window.
  window.webContents.on("will-navigate", (event, url) => {
    event.preventDefault();
    if (/^https?:/.test(url)) void shell.openExternal(url);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.loadFile(path.join(editorDir, "renderer", "index.html"));
  window.on("closed", () => (window = null));

  // Save before closing; the save is async, so cancel once and re-close. Only if saving fails is the user asked.
  let closeConfirmed = false;
  window.on("close", (event) => {
    if (closeConfirmed) return;
    event.preventDefault();
    void (async () => {
      try {
        await saveProject();
      } catch (err) {
        if (!window) return;
        const { response } = await dialog.showMessageBox(window, {
          type: "warning",
          buttons: ["Close without saving", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          message: "The map couldn't be saved.",
          detail: errorText(err),
        });
        if (response !== 0) return;
      }
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
