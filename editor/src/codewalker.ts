import { randomBytes } from "node:crypto";
import fs from "node:fs";

// Client for the local HTTP API added to the CodeWalker fork (CodeWalker/LocalApi/LocalApiServer.cs).

const BASE_URL = process.env.CODEWALKER_API ?? "http://127.0.0.1:35873";

// Sent with every call. The editor starts CodeWalker with the same token, and CodeWalker then refuses calls
// without it, so other programs and web pages can't drive the map or write files through it. Set
// MAPAGENT_API_TOKEN yourself to talk to a CodeWalker you started with that variable.
export const API_TOKEN = process.env.MAPAGENT_API_TOKEN || randomBytes(32).toString("hex");

export type Vec3 = [number, number, number];

export interface PropInfo {
  name: string;
  bbMin: Vec3;
  bbMax: Vec3;
  bsRadius: number;
}

// A prop placed in the current map. heading is relative to the camera (0 = front faces the way the
// camera looks, 180 = faces the camera) and distance is from the camera.
export interface PlacedProp {
  id: number;
  name: string;
  position: Vec3;
  heading: number;
  distance: number;
  hidden: boolean;
  index: number; // position within the ymap, stable across save/load
  facing: string; // compass direction the prop's front points to
  worldHeading: number; // degrees counter-clockwise from north
  rotation?: [number, number, number, number]; // world orientation quaternion (x, y, z, w); older CodeWalker builds omit it
  yaw?: number; // the entity's own yaw (local +Y), degrees counter-clockwise from north
}

export const LOOK_VIEWS = ["top", "north", "east", "south", "west", "eye_level"] as const;
export type LookView = (typeof LOOK_VIEWS)[number];

export interface LookResult {
  center: Vec3;
  radius: number;
  legend: string;
  images: { view: LookView; caption: string; mimeType: string; data: string }[];
}

// Geometric check of a placed prop. suggestedMove is a move_prop delta in the camera's frame.
export interface ValidationIssue {
  type: "overlap" | "world_collision" | "floating" | "overhang" | "buried" | "steep_ground" | "no_ground";
  [detail: string]: unknown;
}

export interface Validation {
  ok: boolean;
  issues: ValidationIssue[];
  note?: string;
}

// Where a placement or move spent its time (see LocalApiServer.Timing). Logged, not shown to the agent.
export interface Timing {
  totalMs: number;
  uiMs: number; // in calls to CodeWalker's UI thread
  ground?: PhaseTiming; // finding the ground to rest on
  validation?: PhaseTiming; // the geometric check
}

export interface PhaseTiming {
  ms: number;
  rays: number;
  streamTimeouts: number; // probes that gave up waiting for collision to load
}

export interface PlacementResult extends PlacedProp {
  success: true;
  grounded: boolean;
  validation?: Validation;
  timing?: Timing;
}

// What the user points at in the 3D view: props they clicked and a spot they marked.
export interface ViewContext {
  version: number;
  selection: PlacedProp[];
  marker: { position: Vec3; distance: number; forward: number; right: number } | null;
  markArmed: boolean; // the next click in the view marks the spot
  markPending: boolean; // a click is being turned into a spot
  markError: string | null; // why the last attempt to mark found no spot
}

export interface Status {
  worldLoaded: boolean;
  embedded: boolean;
  projectOpen: boolean;
  propCount: number;
  unsaved: boolean;
  undoSteps: number;
  redoSteps: number;
  mapName: string | null;
  cameraMode: CameraMode;
}

export type CameraMode = "3d" | "2d";
export type CameraPreset = "eye_level" | "bird" | "north";

// Camera feel, applied in memory only; the editor's settings are the source of truth.
export interface CameraSettings {
  moveSpeed: number;
  sensitivity: number;
  smoothing: number;
  fovDegrees: number;
  invertMouse: boolean;
}

export interface CameraState {
  mode: CameraMode;
  position: Vec3;
  heading: number; // degrees counter-clockwise from north
}

// Thrown for API failures; `details` is the error response body (e.g. { unsaved: true }).
export class CodeWalkerError extends Error {
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

// Edits made while a group is set become one undo step (the main process sets it per agent turn).
let currentGroup: string | undefined;

export function setHistoryGroup(group: string | undefined) {
  currentGroup = group;
}

export function getHistoryGroup() {
  return currentGroup;
}

export interface SaveResult {
  success: true;
  path: string;
  bytes: number;
  entityCount: number;
  warnings?: string[];
}

// Ground snapping retries for a few seconds while collision streams in, so allow well beyond that.
const DEFAULT_TIMEOUT_MS = 30_000;
// A placement may wait for collision twice (finding the ground, then its check), up to 12 s each. The client
// must outlast that: on a timeout the agent tries again while the first placement still lands, which
// duplicates the prop.
const EDIT_TIMEOUT_MS = 60_000;

const LOG_LIMIT_BYTES = 2_000_000;
let timingLog: string | null = null;

// Logs placements and moves with CodeWalker's breakdown of where the time went, and any other call that was
// slow or failed, to find out what makes some placements slow. The editor's own frequent calls are fast and
// stay out of it.
export function setTimingLog(file: string) {
  timingLog = file;
}

function logTiming(path: string, ms: number, outcome: string, timing: unknown) {
  if (!timingLog || (!timing && ms < 1000 && outcome === "ok")) return;
  try {
    if ((fs.statSync(timingLog, { throwIfNoEntry: false })?.size ?? 0) > LOG_LIMIT_BYTES) fs.renameSync(timingLog, `${timingLog}.old`);
    const extra = timing ? ` ${JSON.stringify(timing)}` : "";
    fs.appendFileSync(timingLog, `${new Date().toISOString()} ${path} ${ms}ms ${outcome}${extra}\n`);
  } catch {
    // Diagnostics only.
  }
}

async function post<T>(path: string, body: object = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(BASE_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-MapAgent-Token": API_TOKEN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      logTiming(path, Date.now() - started, "timeout", null);
      throw new Error(`CodeWalker did not answer ${path} within ${timeoutMs / 1000}s`);
    }
    throw new Error(`CodeWalker is not reachable at ${BASE_URL}. Is the CodeWalker fork running?`);
  }
  let json: T & { success?: boolean; error?: string; timing?: unknown };
  try {
    json = await res.json();
  } catch {
    logTiming(path, Date.now() - started, "failed", null);
    throw new CodeWalkerError(`CodeWalker API ${path} failed with HTTP ${res.status}`);
  }
  logTiming(path, Date.now() - started, res.ok && json.success !== false ? "ok" : "failed", json.timing);
  if (!res.ok || json.success === false) {
    throw new CodeWalkerError(json.error ?? `CodeWalker API ${path} failed with HTTP ${res.status}`, json);
  }
  return json;
}

