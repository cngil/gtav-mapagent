// Sandboxed preloads must be CommonJS, hence .cts.
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("editor", {
  send: (text: string) => ipcRenderer.invoke("agent:send", text),
  interrupt: () => ipcRenderer.invoke("agent:interrupt"),
  reset: () => ipcRenderer.invoke("agent:reset"),
  models: () => ipcRenderer.invoke("agent:models"),
  setModel: (value: string) => ipcRenderer.invoke("agent:set-model", value),
  openMaps: () => ipcRenderer.invoke("maps:open"),
  onEvent: (callback: (event: unknown) => void) => {
    ipcRenderer.on("agent:event", (_e, event) => callback(event));
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
  newMap: (): Promise<boolean> => ipcRenderer.invoke("map:new"),
  openMap: (): Promise<boolean> => ipcRenderer.invoke("map:open"),
  undo: () => ipcRenderer.invoke("map:undo"),
  redo: () => ipcRenderer.invoke("map:redo"),
  createFolder: (name: string) => ipcRenderer.invoke("layout:create-folder", name),
  renameFolder: (from: string, to: string) => ipcRenderer.invoke("layout:rename-folder", from, to),
  deleteFolder: (name: string) => ipcRenderer.invoke("layout:delete-folder", name),
  assignFolder: (ids: number[], folder: string | null) => ipcRenderer.invoke("layout:assign", ids, folder),
  setFolderHidden: (name: string, hidden: boolean) => ipcRenderer.invoke("layout:folder-hidden", name, hidden),
  setPropHidden: (id: number, hidden: boolean) => ipcRenderer.invoke("layout:prop-hidden", id, hidden),
  exportMap: (name: string) => ipcRenderer.invoke("map:export", name),
  showFolder: (folder: string) => ipcRenderer.invoke("shell:show-folder", folder),
});
