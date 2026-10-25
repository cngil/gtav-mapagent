import fs from "node:fs";
import { deleteSession, getSessionInfo, getSessionMessages, listSessions, renameSession, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { UiEvent } from "./events.js";
import type { ProjectThreads, StoredTurn } from "./projects.js";
import { messageEvents } from "./transcript.js";

// Chats. Each chat is an Agent SDK session, which the SDK saves on its own (under ~/.claude/projects, keyed
// by the agent's working directory) along with an automatic title. All projects share that working
// directory; which chats belong to which project is recorded per project (see ProjectThreads).

export interface ThreadSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  settled: boolean;
}

// The start of a message, as stored with the stats of its answer.
export const promptKey = (text: string) => text.trim().slice(0, 80);

// Puts each answer's stats after it. Saved stats are matched to messages in order by how the message starts:
// answers from before stats were kept have none, and are skipped over.
function withTurnStats(events: UiEvent[], turns: StoredTurn[]): UiEvent[] {
  if (!turns.length) return events;
  const out: UiEvent[] = [];
  let next = 0; // the first saved turn not matched yet
  let pending: StoredTurn | null = null; // stats of the answer being replayed
  const flush = () => {
    if (pending) {
      const { prompt: _prompt, ...stats } = pending;
      out.push({ kind: "turn_stats", ...stats });
    }
    pending = null;
  };
  for (const event of events) {
    if (event.kind === "user") {
      flush();
      const key = promptKey(event.text);
      const match = turns.findIndex((t, i) => i >= next && t.prompt === key);
      if (match >= 0) {
        pending = turns[match];
        next = match + 1;
      }
    }
    out.push(event);
  }
  flush();
  return out;
}

export class ThreadStore {
  // dir: the agent's working directory, which is where the SDK files its sessions.
  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  sessions(): Promise<SDKSessionInfo[]> {
    return listSessions({ dir: this.dir, includeWorktrees: false });
  }

  // A project's chats: pinned first, then most recently active; settled ones last.
  summaries(threads: ProjectThreads, sessions: SDKSessionInfo[]): ThreadSummary[] {
    return sessions
      .filter((s) => threads.has(s.sessionId))
      .map((s) => {
        const meta = threads.meta(s.sessionId);
        return {
          id: s.sessionId,
          title: s.customTitle || s.summary || s.firstPrompt || "Untitled chat",
          createdAt: s.createdAt ?? s.lastModified,
          updatedAt: s.lastModified,
          pinned: !!meta.pinned,
          settled: !!meta.settled,
        };
      })
      .sort((a, b) => Number(a.settled) - Number(b.settled) || Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }

  async exists(id: string) {
    return !!(await getSessionInfo(id, { dir: this.dir }).catch(() => undefined));
  }

  // turns: the stats saved for the chat's answers, shown after each answer as they were when it ran.
  async history(id: string, turns: StoredTurn[] = []): Promise<UiEvent[]> {
    const messages = await getSessionMessages(id, { dir: this.dir });
    const events = messages.filter((m) => !m.parent_tool_use_id).flatMap((m) => messageEvents(m.type, m.message, true));
    return withTurnStats(events, turns);
  }

  async rename(id: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) throw new Error("Title is empty");
    await renameSession(id, trimmed, { dir: this.dir });
  }

  async remove(id: string) {
    // Right after its conversation was closed, the agent process may still hold the file for a moment (Windows).
    for (let attempt = 1; ; attempt++) {
      try {
        await deleteSession(id, { dir: this.dir });
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (attempt >= 10 || (code !== "EBUSY" && code !== "EPERM")) throw err;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
}
