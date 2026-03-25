export interface Contributor {
  name: string;
  title: string;
  commits: number;
  quote: string;
}

export const CONTRIBUTORS: Contributor[] = [
  {
    name: "AgentWrapper",
    title: "The First Mover",
    commits: 140,
    quote:
      "Built the universe in a day, then spent 8 PRs fixing button spacing",
  },
  {
    name: "Suraj",
    title: "The Midwife",
    commits: 131,
    quote: "ao start does everything",
  },
  {
    name: "Harsh Batheja",
    title: "The Architect of Boundaries",
    commits: 60,
    quote: "Workers are workers. Orchestrators are orchestrators.",
  },
  {
    name: "Ashish",
    title: "The Painter",
    commits: 16,
    quote: "3,351 additions in one PR",
  },
  {
    name: "Wjayesh",
    title: "The Bridge Builder",
    commits: 4,
    quote: "Made the system polyglot",
  },
  {
    name: "Deepak7704",
    title: "The Tester",
    commits: 4,
    quote: "Six green PRs in one day",
  },
  {
    name: "Sigvardt",
    title: "The Healer",
    commits: 1,
    quote: "One PR. Changed everything.",
  },
  {
    name: "Andykamin3",
    title: "The Cartographer",
    commits: 1,
    quote: "Drew the map",
  },
  {
    name: "Kaavee315",
    title: "The Fixer",
    commits: 1,
    quote: "Unlocked ad-hoc spawns",
  },
  {
    name: "Sujayjayjay",
    title: "The Herald",
    commits: 2,
    quote: "Planted the flag",
  },
];

export const CARD_FRAMES = 240; // 8s per contributor
export const INTRO_FRAMES = 180; // 6s opening
export const OUTRO_FRAMES = 120; // 4s closing
export const PANTHEON_TOTAL_FRAMES =
  INTRO_FRAMES + CONTRIBUTORS.length * CARD_FRAMES + OUTRO_FRAMES;
// 180 + 2400 + 120 = 2700 = 90s
