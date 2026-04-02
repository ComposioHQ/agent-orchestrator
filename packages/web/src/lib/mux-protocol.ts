// ── Client → Server ──

export type ClientMessage =
  | { ch: "terminal"; id: string; type: "data"; data: string }
  | { ch: "terminal"; id: string; type: "resize"; cols: number; rows: number }
  | { ch: "terminal"; id: string; type: "open" }
  | { ch: "terminal"; id: string; type: "close" }
  | { ch: "system"; type: "ping" }
  | { ch: "subscribe"; topics: ("sessions")[] };

// ── Server → Client ──

export type ServerMessage =
  | { ch: "terminal"; id: string; type: "data"; data: string }
  | { ch: "terminal"; id: string; type: "exited"; code: number }
  | { ch: "terminal"; id: string; type: "opened" }
  | { ch: "terminal"; id: string; type: "error"; message: string }
  | { ch: "sessions"; type: "snapshot"; sessions: SessionPatch[] }
  | { ch: "system"; type: "pong" }
  | { ch: "system"; type: "error"; message: string };

export interface SessionPatch {
  id: string;
  status: string;
  activity: string | null;
  attentionLevel: string;
  lastActivityAt: string;
}
