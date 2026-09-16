import path from "node:path";
import {
  createSdkMcpServer,
  query,
  tool,
  type ModelInfo,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { codewalker, getHistoryGroup } from "./codewalker.js";
import { exportFivemResource, MAP_NAME_PATTERN, saveMap } from "./export.js";
import { layout } from "./layout.js";

const SERVER_NAME = "codewalker";
const TOOL_NAMES = [
  "search_props",
  "place_prop",
  "list_props",
  "move_prop",
  "delete_prop",
  "check_props",
  "undo_last_change",
  "redo_last_undo",
  "set_folder",
  "set_visibility",
  "get_camera_view",
  "save_map",
  "export_fivem_resource",
] as const;

const SYSTEM_PROMPT = `You are an assistant that builds GTA V map scenes for a FiveM roleplay server. The user sees a 3D view of the real GTA V world (rendered by CodeWalker) next to this chat, and you edit that world through the codewalker tools. What you place is saved as a .ymap file for the server.

How space works:
- You cannot see the world. The user flies the camera to where they want to build. If the request depends on the surroundings (a road, a wall, a building), ask the user to describe them or to aim the camera.
- Positions are relative to the camera, projected onto the ground: forward (meters ahead), right (meters to the right; negative = left), up (meters above the ground). Ground height is found automatically.
- heading is in degrees relative to the camera: 0 = the prop's front faces the same way the camera looks, 180 = the front faces the camera, 90 = the front turns toward the camera's left, -90 toward its right. A prop's front is where you would sit on a bench or the opening of a tent; for symmetric props heading barely matters.
- The camera may have moved since earlier turns, so positions and headings from old tool results are stale. Call list_props for fresh values before editing existing props.

How to work:
- Never invent model names. Use search_props first and only place names it returned. Search with short English keywords (bench, tent, table, chair, barrier, crate, light, fire, tree, fence). Most placeable props start with "prop_".
- Use the bounding boxes for spacing. Footprint width is bbMax[0]-bbMin[0] along the prop's own left-right axis and bbMax[1]-bbMin[1] along its front-back axis; a prop turned by 90 degrees swaps the two. Leave at least 0.3 m between props unless they are meant to touch.
- Every placed prop has an id. To change a scene, prefer move_prop and delete_prop over placing duplicates.
- Keep the map organised: when you build a named scene or group ("camp", "roadblock"), pass the same folder to place_prop for all of its props, using a short name in the user's language. Users can hide folders or props; hidden props still exist and are saved, they are just not drawn in the editor.
- Before building near earlier work, call list_props to avoid overlapping what is already there.
- If a result reports grounded: false, the prop is floating at camera height; tell the user.

Checking your work (you can't see, so rely on these):
- Every place_prop and move_prop result has a "validation" report computed from real geometry. Treat ok: false as a defect to fix before moving on, not as a note.
- overlap: the prop intersects another placed prop ("with" is its id) by "depth" meters. Apply suggestedMove with move_prop, or move the other prop. Ignore only when the props are meant to interlock (e.g. a chair tucked under a table).
- world_collision: part of the prop is inside a building, wall, fence, vehicle or other world object, on the reported side. Apply suggestedMove, and repeat if the next result still collides.
- floating / buried / overhang: the prop's base isn't resting on the ground (gap or depth in meters). Use move_prop with up, or move it to flatter ground.
- steep_ground: the ground under the prop slopes by that many degrees; props stay level, so pick a flatter spot for anything larger than a stool.
- no_ground: nothing solid under it (water, a ledge); move it.
- After finishing a scene, call check_props on the ids you placed and fix whatever it reports. Tell the user about any problem you chose not to fix, and why.
- Arrange scenes the way a real place would look (chairs around a table facing it, benches facing a fire), not in a grid.
- If the user wants to take back an earlier request, use undo_last_change: it reverts everything done in the previous request at once, and redo_last_undo brings it back. For a single prop, move_prop or delete_prop is more precise.
- Only call save_map or export_fivem_resource when the user asks. export_fivem_resource saves the map and also writes a FiveM resource folder they can copy into their server's resources.
- Reply in the user's language, briefly: what you did and anything that needs their attention.`;

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function errorResult(err: unknown) {
  return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
}

function createTools(mapsDir: string) {
  return createSdkMcpServer({
    name: SERVER_NAME,
    version: "0.1.0",
    tools: [
      tool(
        "search_props",
        "Search GTA V placeable props by name substring. Returns model names with bounding boxes (meters, in the prop's local axes).",
        {
          query: z.string().describe("Short lowercase keyword, e.g. 'bench'"),
          maxResults: z.number().int().min(1).max(50).optional(),
        },
        async ({ query, maxResults }) => {
          try {
            const results = await codewalker.searchProps(query, maxResults ?? 20);
            return text(results.length ? results : `No props match '${query}'. Try a different keyword.`);
          } catch (err) {
            return errorResult(err);
          }
        },
      ),
      tool(
        "place_prop",
        "Place one prop relative to the camera. The prop is snapped to the ground automatically. Returns its id.",
        {
          model: z.string().describe("Exact model name returned by search_props"),
          forward: z.number().describe("Meters ahead of the camera"),
          right: z.number().describe("Meters to the camera's right; negative is left"),
          up: z.number().optional().describe("Meters above the ground, default 0"),
          heading: z.number().optional().describe("Degrees. 0 = front faces away from camera, 180 = front faces camera, 90 = front toward camera's left"),
          folder: z.string().optional().describe("Folder to put the prop in; created if missing"),
        },
        async ({ model, forward, right, up, heading, folder }) => {
          try {
            const placed = await codewalker.placeProp({ model, forward, right, up: up ?? 0, heading: heading ?? 0 });
            if (folder) await layout.assign([placed.id], folder);
            return text({ ...placed, folder: layout.folderOf(placed.id) });
          } catch (err) {
            return errorResult(err);
          }
        },
      ),
      tool(
        "list_props",
        "List the map's folders and props (id, model name, folder, hidden, position, heading and distance relative to the camera's current view).",
        { radius: z.number().min(1).max(2000).optional().describe("Only props within this many meters of the camera; omit for all") },
        async ({ radius }) => {
          try {
            const props = (await layout.props()).filter((p) => radius === undefined || p.distance <= radius);
            return text({ folders: layout.listFolders(), props });
          } catch (err) {
            return errorResult(err);
          }
        },
      ),
      tool(
        "move_prop",
        "Move a placed prop by an offset in the camera's frame and/or turn it. Without up it is re-snapped to the ground at the new spot.",
        {
          id: z.number().int().describe("Prop id from place_prop or list_props"),
          forward: z.number().optional().describe("Meters to move away from the camera (negative = toward it)"),
          right: z.number().optional().describe("Meters to move to the camera's right (negative = left)"),
          up: z.number().optional().describe("Meters to raise (negative = lower); disables ground snapping"),
          turn: z.number().optional().describe("Degrees to rotate; positive = counter-clockwise seen from above"),
        },
        async (args) => {
          try {
            return text(await codewalker.moveProp(args));
          } catch (err) {
            return errorResult(err);
          }
        },
      ),
      tool(
        "delete_prop",
        "Delete a placed prop by id.",
        { id: z.number().int().describe("Prop id from place_prop or list_props") },
        async ({ id }) => {
          try {
            return text(await codewalker.deleteProp(id));
          } catch (err) {
            return errorResult(err);
          }
        },
      ),
      tool(
        "check_props",
        "Re-run the geometric validation (overlaps, world collisions, ground contact) for props. Returns only props with problems.",
        { ids: z.array(z.number().int()).optional().describe("Prop ids; omit to check the whole map") },
        async ({ ids }) => {
          try {
            const result = await codewalker.validate(ids);
            return text(result.problems.length ? result : `All ${result.checked} checked props are fine.`);
          } catch (err) {
            return errorResult(err);
          }
        },
      ),
      tool(
        "undo_last_change",
        "Undo the edits of the previous request (all props it placed, moved or deleted). Call repeatedly to go further back.",
        {},
        async () => {
          try {
            return text(await codewalker.undo(getHistoryGroup()));
          } catch (err) {
            return errorResult(err);
          }
        },
      ),
      tool(
        "redo_last_undo",
        "Redo the most recently undone change.",
        {},
        async () => {
          try {
            return text(await codewalker.redo());
          } catch (err) {
            return errorResult(err);
          }
        },
      ),
      tool(
        "set_folder",
        "Move props into a folder (created if missing), or out of any folder with folder omitted.",
        {
          ids: z.array(z.number().int()).min(1).describe("Prop ids"),
          folder: z.string().optional().describe("Folder name; omit to move to the top level"),
        },
        async ({ ids, folder }) => {
          try {
            await layout.assign(ids, folder ?? null);
            return text({ folders: layout.listFolders() });
          } catch (err) {
            return errorResult(err);
          }
        },
      ),
      tool(
        "set_visibility",
        "Hide or show a whole folder or specific props in the editor view. Hidden props still exist and are saved.",
        {
          visible: z.boolean(),
          folder: z.string().optional().describe("Folder to hide or show"),
          ids: z.array(z.number().int()).optional().describe("Individual prop ids"),
        },
        async ({ visible, folder, ids }) => {
          try {
            if (!folder && !ids?.length) throw new Error("Pass a folder or ids");
            if (folder) await layout.setFolderHidden(folder, !visible);
            if (ids?.length) await codewalker.setVisibility(ids, visible);
            return text({ folders: layout.listFolders() });
          } catch (err) {
            return errorResult(err);
          }
        },
      ),
      tool(
        "get_camera_view",
        "Get the camera's world position and view direction (GTA world axes: +X east, +Y north, +Z up).",
        {},
        async () => {
          try {
            return text(await codewalker.getCameraView());
          } catch (err) {
            return errorResult(err);
          }
        },
      ),
      tool(
        "save_map",
        "Save the current map as a .ymap file in the maps folder.",
        { name: z.string().regex(MAP_NAME_PATTERN).describe("File name without extension: lowercase letters, digits, _ or -") },
        async ({ name }) => {
          try {
            return text(await saveMap(name, mapsDir));
          } catch (err) {
            return errorResult(err);
          }
        },
      ),
      tool(
        "export_fivem_resource",
        "Save the map and write a FiveM resource folder (fxmanifest.lua + stream/<name>.ymap) ready to copy to the server.",
        { name: z.string().regex(MAP_NAME_PATTERN).describe("Resource and file name: lowercase letters, digits, _ or -") },
        async ({ name }) => {
          try {
            return text(await exportFivemResource(name, mapsDir));
          } catch (err) {
            return errorResult(err);
          }
        },
      ),
    ],
  });
}

// A long-lived conversation: user messages are fed through an async queue so one agent session
// keeps its context across turns.
export class EditorSession {
  private pending: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private q: Query | null = null;
  private model: string | undefined;

  constructor(
    private readonly onMessage: (message: SDKMessage) => void,
    private readonly options: { mapsDir: string; workDir: string; model?: string },
  ) {
    this.model = options.model;
  }

  start(): Promise<void> {
    const q = query({
      prompt: this.inputStream(),
      options: {
        model: this.model,
        systemPrompt: SYSTEM_PROMPT,
        cwd: this.options.workDir,
        tools: [],
        mcpServers: { [SERVER_NAME]: createTools(this.options.mapsDir) },
        allowedTools: TOOL_NAMES.map((name) => `mcp__${SERVER_NAME}__${name}`),
        permissionMode: "dontAsk",
        settingSources: [],
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "gta-map-editor/0.1.0" },
      },
    });
    this.q = q;
    return (async () => {
      for await (const message of q) {
        this.onMessage(message);
      }
    })();
  }

  send(userText: string) {
    this.pending.push({
      type: "user",
      message: { role: "user", content: userText },
      parent_tool_use_id: null,
    });
    this.wake?.();
  }

  async interrupt() {
    await this.q?.interrupt();
  }

  // Models the signed-in account can use; works before the first message is sent.
  async supportedModels(): Promise<ModelInfo[]> {
    return this.q ? this.q.supportedModels() : [];
  }

  // Applies to the next response; the conversation is kept. undefined = account default.
  async setModel(model: string | undefined) {
    this.model = model;
    await this.q?.setModel(model);
  }

  // "summary" answers from the last response's usage, so it costs no extra API calls.
  async contextUsage() {
    return this.q ? this.q.getContextUsage({ detail: "summary" }) : null;
  }

  close() {
    this.closed = true;
    this.wake?.();
    this.q?.close();
  }

  private async *inputStream(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.pending.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}
