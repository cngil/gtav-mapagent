import fs from "node:fs";
import path from "node:path";
import { APP_NAME } from "./app-info.js";
import { codewalker, type PlacedProp } from "./codewalker.js";

export const MAP_NAME_PATTERN = /^[a-z0-9_-]+$/;

// Exports go to the project's exports/<target>/ folder. Streaming targets ship the project's .ymap under its own
// file name (which is also its in-game name); the others spawn the same props by script or data file.
export const EXPORT_TARGETS = ["fivem", "altv", "ragemp", "menyoo", "json", "ymap"] as const;
export type ExportTarget = (typeof EXPORT_TARGETS)[number];

export const EXPORT_TARGET_INFO: Record<ExportTarget, { label: string; description: string }> = {
  fivem: { label: "FiveM", description: "FiveM resource that streams the .ymap (fxmanifest.lua + stream/)" },
  altv: { label: "alt:V", description: "alt:V dlc resource that streams the .ymap (resource.toml + stream.toml + stream/)" },
  ragemp: { label: "RAGE:MP", description: "RAGE Multiplayer server package that spawns the props with mp.objects.new" },
  menyoo: { label: "Menyoo (singleplayer)", description: "Menyoo Object Spooner placements file (.xml) for singleplayer" },
  json: { label: "JSON", description: "Plain list of props (model, hash, position, rotation) for your own scripts or tools" },
  ymap: { label: ".ymap only", description: "A copy of the map file, e.g. for OpenIV or your own dlcpack" },
};

export interface ExportResult {
  target: ExportTarget;
  path: string; // the resource folder or file that was written
  entityCount: number;
  nextSteps: string; // how to install it
}

export interface ExportSource {
  dir: string; // project folder
  ymapPath: string; // the project's map, already saved
}

// name: the resource, package or file name (the streamed .ymap keeps its own name).
export async function exportMap(source: ExportSource, name: string, target: ExportTarget): Promise<ExportResult> {
  checkName(name);
  if (!EXPORT_TARGETS.includes(target)) throw new Error(`Unknown export target '${target}'`);
  if (!fs.existsSync(source.ymapPath)) throw new Error("The map is empty; place some props first.");
  const entityCount = (await codewalker.listProps()).length;
  const out = path.join(source.dir, "exports", target);
  const ymapName = path.basename(source.ymapPath);
  const result = (written: string, nextSteps: string): ExportResult => ({ target, path: written, entityCount, nextSteps });

  switch (target) {
    case "ymap": {
      fs.mkdirSync(out, { recursive: true });
      const file = path.join(out, ymapName);
      fs.copyFileSync(source.ymapPath, file);
      return result(file, "Add the .ymap to your own resource or dlcpack.");
    }

    case "fivem": {
      // With this_is_a_map, FiveM streams every .ymap in stream/ on its own, so no data_file entries are needed.
      const dir = streamingResource(path.join(out, name), source.ymapPath, {
        "fxmanifest.lua": `fx_version 'cerulean'\ngame 'gta5'\n\nthis_is_a_map 'yes'\n`,
      });
      return result(dir, `Copy the folder into your server's resources/ and add \`ensure ${name}\` to server.cfg.`);
    }

    case "altv": {
      const dir = streamingResource(path.join(out, name), source.ymapPath, {
        "resource.toml": `type = 'dlc'\nmain = 'stream.toml'\n\nclient-files = [ 'stream/*' ]\n`,
        "stream.toml": `files = [ 'stream/*' ]\n\n[meta]\n`,
      });
      return result(dir, `Copy the folder into your server's resources/ and add '${name}' to resources in server.toml.`);
    }

    case "ragemp": {
      const dir = path.join(out, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "index.js"), rageMpScript(name, await exportedProps()));
      return result(dir, "Copy the folder into your server's packages/. The props spawn in dimension 0 when the server starts.");
    }

    case "menyoo": {
      fs.mkdirSync(out, { recursive: true });
      const file = path.join(out, `${name}.xml`);
      fs.writeFileSync(file, menyooXml(await exportedProps()));
      return result(file, "Copy the file to Grand Theft Auto V\\MenyooStuff\\Spooner and load it from Object Spooner → Manage Saved Files.");
    }

    case "json": {
      fs.mkdirSync(out, { recursive: true });
      const file = path.join(out, `${name}.json`);
      const props = await exportedProps();
      const doc = {
        generator: APP_NAME,
        name,
        rotationOrder: "GTA rotation order 2: rotation = Rz(z) * Rx(x) * Ry(y), degrees",
        props: props.map((p) => ({
          model: p.model,
          hash: p.hash,
          position: { x: p.position[0], y: p.position[1], z: p.position[2] },
          rotation: { x: p.rotation[0], y: p.rotation[1], z: p.rotation[2] },
          quaternion: { x: p.quaternion[0], y: p.quaternion[1], z: p.quaternion[2], w: p.quaternion[3] },
        })),
      };
      fs.writeFileSync(file, JSON.stringify(doc, null, 2));
      return result(file, "Read the file from your own script or tool.");
    }
  }
}

function checkName(name: string) {
  if (!MAP_NAME_PATTERN.test(name)) throw new Error("Name may only contain lowercase letters, digits, _ and -");
}

// A resource folder with the given manifest files and the map in stream/. Returns the folder.
function streamingResource(dir: string, ymapPath: string, files: Record<string, string>) {
  fs.mkdirSync(path.join(dir, "stream"), { recursive: true });
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text);
  fs.copyFileSync(ymapPath, path.join(dir, "stream", path.basename(ymapPath)));
  return dir;
}

// ---------- props for script-based targets ----------

