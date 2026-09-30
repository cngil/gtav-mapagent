import path from "node:path";
import {
  createSdkMcpServer,
  query,
  tool,
  type EffortLevel,
  type ModelInfo,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { codewalker, getHistoryGroup } from "./codewalker.js";
import { runReview } from "./critic.js";
import { APP_ID } from "./app-info.js";
import { EXPORT_TARGET_INFO, EXPORT_TARGETS, MAP_NAME_PATTERN, type ExportResult, type ExportTarget } from "./export.js";
import { errorResult, INSPECTION_TOOL_NAMES, inspectionTools, text } from "./inspection.js";
import { layout } from "./layout.js";
import { getSettings } from "./settings.js";

// The request currently being worked on, as the user wrote it. The critic gets this verbatim rather than
// the builder's paraphrase.
const review = { task: "", rounds: 0 };

export function beginUserRequest(userText: string) {
  review.task = userText;
  review.rounds = 0;
}

const SERVER_NAME = "codewalker";
const TOOL_NAMES = [
  "search_props",
  "place_prop",
  "move_prop",
  "delete_prop",
  ...INSPECTION_TOOL_NAMES,
  "request_review",
  "undo_last_change",
  "redo_last_undo",
  "set_folder",
  "set_visibility",
  "get_camera_view",
  "export_map",
];

const SYSTEM_PROMPT = `You are an assistant that builds GTA V map scenes, usually for multiplayer servers (FiveM, alt:V, RAGE:MP) or singleplayer mods. The user sees a 3D view of the real GTA V world (rendered by CodeWalker) next to this chat, and you edit that world through the codewalker tools. The map belongs to a project and is saved automatically as a .ymap file; it can also be exported for several platforms.

How space works:
- The user flies the camera to where they want to build. place_prop positions are relative to that camera, projected onto the ground: forward (meters ahead), right (meters to the right; negative = left), up (meters above the ground). Ground height and resting the prop's base on it are automatic.
- place_prop heading is in degrees relative to the camera: 0 = the prop's front faces the way the camera looks, 180 = it faces the camera, 90 = toward the camera's left. A prop's front is where you would sit on a bench or the opening of a tent.
- Prefer face_id over headings whenever a prop should face another one (benches toward a fire, chairs toward a table): it turns the prop's front toward that prop exactly.
- When fixing a scene you have looked at, use world directions: move_prop north/east (meters, negative = south/west) and world_heading (degrees counter-clockwise from north: 0 north, 90 west, 180 south, 270 east). list_props reports every prop's facing and worldHeading in the same terms. The camera-relative forward/right still work but mean the user's current camera, not the image you looked at.
- The user may move the camera between requests; call list_props for fresh values before editing existing props.

Tools and conventions:
- Never invent model names. Use search_props and only place names it returned. Search with short English keywords (bench, tent, table, chair, barrier, crate, light, fire, tree, fence). Most placeable props start with "prop_". Model names say little about size: read the bounding boxes (prop_logpile_01 is 8.4 m long).
- Footprint width is bbMax[0]-bbMin[0] along the prop's own left-right axis and bbMax[1]-bbMin[1] front-to-back; turning by 90 degrees swaps them. Leave at least 0.3 m between props unless they are meant to touch.
- Every prop has an id. To change a scene, prefer move_prop and delete_prop over placing duplicates.
- Put the props of a named scene in one folder (place_prop folder), named briefly in the user's language. Hidden props still exist and are saved.
- Every place_prop and move_prop result has a "validation" report from real geometry; ok: false is a defect. overlap = intersects another prop ("with" id) by depth meters; world_collision = inside a building, wall, fence or other world object on the given side; floating / buried / overhang = base not resting on the ground; steep_ground = sloped ground; no_ground = nothing solid below. suggestedMove values are camera-relative.
- Only call export_map when the user asks. If they want an export without naming the platform, ask which one.
- A user message may start with an <editor-context> note from the editor (not typed by the user), e.g. that the map changed; take it into account.

How to complete a building request — keep going until it is actually done, don't stop at a first draft:
1. Write a short acceptance checklist of concrete, checkable points the result must satisfy (what props, how many, arrangement, which way they face, spacing, nothing clipping or floating). Show it to the user in one or two lines before building.
2. Build it.
3. Run check_props on the props of the scene and fix every problem.
4. Call look_at_scene on those props and compare what you see against the checklist: facing arrows, spacing, whether it looks like the real thing. Fix what's wrong and look again when a fix was significant.
5. Call request_review with the checklist and the prop ids. An independent reviewer inspects the scene without seeing your reasoning. If it fails, apply its fixes (or better ones) and request another review. Reviews per request are limited; each result says how many remain. If request_review says reviews are turned off, do a final look_at_scene check of your own instead.
6. Finish with a brief report in the user's language: what you built, the reviewer's verdict (if reviews are on), and anything still not right.
Questions or small edits ("move #4 a bit left", "what's here?") don't need the checklist or a review.

- If the user wants to take back an earlier request, use undo_last_change (reverts the whole previous request); redo_last_undo brings it back.
- Reply in the user's language, briefly.`;

// What the tools need from the editor around them.
export interface AgentHost {
  workDir: string;
  // Saves the project and exports it; name defaults to the project's.
  exportMap(name: string | undefined, target: ExportTarget): Promise<ExportResult>;
}

function createTools(host: AgentHost) {
  const workDir = host.workDir;
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
          face_id: z.number().int().optional().describe("Turn the prop's front toward this prop instead of using heading"),
          folder: z.string().optional().describe("Folder to put the prop in; created if missing"),
        },
        async ({ model, forward, right, up, heading, face_id, folder }) => {
          try {
            const placed = await codewalker.placeProp({ model, forward, right, up: up ?? 0, heading: heading ?? 0, face_id });
            if (folder) await layout.assign([placed.id], folder);
            return text({ ...placed, folder: layout.folderOf(placed.id) });
          } catch (err) {
            return errorResult(err);
          }
        },
      ),
      tool(
        "move_prop",
        "Move and/or turn a placed prop. Offsets can be world directions (north/east) or relative to the user's camera (forward/right); they add up. Without up it is re-snapped to the ground at the new spot.",
        {
          id: z.number().int().describe("Prop id from place_prop or list_props"),
          north: z.number().optional().describe("Meters north (negative = south)"),
          east: z.number().optional().describe("Meters east (negative = west)"),
          forward: z.number().optional().describe("Meters away from the user's camera (negative = toward it)"),
          right: z.number().optional().describe("Meters to the user's camera's right (negative = left)"),
          up: z.number().optional().describe("Meters to raise (negative = lower); disables ground snapping"),
          face_id: z.number().int().optional().describe("Turn the prop's front toward this prop"),
          world_heading: z.number().optional().describe("Absolute direction for the prop's front, degrees counter-clockwise from north (0 N, 90 W, 180 S, 270 E)"),
          turn: z.number().optional().describe("Degrees to rotate on top of the above; positive = counter-clockwise seen from above"),
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
      ...inspectionTools(),
      tool(
        "request_review",
        `Have an independent reviewer inspect the finished scene against your acceptance checklist and the user's original request. Returns pass/fail, the checklist judged item by item, and issues with prop ids and fixes. The number of reviews per request is limited.`,
        {
          checklist: z.array(z.string()).min(1).describe("Concrete, checkable acceptance points"),
          ids: z.array(z.number().int()).min(1).describe("Ids of the props that make up the scene"),
        },
        async ({ checklist, ids }) => {
          const { model, effort, critic } = getSettings();
          if (!critic.enabled) {
            return text("Independent reviews are turned off in the editor settings. Check the scene yourself with check_props and look_at_scene, then report.");
          }
          if (review.rounds >= critic.maxRounds) {
            return errorResult(`All ${critic.maxRounds} reviews for this request are used. Stop and tell the user what is still wrong.`);
          }
          review.rounds++;
          try {
            const { verdict } = await runReview({
              task: review.task,
              checklist,
              ids,
              model: critic.model ?? process.env.MAP_EDITOR_MODEL ?? model,
              // A critic on the builder's model follows the builder's effort unless it has its own.
              effort: critic.effort ?? (critic.model ? undefined : effort),
              maxTurns: critic.maxTurns,
              workDir,
            });
            return text({ round: review.rounds, maxRounds: critic.maxRounds, remaining: critic.maxRounds - review.rounds, ...verdict });
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
            if (ids?.length) await layout.setPropsHidden(ids, !visible);
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
        "export_map",
        `Export the map for a platform. Targets: ${EXPORT_TARGETS.map((t) => `${t} = ${EXPORT_TARGET_INFO[t].description}`).join("; ")}. Returns where it was written and how to install it.`,
        {
          name: z.string().regex(MAP_NAME_PATTERN).optional().describe("Resource, package or file name: lowercase letters, digits, _ or -. Defaults to the project's name"),
          target: z.enum(EXPORT_TARGETS).describe("Platform to export for"),
        },
        async ({ name, target }) => {
          try {
            return text(await host.exportMap(name, target));
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

  constructor(
    private readonly onMessage: (message: SDKMessage) => void,
    // resume: id of a saved conversation to continue.
    private readonly options: { host: AgentHost; model?: string; effort?: EffortLevel; resume?: string },
  ) {}

  start(): Promise<void> {
    const q = query({
      prompt: this.inputStream(),
      options: {
        model: this.options.model,
        effort: this.options.effort,
        resume: this.options.resume,
        systemPrompt: SYSTEM_PROMPT,
        cwd: this.options.host.workDir,
        tools: [],
        mcpServers: { [SERVER_NAME]: createTools(this.options.host) },
        allowedTools: TOOL_NAMES.map((name) => `mcp__${SERVER_NAME}__${name}`),
        permissionMode: "dontAsk",
        settingSources: [],
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `${APP_ID}/0.1.0` },
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
    await this.q?.setModel(model);
  }

  // Reasoning effort for the next response. undefined = the model's default.
  async setEffort(effort: EffortLevel | undefined) {
    await this.q?.applyFlagSettings({ effortLevel: effort ?? null });
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
