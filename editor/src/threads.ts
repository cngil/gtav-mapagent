import fs from "node:fs";
import { deleteSession, getSessionInfo, getSessionMessages, listSessions, renameSession, type SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";
import type { UiEvent } from "./events.js";
import type { ProjectThreads } from "./projects.js";
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

  async history(id: string): Promise<UiEvent[]> {
    const messages = await getSessionMessages(id, { dir: this.dir });
    return messages.filter((m) => !m.parent_tool_use_id).flatMap((m) => messageEvents(m.type, m.message, true));
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