export const codewalker = {
  status: () => post<Status>("/status", {}, 5_000),

  setEmbedBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
    post<object>("/embed/bounds", bounds, 5_000),

  releaseEmbedFocus: () => post<object>("/embed/release_focus", {}, 2_000),

  // CodeWalker returns matches in archetype-table order, where interior-only models (v_*) often
  // crowd out the placeable prop_* models, so over-fetch and rank before truncating.
  searchProps: (query: string, maxResults = 20) =>
    post<{ results: PropInfo[] }>("/search_props", { query, maxResults: 500 }).then((r) =>
      r.results
        .map((prop, index) => ({ prop, index, rank: prop.name.startsWith("prop_") ? 0 : prop.name.startsWith("v_") ? 2 : 1 }))
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .slice(0, maxResults)
        .map((entry) => entry.prop),
    ),

  // at_marker: forward/right are measured from the spot the user marked instead of from the camera.
  placeProp: (args: { model: string; forward: number; right: number; up: number; heading: number; face_id?: number; at_marker?: boolean }) =>
    post<PlacementResult>("/place_entity", { ...args, group: currentGroup }, EDIT_TIMEOUT_MS),

  moveProp: (args: {
    id: number;
    forward?: number;
    right?: number;
    north?: number;
    east?: number;
    up?: number;
    turn?: number;
    world_heading?: number;
    face_id?: number;
    to_marker?: boolean; // start from the marked spot instead of where the prop is
  }) =>
    post<PlacementResult>("/move_prop", { ...args, group: currentGroup }, EDIT_TIMEOUT_MS),

  deleteProp: (id: number, group = currentGroup) => post<{ id: number }>("/delete_prop", { id, group }),

  // exceptGroup lets an agent turn undo the previous turn instead of its own edits.
  undo: (exceptGroup?: string) => post<{ reverted: number; undoSteps: number; redoSteps: number }>("/undo", { exceptGroup }),

  redo: () => post<{ reverted: number; undoSteps: number; redoSteps: number }>("/redo"),

  // Editor-only: hidden props aren't rendered but stay in the map and in saved files.
  setVisibility: (ids: number[], visible: boolean) => post<{ changed: number }>("/set_visibility", { ids, visible }),

  openMap: (path: string, discardChanges = false) =>
    post<{ mapName: string; propCount: number }>("/open_map", { path, discardChanges }),

  newMap: (discardChanges = false) => post<object>("/new_map", { discardChanges }),

  // Only props with problems are returned. Checks every prop when ids is omitted.
  validate: (ids?: number[]) =>
    post<{ checked: number; problems: { id: number; name: string; validation: Validation }[]; timing?: unknown }>(
      "/validate",
      ids?.length ? { ids } : {},
      120_000,
    ),

  // Renders annotated views of the scene; moves the camera while capturing and restores it.
  look: (args: { ids?: number[]; views?: LookView[] }) => post<LookResult>("/look", args, 180_000),

  listProps: (radius?: number) =>
    post<{ results: PlacedProp[] }>("/list_props", radius === undefined ? {} : { radius }).then((r) => r.results),

  getCameraView: () => post<{ position: Vec3; forward: Vec3 }>("/get_camera_view"),

  camera: {
    setMode: (mode: CameraMode) => post<CameraState>("/camera/mode", { mode }),
    preset: (name: CameraPreset) => post<CameraState>("/camera/preset", { name }),
    // Orbit around the point being looked at; positive = counter-clockwise from above.
    rotate: (degrees: number) => post<CameraState>("/camera/rotate", { degrees }),
    // 2D map only; below 1 zooms in.
    zoom: (factor: number) => post<CameraState>("/camera/zoom", { factor }),
    // Frame the given props, or all props when ids is omitted.
    // Without ids: the largest group of nearby props, then the next group on each call.
    focus: (ids?: number[]) =>
      post<{ focused: number; cluster: number; clusters: number }>("/camera/focus", ids ? { ids } : {}),
    settings: (settings: CameraSettings) => post<CameraSettings>("/camera/settings", settings, 5_000),
  },

  saveProject: (path: string) => post<SaveResult>("/save_project", { path }),

  // The selection and marked spot. With `since`, an unchanged state answers just { version, unchanged }.
  viewContext: (since?: number) =>
    post<ViewContext | { version: number; unchanged: true }>("/context", since === undefined ? {} : { since }, 5_000),

  // Selects props in the view, as if the user had clicked them; [] clears the selection.
  select: (ids: number[]) => post<ViewContext>("/selection", { ids }, 5_000),

  // arm: the next click in the view marks the spot (false cancels); clear: removes the marked spot.
  marker: (change: { arm?: boolean; clear?: boolean }) => post<ViewContext>("/marker", change, 5_000),
};
