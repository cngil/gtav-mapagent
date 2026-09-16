// Events sent from the Electron main process to the UI.
export type UiEvent =
  | { kind: "ready"; model: string }
  | { kind: "text"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; id: string; isError: boolean; text: string }
  | { kind: "done"; ok: boolean; error?: string }
  | { kind: "fatal"; message: string }
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
