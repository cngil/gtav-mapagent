import fs from "node:fs";
import path from "node:path";
import { codewalker, type SaveResult } from "./codewalker.js";
import { layout } from "./layout.js";

export const MAP_NAME_PATTERN = /^[a-z0-9_-]+$/;

export interface ExportResult {
  ymapPath: string;
  resourceDir: string;
  entityCount: number;
}

// With this_is_a_map, FiveM streams every .ymap in the resource's stream/ folder on its own, so the
// manifest needs no data_file entries.
const FXMANIFEST = `fx_version 'cerulean'
game 'gta5'

this_is_a_map 'yes'
`;

// Saves the current map as maps/<name>.ymap, with its folder layout next to it.
export async function saveMap(name: string, mapsDir: string): Promise<SaveResult> {
  if (!MAP_NAME_PATTERN.test(name)) {
    throw new Error("Name may only contain lowercase letters, digits, _ and -");
  }
  const saved = await codewalker.saveProject(path.join(mapsDir, `${name}.ymap`));
  await layout.save(saved.path);
  return saved;
}

// Saves the map and writes a ready-to-copy FiveM resource to maps/fivem/<name>/
// (fxmanifest.lua + stream/<name>.ymap).
export async function exportFivemResource(name: string, mapsDir: string): Promise<ExportResult> {
  const saved = await saveMap(name, mapsDir);

  const resourceDir = path.join(mapsDir, "fivem", name);
  const streamDir = path.join(resourceDir, "stream");
  fs.mkdirSync(streamDir, { recursive: true });
  fs.writeFileSync(path.join(resourceDir, "fxmanifest.lua"), FXMANIFEST);
  fs.copyFileSync(saved.path, path.join(streamDir, `${name}.ymap`));

  return { ymapPath: saved.path, resourceDir, entityCount: saved.entityCount };
}
