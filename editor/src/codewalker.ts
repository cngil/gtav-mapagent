// Client for the local HTTP API added to the CodeWalker fork (CodeWalker/LocalApi/LocalApiServer.cs).

const BASE_URL = process.env.CODEWALKER_API ?? "http://127.0.0.1:35873";

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

export interface PlacementResult extends PlacedProp {
  success: true;
  grounded: boolean;
  validation?: Validation;
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

async function post<T>(path: string, body: object = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE_URL + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(`CodeWalker did not answer ${path} within ${timeoutMs / 1000}s`);
    }
    throw new Error(`CodeWalker is not reachable at ${BASE_URL}. Is the CodeWalker fork running?`);
  }
  const json = (await res.json()) as T & { success?: boolean; error?: string };
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

  placeProp: (args: { model: string; forward: number; right: number; up: number; heading: number }) =>
    post<PlacementResult>("/place_entity", { ...args, group: currentGroup }),

  moveProp: (args: { id: number; forward?: number; right?: number; up?: number; turn?: number }) =>
    post<PlacementResult>("/move_prop", { ...args, group: currentGroup }),

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
    post<{ checked: number; problems: { id: number; name: string; validation: Validation }[] }>(
      "/validate",
      ids?.length ? { ids } : {},
      120_000,
    ),

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
  },

  saveProject: (path: string) => post<SaveResult>("/save_project", { path }),
};
