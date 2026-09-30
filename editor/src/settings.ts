import fs from "node:fs";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { LOOK_VIEWS, type LookView } from "./codewalker.js";
import { EXPORT_TARGETS, type ExportTarget } from "./export.js";

// Editor settings, stored in the app's userData folder. Everything is read at the moment it is used, so a
// change applies to the next request (or immediately, for the camera) without restarting the conversation.

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface CameraSettings {
  moveSpeed: number; // multiplier on CodeWalker's WASD speed
  sensitivity: number; // multiplier on CodeWalker's mouse-look sensitivity
  smoothing: number; // CodeWalker camera smoothness: higher follows the mouse more tightly
  fovDegrees: number; // vertical field of view
  invertMouse: boolean;
}

export interface EditorSettings {
  model?: string; // undefined = account default
  effort?: EffortLevel; // undefined = the model's default
  critic: {
    enabled: boolean;
    model?: string; // undefined = same as the builder
    effort?: EffortLevel;
    maxRounds: number; // reviews per user request
    maxTurns: number; // tool-use turns per review
  };
  look: {
    views: LookView[]; // what look_at_scene renders when the agent doesn't pick views
  };
  camera: CameraSettings;
  export: {
    target: ExportTarget; // last target used in the export form
  };
}

export const DEFAULT_SETTINGS: EditorSettings = {
  critic: { enabled: true, maxRounds: 5, maxTurns: 16 },
  look: { views: ["top", "south", "east"] },
  camera: { moveSpeed: 1, sensitivity: 1, smoothing: 10, fovDegrees: 57, invertMouse: false },
  export: { target: "fivem" },
};

export type SettingsPatch = {
  model?: string | null;
  effort?: EffortLevel | null;
  critic?: Partial<{ [K in keyof EditorSettings["critic"]]: EditorSettings["critic"][K] | null }>;
  look?: Partial<EditorSettings["look"]>;
  camera?: Partial<CameraSettings>;
  export?: Partial<EditorSettings["export"]>;
};

let filePath = "";
let current: EditorSettings = structuredClone(DEFAULT_SETTINGS);

const clamp = (value: unknown, min: number, max: number, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

const effort = (value: unknown) => (EFFORT_LEVELS.includes(value as EffortLevel) ? (value as EffortLevel) : undefined);

const model = (value: unknown) => (typeof value === "string" && value && value !== "default" ? value : undefined);

// Fills in defaults and drops anything out of range, so a hand-edited or older settings file can't break the editor.
function normalize(raw: any): EditorSettings {
  const d = DEFAULT_SETTINGS;
  const views = Array.isArray(raw?.look?.views) ? raw.look.views.filter((v: unknown) => LOOK_VIEWS.includes(v as LookView)) : [];
  return {
    model: model(raw?.model),
    effort: effort(raw?.effort),
    critic: {
      enabled: typeof raw?.critic?.enabled === "boolean" ? raw.critic.enabled : d.critic.enabled,
      model: model(raw?.critic?.model),
      effort: effort(raw?.critic?.effort),
      maxRounds: Math.round(clamp(raw?.critic?.maxRounds, 1, 10, d.critic.maxRounds)),
      maxTurns: Math.round(clamp(raw?.critic?.maxTurns, 6, 40, d.critic.maxTurns)),
    },
    look: { views: views.length ? [...new Set<LookView>(views)] : d.look.views },
    camera: {
      moveSpeed: clamp(raw?.camera?.moveSpeed, 0.1, 5, d.camera.moveSpeed),
      sensitivity: clamp(raw?.camera?.sensitivity, 0.2, 3, d.camera.sensitivity),
      smoothing: clamp(raw?.camera?.smoothing, 1, 30, d.camera.smoothing),
      fovDegrees: clamp(raw?.camera?.fovDegrees, 30, 100, d.camera.fovDegrees),
      invertMouse: typeof raw?.camera?.invertMouse === "boolean" ? raw.camera.invertMouse : d.camera.invertMouse,
    },
    export: { target: EXPORT_TARGETS.includes(raw?.export?.target) ? raw.export.target : d.export.target },
  };
}

export function loadSettings(path: string) {
  filePath = path;
  try {
    current = normalize(JSON.parse(fs.readFileSync(path, "utf8")));
  } catch {
    current = structuredClone(DEFAULT_SETTINGS);
  }
}

export function getSettings(): EditorSettings {
  return current;
}

// null clears an optional value back to its default.
export function updateSettings(patch: SettingsPatch): EditorSettings {
  const merged: any = {
    ...current,
    critic: { ...current.critic, ...patch.critic },
    look: { ...current.look, ...patch.look },
    camera: { ...current.camera, ...patch.camera },
    export: { ...current.export, ...patch.export },
  };
  if ("model" in patch) merged.model = patch.model;
  if ("effort" in patch) merged.effort = patch.effort;
  current = normalize(merged);
  if (filePath) fs.writeFileSync(filePath, JSON.stringify(current, null, 2));
  return current;
}
