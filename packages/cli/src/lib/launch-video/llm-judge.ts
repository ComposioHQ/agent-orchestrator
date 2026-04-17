import type { KeyframeRecord } from "./pipeline-types.js";
import type { LaunchVideoBlueprintV1, JudgeOutput, JUDGE_SCHEMA_VERSION } from "./types.js";
import { encodeImageForApi, getClient, sampleEvenly } from "./llm-client.js";

export async function llmJudge(
  artifactRoot: string,
  blueprint: LaunchVideoBlueprintV1,
  keyframes: KeyframeRecord[],
): Promise<JudgeOutput> {
  const client = getClient();

  const sampled = sampleEvenly(keyframes, 6);
  const imageContent: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [];
  for (const kf of sampled) {
    const dataUrl = encodeImageForApi(kf.path);
    if (dataUrl) {
      imageContent.push({ type: "text", text: `Keyframe at ${kf.timeSeconds.toFixed(1)}s:` });
      imageContent.push({ type: "image_url", image_url: { url: dataUrl } });
    }
  }

  const blueprintJson = JSON.stringify(blueprint, null, 2);

  const response = await client.chat.completions.create({
    model: "gpt-5.4",
    max_completion_tokens: 2000,
    messages: [
      {
        role: "system",
        content: `You are a senior creative director reviewing a launch video blueprint and its reference keyframes.

Score each dimension 1-10 and provide actionable feedback. Be honest — if something is weak, say so.

You MUST respond with ONLY valid JSON matching this exact schema (no markdown, no explanation outside the JSON):

{
  "version": "judge-v1",
  "generatedAt": "<ISO timestamp>",
  "artifactRoot": "<provided>",
  "summary": "<2-3 sentence overall assessment>",
  "scores": {
    "structure": <1-10>,
    "timing": <1-10>,
    "typography": <1-10>,
    "palette": <1-10>,
    "motion": <1-10>,
    "emotional_tone": <1-10>
  },
  "top_fixes": ["<fix 1>", "<fix 2>", "<fix 3>"],
  "revision_notes": ["<note 1>", "<note 2>", "<note 3>"],
  "approved": <true if all scores >= 7>
}`,
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Review this launch video blueprint. The artifact root is: ${artifactRoot}

## Blueprint

\`\`\`json
${blueprintJson}
\`\`\`

## Reference keyframes from the video:`,
          },
          ...imageContent,
          {
            type: "text",
            text: `Score the blueprint on: structure (scene flow), timing (pacing), typography (text treatment), palette (color choices), motion (transitions/energy), emotional_tone (does it land?).

Respond with ONLY the JSON object.`,
          },
        ],
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) {
    throw new Error("LLM judge returned no content.");
  }

  let jsonText = content.trim();
  // Strip markdown fences if present
  if (jsonText.startsWith("```")) {
    jsonText = jsonText.replace(/^```(?:json)?\n/, "").replace(/\n```$/, "");
  }

  const parsed = JSON.parse(jsonText) as JudgeOutput;

  // Ensure required fields
  return {
    version: "judge-v1" as typeof JUDGE_SCHEMA_VERSION,
    generatedAt: parsed.generatedAt || new Date().toISOString(),
    artifactRoot,
    summary: parsed.summary || "No summary provided.",
    scores: {
      structure: clamp(parsed.scores?.structure ?? 5),
      timing: clamp(parsed.scores?.timing ?? 5),
      typography: clamp(parsed.scores?.typography ?? 5),
      palette: clamp(parsed.scores?.palette ?? 5),
      motion: clamp(parsed.scores?.motion ?? 5),
      emotional_tone: clamp(parsed.scores?.emotional_tone ?? 5),
    },
    top_fixes: parsed.top_fixes ?? [],
    revision_notes: parsed.revision_notes ?? [],
    approved: parsed.approved ?? Object.values(parsed.scores ?? {}).every((s) => (s as number) >= 7),
  };
}

function clamp(value: number): number {
  return Math.max(1, Math.min(10, Math.round(value)));
}
