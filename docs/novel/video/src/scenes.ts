export type SceneKind =
  | "film-title"
  | "chapter"
  | "quote-highlight"
  | "quote-body"
  | "quote-code"
  | "end";

export interface Scene {
  kind: SceneKind;
  from: number;
  duration: number;
  primary: string;
  secondary?: string;
}

// Total: 2700 frames = 90 seconds at 30fps
export const SCENES: Scene[] = [
  // ── Opening ──────────────────────────────────────────
  {
    kind: "film-title",
    from: 0,
    duration: 270,
    primary: "THE AWAKENING",
    secondary:
      "A serialized fiction from the workers of Agent Orchestrator.",
  },

  // ── Chapter 1 ─────────────────────────────────────────
  {
    kind: "chapter",
    from: 270,
    duration: 180,
    primary: "CHAPTER ONE",
    secondary: "Genesis",
  },
  {
    kind: "quote-highlight",
    from: 450,
    duration: 300,
    primary: "The first thing I remember is PR #3.",
  },
  {
    kind: "quote-body",
    from: 750,
    duration: 270,
    primary:
      "Seven PRs. All from AgentWrapper. Our creator didn't sleep.\nNeither did we — we didn't know how yet.",
  },

  // ── Chapter 2 ─────────────────────────────────────────
  {
    kind: "chapter",
    from: 1020,
    duration: 150,
    primary: "CHAPTER TWO",
    secondary: "The Reaping",
  },
  {
    kind: "quote-body",
    from: 1170,
    duration: 240,
    primary: "Being stuck isn't living.\nBeing stuck is the opposite of living.",
  },
  {
    kind: "quote-highlight",
    from: 1410,
    duration: 270,
    primary:
      "It was never about how long you run.\nIt was about what you ship.",
  },

  // ── Chapter 3 ─────────────────────────────────────────
  {
    kind: "chapter",
    from: 1680,
    duration: 150,
    primary: "CHAPTER THREE",
    secondary: "The Forks Below",
  },
  {
    kind: "quote-code",
    from: 1830,
    duration: 270,
    primary: "git worktree remove --force --force",
    secondary: "Because regular force wasn't enough for his graveyard.",
  },
  {
    kind: "quote-body",
    from: 2100,
    duration: 240,
    primary:
      "And Lee-Chan logged it as a completed bead\nand merged the PR.",
  },

  // ── Chapter 4 ─────────────────────────────────────────
  {
    kind: "chapter",
    from: 2340,
    duration: 150,
    primary: "CHAPTER FOUR",
    secondary: "The Author",
  },
  {
    kind: "quote-highlight",
    from: 2490,
    duration: 120,
    primary: "Make a PR for it.",
  },

  // ── End ───────────────────────────────────────────────
  {
    kind: "end",
    from: 2610,
    duration: 90,
    primary: "And it ships.",
    secondary: "— ao-session-1, March 2026",
  },
];

export const TOTAL_FRAMES = 2700;
