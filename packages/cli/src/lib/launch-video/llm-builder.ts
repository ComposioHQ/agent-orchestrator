import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KeyframeRecord } from "./pipeline-types.js";
import type { LaunchVideoBlueprintV1 } from "./types.js";
import { getClient, sampleEvenly } from "./llm-client.js";

const SKILL_DIR = join(
  process.env["HOME"] ?? "/tmp",
  "Desktop",
  "launch-video-craft",
);

function loadStarterTemplate(): string {
  const starterPath = join(SKILL_DIR, "recipes", "starter-template.tsx");
  if (existsSync(starterPath)) {
    return readFileSync(starterPath, "utf8");
  }
  return "";
}

function condenseBlueprintForPrompt(blueprint: LaunchVideoBlueprintV1): string {
  const scenes = blueprint.scenes.map((s) => ({
    id: s.id,
    role: s.role,
    start: s.startSeconds,
    end: s.endSeconds,
    dur: s.durationSeconds,
    text: s.detectedText.slice(0, 2),
    copy: s.copyIntent,
    palette: s.palette.slice(0, 3),
  }));

  return JSON.stringify({
    targetDuration: blueprint.performance.targetDurationSeconds,
    width: blueprint.reference.dimensions.width,
    height: blueprint.reference.dimensions.height,
    palette: blueprint.style.palette.slice(0, 4),
    scenes,
  }, null, 2);
}

export async function generateComposition(
  blueprint: LaunchVideoBlueprintV1,
  _keyframes: KeyframeRecord[],
): Promise<string> {
  const client = getClient();
  const starterTemplate = loadStarterTemplate();
  const condensedBlueprint = condenseBlueprintForPrompt(blueprint);

  const systemPrompt = `You are an expert React/Remotion developer. Generate a complete, working .tsx file for a product launch video.

OUTPUT RULES:
- Output ONLY valid TypeScript/React code. No explanations, no markdown fences.
- Export a named component: export const LaunchVideoPreviewComposition: React.FC<LaunchVideoRenderInput>
- Import type { LaunchVideoRenderInput } from "./render-types.js"
- Use Remotion: AbsoluteFill, Sequence, Img, interpolate, spring, useCurrentFrame, useVideoConfig
- Use system fonts only (Helvetica Neue, Arial, sans-serif)
- Do NOT use staticFile(). Keyframe images come from props.keyframeScenes[].keyframeDataUrl (base64 data URLs)
- Handle empty arrays gracefully

ANIMATION PATTERNS TO USE:
- Hook scene: Bold text with fade-in and scale animation
- Before/After scenes: Show keyframe image backgrounds with subtle zoom (ken-burns: scale 1.0 to 1.08)
- Value beats: Text with clip-path reveal (inset from right, ease-out cubic)
- Outro: Clean fade with brand text

COLOR PALETTE from the blueprint (use these):
Dark fallback: bg="#030B1F", accent="#3B82F6", white="#EFF6FF"`;

  const userPrompt = `Generate a Remotion composition for this launch video:

BLUEPRINT:
${condensedBlueprint}

${starterTemplate ? `REFERENCE TEMPLATE (adapt this structure, change the content to match the blueprint above):
\`\`\`tsx
${starterTemplate}
\`\`\`

` : ""}The composition must:
1. Match the scene timings from the blueprint exactly
2. Use props.keyframeScenes to find background images (match by startSeconds)
3. Show detected text or copyIntent as headlines per scene
4. Total duration: ${blueprint.performance.targetDurationSeconds ?? 60}s at 30fps = ${Math.round((blueprint.performance.targetDurationSeconds ?? 60) * 30)} frames

Output the complete .tsx file now:`;

  const response = await client.chat.completions.create({
    model: "gpt-5.4",
    max_completion_tokens: 8000,
    temperature: 0.3,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("LLM builder returned no content.");
  }

  let code = content.trim();

  // Strip markdown code fences if present
  if (code.startsWith("```")) {
    code = code.replace(/^```(?:tsx?)?\n/, "").replace(/\n```$/, "");
  }

  // Validate it looks like code
  if (!code.includes("LaunchVideoPreviewComposition") && !code.includes("import")) {
    throw new Error(`LLM builder returned non-code response: ${code.slice(0, 200)}`);
  }

  return code;
}
