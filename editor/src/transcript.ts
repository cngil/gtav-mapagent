import type { UiEvent } from "./events.js";

// Turns conversation messages into the events the chat UI renders. Shared by the live stream and by chat
// history read back from a saved session, so a reopened chat looks the way it did while it ran.

// Notes the editor adds to a user message for the agent only (e.g. that the map changed). Stripped on replay.
const EDITOR_CONTEXT = /^<editor-context>[\s\S]*?<\/editor-context>\s*/;
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;

export function withEditorContext(note: string, text: string) {
  return `<editor-context>\n${note}\n</editor-context>\n\n${text}`;
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("\n");
  }
  return "";
}

// Images in a tool result (look_at_scene), as data URLs for the chat UI.
function toolResultImages(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const images: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.type === "image" && block.source?.type === "base64") {
      images.push(`data:${block.source.media_type};base64,${block.source.data}`);
    }
  }
  return images;
}

// `message` is the API message ({ role, content }). User text is only wanted for history: while a chat runs,
// the UI shows what was typed on its own.
export function messageEvents(type: string, message: any, includeUserText: boolean): UiEvent[] {
  const events: UiEvent[] = [];
  const content = message?.content;
  if (type === "assistant" && Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text" && block.text.trim()) {
        events.push({ kind: "text", text: block.text });
      } else if (block.type === "tool_use") {
        events.push({ kind: "tool_use", id: block.id, name: block.name.replace(/^mcp__codewalker__/, ""), input: block.input });
      }
    }
  } else if (type === "user") {
    const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
    for (const block of blocks) {
      if (block?.type === "tool_result") {
        events.push({
          kind: "tool_result",
          id: block.tool_use_id,
          isError: !!block.is_error,
          text: toolResultText(block.content),
          images: toolResultImages(block.content),
        });
      } else if (includeUserText && block?.type === "text") {
        const text = String(block.text).replace(EDITOR_CONTEXT, "").trim();
        if (INTERRUPTED.test(text)) events.push({ kind: "interrupted" });
        else if (text) events.push({ kind: "user", text });
      }
    }
  }
  return events;
}
