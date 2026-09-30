// Events sent from the Electron main process to the UI.
export type UiEvent =
  | { kind: "ready"; model: string }
  | { kind: "thread"; id: string } // the conversation has an id (a new chat gets one with its first reply)
  | { kind: "user"; text: string } // chat history only
  | { kind: "interrupted" } // chat history only
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; isError: boolean; text: string; images: string[] }
  | { kind: "done"; ok: boolean; error?: string }
  | { kind: "fatal"; message: string }
  | { kind: "notify"; level: "info" | "success" | "warning" | "error"; title: string; message?: string } // shown as a toast
  | { kind: "usage"; turn: TokenCounts; session: TokenCounts & { costUsd: number } }
  | { kind: "context"; usedTokens: number; maxTokens: number; percentage: number }
  | { kind: "rate_limit"; status: string; limitType?: string; utilization?: number; resetsAt?: number };

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