interface ExportedProp {
  model: string; // archetype name, or the hash as decimal text when the name is unknown
  hash: number;
  position: [number, number, number];
  rotation: [number, number, number]; // GTA euler degrees (pitch x, roll y, yaw z)
  quaternion: [number, number, number, number];
}

// Hidden props are included: hiding is an editor-only view setting.
async function exportedProps(): Promise<ExportedProp[]> {
  const props = await codewalker.listProps();
  return props.map((p) => {
    if (!p.rotation) throw new Error("This CodeWalker build doesn't report prop rotations; close the editor and rebuild with npm run start:all.");
    const { model, hash } = modelOf(p);
    return {
      model,
      hash,
      position: p.position.map((v) => round(v, 4)) as ExportedProp["position"],
      rotation: gtaEuler(p.rotation).map((v) => round(v, 3)) as ExportedProp["rotation"],
      quaternion: p.rotation.map((v) => round(v, 6)) as ExportedProp["quaternion"],
    };
  });
}

// CodeWalker reports a name it can't resolve as its hash, in decimal or as hash_XXXXXXXX.
function modelOf(p: PlacedProp) {
  const hex = /^hash_([0-9a-f]{8})$/i.exec(p.name);
  if (hex) return { model: String(parseInt(hex[1], 16)), hash: parseInt(hex[1], 16) };
  if (/^\d+$/.test(p.name)) return { model: p.name, hash: Number(p.name) };
  return { model: p.name, hash: joaat(p.name) };
}

// GTA's model name hash (Jenkins one-at-a-time over the lowercase name).
export function joaat(text: string) {
  let h = 0;
  for (const c of text.toLowerCase()) {
    h = (h + c.charCodeAt(0)) >>> 0;
    h = (h + (h << 10)) >>> 0;
    h = (h ^ (h >>> 6)) >>> 0;
  }
  h = (h + (h << 3)) >>> 0;
  h = (h ^ (h >>> 11)) >>> 0;
  return (h + (h << 15)) >>> 0;
}

// World orientation quaternion → the euler angles SET_ENTITY_ROTATION takes with its default rotation order
// (2), where rotation = Rz(z) * Rx(x) * Ry(y). Degrees.
export function gtaEuler([x, y, z, w]: [number, number, number, number]): [number, number, number] {
  const deg = 180 / Math.PI;
  const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (y * z + w * x))));
  const roll = Math.atan2(-2 * (x * z - w * y), 1 - 2 * (x * x + y * y));
  const yaw = Math.atan2(-2 * (x * y - w * z), 1 - 2 * (x * x + z * z));
  return [pitch * deg, roll * deg, yaw * deg];
}

const round = (value: number, digits: number) => Number(value.toFixed(digits)) + 0; // + 0 turns -0 into 0

function rageMpScript(name: string, props: ExportedProp[]) {
  const rows = props.map((p) => `  [${JSON.stringify(p.model)}, ${p.position.join(", ")}, ${p.rotation.join(", ")}],`);
  return `// ${name}: ${props.length} props, generated by ${APP_NAME}.
// [model, x, y, z, rotation x, rotation y, rotation z]
const props = [
${rows.join("\n")}
];

const objects = props.map(([model, x, y, z, rx, ry, rz]) =>
  mp.objects.new(/^\\d+$/.test(model) ? Number(model) : mp.joaat(model), new mp.Vector3(x, y, z), {
    rotation: new mp.Vector3(rx, ry, rz),
    dimension: 0,
  }),
);

module.exports = { objects };
`;
}

function menyooXml(props: ExportedProp[]) {
  const xml = (text: string) => text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const center = props.length
    ? [0, 1, 2].map((i) => round(props.reduce((sum, p) => sum + p.position[i], 0) / props.length, 4))
    : [0, 0, 0];
  const placements = props.map(
    (p) => `  <Placement>
    <ModelHash>0x${p.hash.toString(16).padStart(8, "0")}</ModelHash>
    <Type>3</Type>
    <Dynamic>false</Dynamic>
    <FrozenPos>true</FrozenPos>
    <HashName>${xml(p.model)}</HashName>
    <InitialHandle>0</InitialHandle>
    <OpacityLevel>255</OpacityLevel>
    <LodDistance>16960</LodDistance>
    <IsVisible>true</IsVisible>
    <MaxHealth>1000</MaxHealth>
    <Health>1000</Health>
    <HasGravity>false</HasGravity>
    <IsOnFire>false</IsOnFire>
    <IsInvincible>false</IsInvincible>
    <IsBulletProof>false</IsBulletProof>
    <IsCollisionProof>false</IsCollisionProof>
    <IsExplosionProof>false</IsExplosionProof>
    <IsFireProof>false</IsFireProof>
    <IsMeleeProof>false</IsMeleeProof>
    <IsOnlyDamagedByPlayer>false</IsOnlyDamagedByPlayer>
    <PositionRotation>
      <X>${p.position[0]}</X>
      <Y>${p.position[1]}</Y>
      <Z>${p.position[2]}</Z>
      <Pitch>${p.rotation[0]}</Pitch>
      <Roll>${p.rotation[1]}</Roll>
      <Yaw>${p.rotation[2]}</Yaw>
    </PositionRotation>
    <Attachment isAttached="false" />
  </Placement>`,
  );
  return `<?xml version="1.0" encoding="ISO-8859-1"?>
<SpoonerPlacements>
  <Note>Generated by ${xml(APP_NAME)}</Note>
  <ClearDatabase>false</ClearDatabase>
  <ReferenceCoords>
    <X>${center[0]}</X>
    <Y>${center[1]}</Y>
    <Z>${center[2]}</Z>
  </ReferenceCoords>
${placements.join("\n")}
</SpoonerPlacements>
`;
}
