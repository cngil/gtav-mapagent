// Events sent from the Electron main process to the UI.
export type UiEvent =
  | { kind: "ready"; model: string }
  | { kind: "thread"; id: string } // the conversation has an id (a new chat gets one with its first reply)
  | { kind: "user"; text: string; attachments?: Attachment[] } // chat history only
  | { kind: "interrupted" } // chat history only
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; isError: boolean; text: string; images: string[] }
  | { kind: "done"; ok: boolean; error?: string }
  | ({ kind: "turn_stats" } & TurnStats) // after "done", and in chat history
  | { kind: "fatal"; message: string }
  | { kind: "notify"; level: "info" | "success" | "warning" | "error"; title: string; message?: string } // shown as a toast
  | { kind: "usage"; turn: TokenCounts; session: TokenCounts & { costUsd: number } }
  | { kind: "context"; usedTokens: number; maxTokens: number; percentage: number }
  | { kind: "rate_limit"; status: string; limitType?: string; utilization?: number; resetsAt?: number };

// What the user pointed at in the 3D view when sending a message: shown as chips on their message.
export interface Attachment {
  type: "selection" | "marker";
  label: string;
}

// One answer of the agent: how long it took, how many tool steps it made and what it cost.
export interface TurnStats {
  durationMs: number;
  tools: number;
  costUsd: number; // the conversation's part, an estimate at API list prices
  reviewCostUsd: number; // the critic's reviews, which run as conversations of their own
  stopped: boolean; // the user pressed Stop
}

// input excludes cached tokens, which are counted separately.
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export type ViewerStatus =
  | { state: "starting" }
  | { state: "loading" }
  | { state: "ready"; propCount: number }
  | { state: "error"; message: string };
