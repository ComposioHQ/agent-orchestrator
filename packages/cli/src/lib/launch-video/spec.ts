import type { LaunchFamilyRole } from "./types.js";

export interface LaunchFamilyRoleSpec {
  role: LaunchFamilyRole;
  objective: string;
  defaultDurationRatio: number;
  visualDirections: string[];
  copyPrompt: string;
  assetNeeds: string[];
}

export const launchFamilySpecV1: LaunchFamilyRoleSpec[] = [
  {
    role: "hook",
    objective: "Open with the strongest visual claim inside the first seconds.",
    defaultDurationRatio: 0.08,
    visualDirections: ["Bold opening frame", "Immediate curiosity gap", "Fast first cut"],
    copyPrompt: "Lead with the sharpest claim or transformation in plain language.",
    assetNeeds: ["hero-product", "hero-proof", "attention-grabbing visual"],
  },
  {
    role: "before",
    objective: "Make the pain, friction, or old workflow legible fast.",
    defaultDurationRatio: 0.14,
    visualDirections: ["Constraint framing", "Messy or slow baseline", "Contrast setup"],
    copyPrompt: "Show the problem state before the product enters.",
    assetNeeds: ["problem-state footage", "old workflow UI", "pain-point caption"],
  },
  {
    role: "after",
    objective: "Introduce the new state and reveal the product payoff.",
    defaultDurationRatio: 0.16,
    visualDirections: ["Clean reveal", "Outcome-forward framing", "Product enters decisively"],
    copyPrompt: "Pivot from friction to the transformed state with product context.",
    assetNeeds: ["product reveal", "transformed workflow", "headline payoff"],
  },
  {
    role: "value-beats",
    objective: "Stack the concrete reasons to believe in quick, modular beats.",
    defaultDurationRatio: 0.46,
    visualDirections: [
      "Rapid proof beats",
      "Alternating captions and UI",
      "Specific capability callouts",
    ],
    copyPrompt: "Sequence concrete benefits, proof points, or differentiators.",
    assetNeeds: ["feature demos", "proof artifacts", "benefit captions"],
  },
  {
    role: "outro",
    objective: "Land the CTA and brand memory with a controlled finish.",
    defaultDurationRatio: 0.16,
    visualDirections: ["Breathing room", "Clear CTA", "Brand lockup or tagline"],
    copyPrompt: "Close with the action you want next and the minimal brand reminder.",
    assetNeeds: ["cta frame", "brand lockup", "URL or product shot"],
  },
];

export interface BlueprintSceneDefaults {
  copyPrompt: string;
  visualDirection: string[];
  assetNeeds: string[];
}

export function createBlueprintSceneDefaults(
  role: LaunchFamilyRole,
  beatIndex: number | null,
): BlueprintSceneDefaults {
  const match = launchFamilySpecV1.find((item) => item.role === role);
  if (!match) {
    return {
      copyPrompt: "Fill this scene with the next strongest launch beat.",
      visualDirection: ["Use the reference pacing and framing as a guide."],
      assetNeeds: ["supporting visual"],
    };
  }

  return {
    copyPrompt:
      role === "value-beats" && beatIndex !== null
        ? `${match.copyPrompt} Focus this beat on proof point ${beatIndex + 1}.`
        : match.copyPrompt,
    visualDirection: match.visualDirections,
    assetNeeds: match.assetNeeds,
  };
}
