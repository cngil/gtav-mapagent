import { createSdkMcpServer, query } from "@anthropic-ai/claude-agent-sdk";
import { INSPECTION_TOOL_NAMES, inspectionTools } from "./inspection.js";

// An independent reviewer for a finished scene. It runs as a separate agent session that sees only
// the user's original request, the builder's acceptance checklist and the scene itself (through
// read-only tools) — not the builder's reasoning — so it can't be talked into a pass.

export interface ReviewIssue {
  ids: number[];
  problem: string;
  fix: string;
}

export interface ReviewVerdict {
  pass: boolean;
  summary: string;
  checklist: { item: string; met: boolean; note: string }[];
  issues: ReviewIssue[];
}

const SERVER_NAME = "inspector";

const CRITIC_PROMPT = `You are a strict, independent reviewer of GTA V map scenes built for a FiveM roleplay server. Another agent built the scene; you did not see how. Judge only what is actually in the world.

You get the user's original request and an acceptance checklist. Inspect before judging:
1. check_props on the props in question: any unfixed validation problem (overlap, world collision, floating, buried, no ground) is a failure unless it is clearly intentional.
2. look_at_scene with at least the top view and two opposite sides; add eye_level when appearance matters. Use list_props for ids, facing and positions.

Judge each checklist item as met or not, and also fail anything a player would notice as wrong even if the checklist forgot it: props facing the wrong way (check the yellow front arrows), props clipping into each other or into buildings, floating or sunken props, blocked paths, an arrangement that doesn't look like the real thing requested, or props that don't match what was asked (wrong type or state, e.g. a folded chair where people should sit).

Be concrete. Every issue names the prop ids and a fix the builder can apply with its tools: moves in meters north/east, face_id to turn a prop toward another prop, world_heading in degrees counter-clockwise from north, delete, or a different model. Pass only when every checklist item is met and nothing noticeable is wrong. Don't fail for matters of taste the request left open.`;

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pass", "summary", "checklist", "issues"],
  properties: {
    pass: { type: "boolean" },
    summary: { type: "string", description: "One or two sentences on the overall state" },
    checklist: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "met", "note"],
        properties: { item: { type: "string" }, met: { type: "boolean" }, note: { type: "string" } },
      },
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["ids", "problem", "fix"],
        properties: {
          ids: { type: "array", items: { type: "integer" } },
          problem: { type: "string" },
          fix: { type: "string" },
        },
      },
    },
  },
};

export async function runReview(options: {
  task: string;
  checklist: string[];
  ids?: number[];
  model?: string;
  workDir: string;
}): Promise<{ verdict: ReviewVerdict; costUsd: number }> {
  const scope = options.ids?.length ? `The scene consists of props ${options.ids.map((id) => `#${id}`).join(", ")}.` : "Review the props nearest the user's camera.";
  const prompt = [
    "User's request:",
    options.task,
    "",
    "Acceptance checklist:",
    ...options.checklist.map((item, i) => `${i + 1}. ${item}`),
    "",
    scope,
  ].join("\n");

  const q = query({
    prompt,
    options: {
      model: options.model,
      systemPrompt: CRITIC_PROMPT,
      cwd: options.workDir,
      tools: [],
      mcpServers: { [SERVER_NAME]: createSdkMcpServer({ name: SERVER_NAME, version: "0.1.0", tools: inspectionTools() }) },
      allowedTools: INSPECTION_TOOL_NAMES.map((name) => `mcp__${SERVER_NAME}__${name}`),
      permissionMode: "dontAsk",
      settingSources: [],
      persistSession: false,
      maxTurns: 16,
      outputFormat: { type: "json_schema", schema: VERDICT_SCHEMA },
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "gta-map-editor-critic/0.1.0" },
    },
  });

  for await (const message of q) {
    if (message.type !== "result") continue;
    if (message.subtype === "success" && !message.is_error && message.structured_output) {
      return { verdict: message.structured_output as ReviewVerdict, costUsd: message.total_cost_usd };
    }
    const reason = message.subtype === "success" ? message.result : message.errors.join("; ") || message.subtype;
    throw new Error(`The reviewer didn't return a verdict: ${reason}`);
  }
  throw new Error("The reviewer ended without a result");
}
