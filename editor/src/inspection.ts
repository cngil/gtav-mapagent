import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { codewalker, LOOK_VIEWS } from "./codewalker.js";
import { layout } from "./layout.js";

export function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

export function errorResult(err: unknown) {
  return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
}

// Read-only tools shared by the builder agent and the independent critic.
export function inspectionTools() {
  return [
    tool(
      "list_props",
      "List the map's folders and props: id, model name, folder, hidden, world position, facing (compass direction the prop's front points to) and worldHeading (degrees counter-clockwise from north), plus heading and distance relative to the user's camera.",
      { radius: z.number().min(1).max(2000).optional().describe("Only props within this many meters of the user's camera; omit for all") },
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
      "look_at_scene",
      "See the scene: renders the real GTA V world from several viewpoints and returns annotated images. Each prop's ground footprint is outlined and labelled #id (green = passed validation, red = has problems, grey = not checked), a yellow arrow shows where its front faces, and a circled arrow points north. Each image has a caption saying where the camera is and which compass direction is right in the image. Takes a few seconds; the user's camera moves while it looks and returns afterwards.",
      {
        ids: z.array(z.number().int()).optional().describe("Props to frame; omit for the group of props nearest the user's camera"),
        views: z
          .array(z.enum(LOOK_VIEWS))
          .min(1)
          .max(6)
          .optional()
          .describe("Viewpoints, default top, south, east. top shows layout and spacing; the sides show facing and height; eye_level shows how a player sees it"),
      },
      async ({ ids, views }) => {
        try {
          const look = await codewalker.look({ ids, views });
          return {
            content: [
              { type: "text" as const, text: `${look.legend} Framed around ${look.center.map((v) => v.toFixed(1)).join(", ")} with radius ${look.radius} m.` },
              ...look.images.flatMap((image) => [
                { type: "text" as const, text: `View "${image.view}": ${image.caption}` },
                { type: "image" as const, data: image.data, mimeType: image.mimeType },
              ]),
            ],
          };
        } catch (err) {
          return errorResult(err);
        }
      },
    ),
  ];
}

export const INSPECTION_TOOL_NAMES = ["list_props", "check_props", "look_at_scene"] as const;
