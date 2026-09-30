// Sandboxed preloads must be CommonJS, hence .cts.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("editor", {
  appInfo: () => ipcRenderer.invoke("app:info"),
  copyText: (text: string) => ipcRenderer.invoke("clipboard:write", text),

  send: (text: string) => ipcRenderer.invoke("agent:send", text),
  interrupt: () => ipcRenderer.invoke("agent:interrupt"),
  models: () => ipcRenderer.invoke("agent:models"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  updateSettings: (patch: unknown) => ipcRenderer.invoke("settings:set", patch),
  onEvent: (callback: (event: unknown) => void) => {
    ipcRenderer.on("agent:event", (_e, event) => callback(event));
  },

  listProjects: () => ipcRenderer.invoke("projects:list"),
  currentProject: () => ipcRenderer.invoke("projects:current"),
  openProject: (id: string) => ipcRenderer.invoke("projects:open", id),
  createProject: (name: string) => ipcRenderer.invoke("projects:create", name),
  importProject: () => ipcRenderer.invoke("projects:import"),
  renameProject: (id: string, name: string) => ipcRenderer.invoke("projects:rename", id, name),
  showProjectFolder: (id: string) => ipcRenderer.invoke("projects:show-folder", id),
  deleteProject: (id: string): Promise<boolean> => ipcRenderer.invoke("projects:delete", id),
  newThread: (projectId: string) => ipcRenderer.invoke("threads:new", projectId),
  openThread: (projectId: string, id: string) => ipcRenderer.invoke("threads:open", projectId, id),
  renameThread: (id: string, title: string) => ipcRenderer.invoke("threads:rename", id, title),
  pinThread: (projectId: string, id: string, pinned: boolean) => ipcRenderer.invoke("threads:pin", projectId, id, pinned),
  settleThread: (projectId: string, id: string, settled: boolean) => ipcRenderer.invoke("threads:settle", projectId, id, settled),
  deleteThread: (projectId: string, id: string, title: string): Promise<boolean> =>
    ipcRenderer.invoke("threads:delete", projectId, id, title),
  onMapChanged: (callback: () => void) => {
    ipcRenderer.on("map:changed", () => callback());
  },

  setViewportBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke("viewer:bounds", bounds),
  viewerStatus: () => ipcRenderer.invoke("viewer:status"),
  releaseViewportFocus: () => ipcRenderer.invoke("viewer:release-focus"),
  onViewerStatus: (callback: (status: unknown) => void) => {
    ipcRenderer.on("viewer:status", (_e, status) => callback(status));
  },

  mapState: () => ipcRenderer.invoke("map:state"),
  cameraMode: (mode: string) => ipcRenderer.invoke("camera:mode", mode),
  cameraPreset: (name: string) => ipcRenderer.invoke("camera:preset", name),
  cameraRotate: (degrees: number) => ipcRenderer.invoke("camera:rotate", degrees),
  cameraZoom: (factor: number) => ipcRenderer.invoke("camera:zoom", factor),
  cameraFocus: (ids?: number[]) => ipcRenderer.invoke("camera:focus", ids),
  deleteProp: (id: number) => ipcRenderer.invoke("props:delete", id),
  undo: () => ipcRenderer.invoke("map:undo"),
  redo: () => ipcRenderer.invoke("map:redo"),
  createFolder: (name: string) => ipcRenderer.invoke("layout:create-folder", name),
  renameFolder: (from: string, to: string) => ipcRenderer.invoke("layout:rename-folder", from, to),
  deleteFolder: (name: string) => ipcRenderer.invoke("layout:delete-folder", name),
  assignFolder: (ids: number[], folder: string | null) => ipcRenderer.invoke("layout:assign", ids, folder),
  setFolderHidden: (name: string, hidden: boolean) => ipcRenderer.invoke("layout:folder-hidden", name, hidden),
  setPropHidden: (id: number, hidden: boolean) => ipcRenderer.invoke("layout:prop-hidden", id, hidden),
  exportTargets: () => ipcRenderer.invoke("export:targets"),
  exportMap: (name: string, target: string) => ipcRenderer.invoke("map:export", name, target),
  showFolder: (target: string) => ipcRenderer.invoke("shell:show-folder", target),
});
