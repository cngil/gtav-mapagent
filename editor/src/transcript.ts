import type { ViewContext } from "./codewalker.js";
import type { Attachment, UiEvent } from "./events.js";

// Turns conversation messages into the events the chat UI renders. Shared by the live stream and by chat
// history read back from a saved session, so a reopened chat looks the way it did while it ran.

// Notes the editor adds to a user message for the agent only (e.g. that the map changed). Stripped on replay.
const EDITOR_CONTEXT = /^<editor-context>[\s\S]*?<\/editor-context>\s*/;
const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;

export function withEditorContext(note: string, text: string) {
  return `<editor-context>\n${note}\n</editor-context>\n\n${text}`;
}

// The note's lines about what the user pointed at in the 3D view. Replay turns them back into chips, so how
// they begin must stay as it is.
const SELECTION_LINE = "Selected in the 3D view: ";
const MARKER_LINE = "Marked spot: ";

const meters = (n: number) => `${Math.abs(n).toFixed(1)} m`;

export function pointing(context: ViewContext | null): { lines: string[]; attachments: Attachment[] } {
  const lines: string[] = [];
  const attachments: Attachment[] = [];
  if (context?.selection.length) {
    const props = context.selection.map((p) => `#${p.id} ${p.name} (${meters(p.distance)} from the camera, facing ${p.facing})`);
    lines.push(`${SELECTION_LINE}${props.join(", ")}. Words like "this", "these" or "it" in the message refer to them.`);
    attachments.push(selectionAttachment(context.selection.map((p) => `#${p.id} ${p.name}`)));
  }
  if (context?.marker) {
    const m = context.marker;
    const where = `${meters(m.forward)} ${m.forward >= 0 ? "ahead of" : "behind"} and ${meters(m.right)} ${m.right >= 0 ? "right of" : "left of"} the camera`;
    lines.push(`${MARKER_LINE}world (${m.position.map((v) => v.toFixed(1)).join(", ")}), ${where}. "Here" or "there" means this spot; place_prop with at_marker builds there.`);
    attachments.push({ type: "marker", label: "Marked spot" });
  }
  return { lines, attachments };
}

function selectionAttachment(props: string[]): Attachment {
  return { type: "selection", label: props.length === 1 ? props[0] : `${props.length} props` };
}

// The chips of a message, from its editor-context note.
function attachmentsOf(note: string): Attachment[] {
  const attachments: Attachment[] = [];
  for (const line of note.split("\n")) {
    if (line.startsWith(SELECTION_LINE)) {
      const props = [...line.matchAll(/#(\d+) ([\w-]+) \(/g)].map((m) => `#${m[1]} ${m[2]}`);
      if (props.length) attachments.push(selectionAttachment(props));
    } else if (line.startsWith(MARKER_LINE)) {
      attachments.push({ type: "marker", label: "Marked spot" });
    }
  }
  return attachments;
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
        const raw = String(block.text);
        const text = raw.replace(EDITOR_CONTEXT, "").trim();
        const attachments = attachmentsOf(raw.match(EDITOR_CONTEXT)?.[0] ?? "");
        if (INTERRUPTED.test(text)) events.push({ kind: "interrupted" });
        else if (text) events.push(attachments.length ? { kind: "user", text, attachments } : { kind: "user", text });
      }
    }
  }
  return events;
}
