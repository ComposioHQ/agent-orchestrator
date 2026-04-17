import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { bundle } from "@remotion/bundler";
import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";
import { exec } from "../shell.js";
import { createBlueprintSceneDefaults, launchFamilySpecV1 } from "./spec.js";
import type { KeyframeRecord } from "./pipeline-types.js";
import type { LaunchVideoRenderInput } from "./render-types.js";
import type {
  AnalysisScene,
  ArtifactPaths,
  AudioEvent,
  BlueprintScene,
  EditorialAnalysis,
  JudgeOutput,
  LaunchVideoBlueprintV1,
  MotionAnalysis,
  ReferenceMetadata,
  StyleAnalysis,
  TranscriptOutput,
  TranscriptSegment,
} from "./types.js";
import {
  BLUEPRINT_SCHEMA_VERSION,
  JUDGE_SCHEMA_VERSION,
  LAUNCH_FAMILY_SPEC_VERSION,
} from "./types.js";

interface ToolchainAvailability {
  ffmpegAvailable: boolean;
  ffprobeAvailable: boolean;
  swiftAvailable: boolean;
  whisperAvailable: boolean;
}

interface InspectResult {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  nominalFrameRate: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
}

interface FrameAnalysis {
  path: string;
  width: number;
  height: number;
  averageHex: string;
  palette: string[];
  brightness: number;
  contrast: number;
  textLines: string[];
}

interface FrameDiff {
  fromPath: string;
  toPath: string;
  differenceScore: number;
}

interface AnalyzeOptions {
  inputPath: string;
  outputRoot?: string;
  force?: boolean;
  projectName?: string;
}

interface CommonCommandOptions {
  inputPath?: string;
  artifactDir?: string;
  outputRoot?: string;
  force?: boolean;
  projectName?: string;
}

export interface AnalyzeResult {
  artifactPaths: ArtifactPaths;
  metadata: ReferenceMetadata;
  cached: boolean;
}

export interface BlueprintResult {
  artifactPaths: ArtifactPaths;
  blueprint: LaunchVideoBlueprintV1;
  cached: boolean;
}

export interface JudgeResult {
  artifactPaths: ArtifactPaths;
  judge: JudgeOutput;
  cached: boolean;
}

export interface BuildResult {
  artifactPaths: ArtifactPaths;
  renderOutputPath: string;
  buildMetadataPath: string;
  cached: boolean;
}

export interface ReviseResult {
  artifactPaths: ArtifactPaths;
  revisionPlanPath: string;
  cached: boolean;
}

const DEFAULT_OUTPUT_ROOT = "/Users/suraj.markupgmail.com/Desktop/video-hackathon-mvp";

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+/g, "")
      .replace(/-+$/g, "") || "reference"
  );
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toAspectRatio(width: number | null, height: number | null): string | null {
  if (!width || !height) return null;
  const rounded = (width / height).toFixed(2);
  return `${rounded}:1`;
}

function durationBucket(durationSeconds: number | null): "short" | "medium" | "long" {
  if (durationSeconds === null || durationSeconds <= 30) return "short";
  if (durationSeconds <= 90) return "medium";
  return "long";
}

function prettyJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, prettyJson(value), "utf8");
}

function writeTextFile(path: string, value: string): void {
  writeFileSync(path, value.endsWith("\n") ? value : `${value}\n`, "utf8");
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function clampScore(value: number): number {
  return Math.max(1, Math.min(10, Math.round(value)));
}

export function getSwiftToolPath(): string {
  return resolve(
    decodeURIComponent(
      new URL("../../assets/launch-video/avfoundation-tool.swift", import.meta.url).pathname,
    ),
  );
}

function createTempSwiftTool(): string {
  const tempDir = mkdtempSync(join(tmpdir(), "ao-launch-video-"));
  const tempScriptPath = join(tempDir, "avfoundation-tool.swift");
  writeFileSync(tempScriptPath, readFileSync(getSwiftToolPath(), "utf8"), "utf8");
  return tempScriptPath;
}

async function runSwiftJson<T>(args: string[]): Promise<T> {
  const scriptPath = createTempSwiftTool();
  const { stdout } = await exec("swift", [scriptPath, ...args]);
  return JSON.parse(stdout) as T;
}

export function resolveArtifactPaths(
  _inputPath: string,
  outputRoot = DEFAULT_OUTPUT_ROOT,
): ArtifactPaths {
  const rootDir = resolve(outputRoot);
  return {
    rootDir,
    referenceDir: join(rootDir, "reference"),
    analysisDir: join(rootDir, "analysis"),
    blueprintsDir: join(rootDir, "blueprints"),
    judgeDir: join(rootDir, "judge"),
    rendersDir: join(rootDir, "renders"),
    keyframesDir: join(rootDir, "analysis", "keyframes"),
  };
}

function ensureArtifactTree(paths: ArtifactPaths): void {
  for (const path of [
    paths.rootDir,
    paths.referenceDir,
    paths.analysisDir,
    paths.blueprintsDir,
    paths.judgeDir,
    paths.rendersDir,
    paths.keyframesDir,
  ]) {
    mkdirSync(path, { recursive: true });
  }
}

function clearDirectory(path: string): void {
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path)) {
    rmSync(join(path, entry), { recursive: true, force: true });
  }
}

async function commandAvailable(command: string): Promise<boolean> {
  try {
    await exec("zsh", ["-lc", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

async function detectToolchain(): Promise<ToolchainAvailability> {
  const [ffmpegAvailable, ffprobeAvailable, swiftAvailable, whisperAvailable] = await Promise.all([
    commandAvailable("ffmpeg"),
    commandAvailable("ffprobe"),
    commandAvailable("swift"),
    commandAvailable("whisper"),
  ]);

  return { ffmpegAvailable, ffprobeAvailable, swiftAvailable, whisperAvailable };
}

async function inspectReference(
  inputPath: string,
  toolchain: ToolchainAvailability,
): Promise<InspectResult> {
  if (toolchain.swiftAvailable) {
    return runSwiftJson<InspectResult>(["inspect", resolve(inputPath)]);
  }

  const { stdout } = await exec("mdls", [
    "-name",
    "kMDItemDurationSeconds",
    "-name",
    "kMDItemPixelWidth",
    "-name",
    "kMDItemPixelHeight",
    "-name",
    "kMDItemCodecs",
    resolve(inputPath),
  ]);

  const durationMatch = stdout.match(/kMDItemDurationSeconds\s+=\s+([0-9.]+)/);
  const widthMatch = stdout.match(/kMDItemPixelWidth\s+=\s+([0-9]+)/);
  const heightMatch = stdout.match(/kMDItemPixelHeight\s+=\s+([0-9]+)/);
  const codecMatches = [...stdout.matchAll(/"([^"]+)"/g)].map((match) => match[1]);

  return {
    durationSeconds: durationMatch ? Number(durationMatch[1]) : null,
    width: widthMatch ? Number(widthMatch[1]) : null,
    height: heightMatch ? Number(heightMatch[1]) : null,
    nominalFrameRate: null,
    videoCodec: codecMatches[0] ?? null,
    audioCodec: codecMatches[1] ?? null,
    hasAudio: codecMatches.length > 1,
  };
}

function buildScenePlan(durationSeconds: number | null): Array<{
  role: AnalysisScene["role"];
  beatIndex: number | null;
  label: string;
  startSeconds: number;
  endSeconds: number;
  copyIntent: string;
  editorialPurpose: string;
}> {
  const safeDuration = durationSeconds && durationSeconds > 0 ? durationSeconds : 60;
  const ratios = [
    {
      role: "hook",
      beatIndex: null,
      label: "Hook",
      ratio: 0.08,
      copyIntent: "Lead with the clearest transformation headline or strongest proof-driven claim.",
      editorialPurpose:
        "Win attention immediately and frame the launch as urgent or newly possible.",
    },
    {
      role: "before",
      beatIndex: null,
      label: "Before",
      ratio: 0.14,
      copyIntent:
        "Show the problem state, friction, or old workflow that makes the product matter.",
      editorialPurpose:
        "Set up contrast before the product reveal so later value beats feel earned.",
    },
    {
      role: "after",
      beatIndex: null,
      label: "After",
      ratio: 0.16,
      copyIntent: "Introduce the improved workflow and clarify what changes after adoption.",
      editorialPurpose: "Transition from tension to solution with the cleanest single reveal.",
    },
    {
      role: "value-beats",
      beatIndex: 0,
      label: "Value Beat 1",
      ratio: 0.16,
      copyIntent: "Surface the first concrete capability or proof point.",
      editorialPurpose: "Make the value proposition specific rather than generic.",
    },
    {
      role: "value-beats",
      beatIndex: 1,
      label: "Value Beat 2",
      ratio: 0.15,
      copyIntent: "Layer a second benefit, workflow step, or business outcome.",
      editorialPurpose: "Sustain momentum with a modular supporting beat.",
    },
    {
      role: "value-beats",
      beatIndex: 2,
      label: "Value Beat 3",
      ratio: 0.15,
      copyIntent: "Add another differentiator, feature, or evidence beat.",
      editorialPurpose: "Finish the proof stack before the CTA lands.",
    },
    {
      role: "outro",
      beatIndex: null,
      label: "Outro",
      ratio: 0.16,
      copyIntent: "Close on CTA, brand memory, or next action.",
      editorialPurpose: "Convert attention into action and leave a clear final frame.",
    },
  ] as const;

  let cursor = 0;
  return ratios.map((item, index) => {
    const remaining = safeDuration - cursor;
    const rawDuration = index === ratios.length - 1 ? remaining : safeDuration * item.ratio;
    const duration = Number(Math.max(2, rawDuration).toFixed(2));
    const startSeconds = Number(cursor.toFixed(2));
    const endSeconds = Number(Math.min(safeDuration, cursor + duration).toFixed(2));
    cursor = endSeconds;
    return {
      role: item.role,
      beatIndex: item.beatIndex,
      label: item.label,
      startSeconds,
      endSeconds,
      copyIntent: item.copyIntent,
      editorialPurpose: item.editorialPurpose,
    };
  });
}

function sceneMidpoints(scenes: ReturnType<typeof buildScenePlan>): number[] {
  return scenes.map((scene) => Number(((scene.startSeconds + scene.endSeconds) / 2).toFixed(2)));
}

function perSecondTimes(durationSeconds: number | null): number[] {
  const safeDuration = durationSeconds && durationSeconds > 0 ? durationSeconds : 60;
  const times: number[] = [];
  for (let t = 0; t < safeDuration; t += 1) {
    times.push(Number(t.toFixed(2)));
  }
  return times;
}

function findNearestKeyframe(
  keyframes: KeyframeRecord[],
  targetTime: number,
): KeyframeRecord | undefined {
  let best: KeyframeRecord | undefined;
  let bestDelta = Infinity;
  for (const kf of keyframes) {
    const delta = Math.abs(kf.timeSeconds - targetTime);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = kf;
    }
  }
  return best;
}

function findKeyframesInRange(
  keyframes: KeyframeRecord[],
  startSeconds: number,
  endSeconds: number,
): KeyframeRecord[] {
  return keyframes.filter((kf) => kf.timeSeconds >= startSeconds && kf.timeSeconds < endSeconds);
}

async function extractKeyframes(
  inputPath: string,
  outputDir: string,
  times: number[],
  toolchain: ToolchainAvailability,
): Promise<KeyframeRecord[]> {
  if (!toolchain.swiftAvailable || times.length === 0) return [];
  clearDirectory(outputDir);
  return runSwiftJson<KeyframeRecord[]>([
    "keyframes",
    resolve(inputPath),
    outputDir,
    times.map((value) => value.toFixed(2)).join(","),
  ]);
}

async function analyzeKeyframes(
  keyframes: KeyframeRecord[],
  toolchain: ToolchainAvailability,
): Promise<FrameAnalysis[]> {
  if (!toolchain.swiftAvailable || keyframes.length === 0) return [];
  return runSwiftJson<FrameAnalysis[]>([
    "analyze-images",
    keyframes.map((keyframe) => keyframe.path).join("|"),
  ]);
}

async function diffKeyframes(
  keyframes: KeyframeRecord[],
  toolchain: ToolchainAvailability,
): Promise<FrameDiff[]> {
  if (!toolchain.swiftAvailable || keyframes.length < 2) return [];
  return runSwiftJson<FrameDiff[]>([
    "diff-images",
    keyframes.map((keyframe) => keyframe.path).join("|"),
  ]);
}

function collectTypographyHints(textLines: string[]): string[] {
  if (textLines.length === 0) {
    return ["No OCR text detected in this keyframe; typography needs manual inspection."];
  }

  const uppercaseRatio =
    textLines
      .join("")
      .replace(/[^A-Za-z]/g, "")
      .split("")
      .filter((char) => char === char.toUpperCase()).length /
    Math.max(1, textLines.join("").replace(/[^A-Za-z]/g, "").length);
  const density = textLines.join(" ").length > 40 ? "text-dense" : "headline-led";

  return [
    uppercaseRatio > 0.6 ? "Uppercase-heavy headline treatment." : "Mixed-case headline treatment.",
    density === "text-dense"
      ? "Text density is moderate to high."
      : "Typography is concise and headline-first.",
  ];
}

function mapMotionDirectives(role: AnalysisScene["role"], diffScore: number): string[] {
  const directives = [
    diffScore > 0.28
      ? "Use hard cuts or high-contrast wipes between this and the next beat."
      : "Use clean direct cuts with minimal dead air.",
  ];

  if (role === "hook")
    directives.push("Front-load movement and headline animation in the first second.");
  if (role === "before")
    directives.push("Hold slightly longer to make the baseline problem legible.");
  if (role === "after")
    directives.push("Reveal the improved state with a cleaner, more stable move.");
  if (role === "value-beats")
    directives.push("Keep modular, repeatable transitions for proof stacking.");
  if (role === "outro") directives.push("Reduce cut speed slightly so the CTA can land.");
  return directives;
}

function inferAssetsUsed(textLines: string[]): string[] {
  const text = textLines.join(" ").toLowerCase();
  const assets: string[] = [];
  if (text.includes("platform") || text.includes("dashboard")) assets.push("product-ui");
  if (text.includes("advanced") || text.includes("management")) assets.push("headline-copy");
  if (text.includes("%") || text.includes("x")) assets.push("metric-proof");
  return assets.length > 0 ? assets : ["reference-motion-and-composition"];
}

function inferAssetsNeeded(role: AnalysisScene["role"]): string[] {
  if (role === "hook") return ["hero product shot", "headline copy", "proof visual"];
  if (role === "before") return ["problem-state UI or workflow shot"];
  if (role === "after") return ["clean product reveal", "outcome frame"];
  if (role === "outro") return ["CTA frame", "brand lockup", "URL or app-store destination"];
  return ["feature demo", "supporting proof", "benefit caption"];
}

function buildScenes(
  plannedScenes: ReturnType<typeof buildScenePlan>,
  keyframes: KeyframeRecord[],
  frameAnalyses: FrameAnalysis[],
  frameDiffs: FrameDiff[],
): AnalysisScene[] {
  return plannedScenes.map((scene, index) => {
    const frame = frameAnalyses[index];
    const diffScore =
      frameDiffs[index]?.differenceScore ?? frameDiffs[index - 1]?.differenceScore ?? 0.2;
    const detectedText = frame?.textLines ?? [];
    const energyScore = clampScore(diffScore * 12 + (frame?.contrast ?? 0.2) * 8 + 3);

    return {
      id: `scene-${String(index + 1).padStart(2, "0")}`,
      role: scene.role,
      beatIndex: scene.beatIndex,
      label: scene.label,
      startSeconds: scene.startSeconds,
      endSeconds: scene.endSeconds,
      durationSeconds: Number((scene.endSeconds - scene.startSeconds).toFixed(2)),
      keyframePath: keyframes[index]?.path ?? null,
      detectedText,
      copyIntent: scene.copyIntent,
      editorialPurpose: scene.editorialPurpose,
      assetSignals: {
        used: inferAssetsUsed(detectedText),
        needed: inferAssetsNeeded(scene.role),
        confidence: detectedText.length > 0 ? "observed" : "inferred",
      },
      motionDirectives: mapMotionDirectives(scene.role, diffScore),
      transition:
        diffScore > 0.32
          ? "High-contrast scene change; use a decisive cut."
          : "Moderate visual continuity; a direct cut should preserve rhythm.",
      palette: frame?.palette ?? [],
      typographyHints: collectTypographyHints(detectedText),
      energyScore,
      analysisStatus: detectedText.length > 0 ? "complete" : "partial",
      evidence: [
        keyframes[index]?.path
          ? `Keyframe sampled at ${keyframes[index].timeSeconds.toFixed(2)}s.`
          : "No keyframe available.",
        detectedText.length > 0
          ? `OCR detected: ${detectedText.join(" | ")}`
          : "No OCR text detected; scene interpretation leans on timing and image cues.",
        frame?.averageHex
          ? `Average frame color: ${frame.averageHex}.`
          : "Frame color analysis unavailable.",
      ],
      notes: [
        "Scene boundaries are still heuristic duration slices, but frame-level evidence is real.",
        "Replace heuristic segmentation with detector-based cuts later without changing the file contract.",
      ],
      detectionMethod: "heuristic-duration-slices",
    };
  });
}

function buildTranscript(
  scenes: AnalysisScene[],
  toolchain: ToolchainAvailability,
): TranscriptOutput {
  const segments: TranscriptSegment[] = scenes
    .filter((scene) => scene.detectedText.length > 0)
    .map((scene, index) => ({
      id: `segment-${String(index + 1).padStart(2, "0")}`,
      startSeconds: scene.startSeconds,
      endSeconds: scene.endSeconds,
      text: scene.detectedText.join(" "),
      source: "ocr",
      confidence: 0.55,
      partial: true,
    }));

  if (segments.length > 0) {
    return {
      status: "partial",
      provider: "visual-ocr-fallback",
      language: "en",
      summary:
        "Transcript is a partial OCR-derived fallback from representative keyframes because a speech transcription backend is not available in this environment.",
      segments,
      caveats: toolchain.whisperAvailable
        ? ["Whisper is installed but not yet wired into this command path."]
        : [
            "This is not speech transcription; it reflects on-screen text detected from keyframes.",
            "Install and wire Whisper or another ASR backend for spoken-word coverage.",
          ],
    };
  }

  return {
    status: "stub",
    provider: "none",
    language: null,
    summary: "No OCR text was detected and no speech transcription backend is available.",
    segments: [],
    caveats: ["Transcript remains incomplete until ASR is added."],
  };
}

function buildAudioEvents(scenes: AnalysisScene[], metadata: ReferenceMetadata): AudioEvent[] {
  const events: AudioEvent[] = [];

  if (metadata.hasAudio) {
    events.push({
      id: "audio-001",
      type: "music-bed",
      startSeconds: 0,
      endSeconds: scenes.at(-1)?.endSeconds ?? 0,
      inferred: true,
      confidence: 0.65,
      sceneId: null,
      evidence: [
        "Reference contains an audio track.",
        "Editorial pacing suggests a continuous score bed.",
      ],
      notes:
        "Audio envelope is not yet separated; this music-bed event is inferred from the presence of an AAC track and launch-style pacing.",
    });
  }

  for (const scene of scenes) {
    events.push({
      id: `audio-${scene.id}`,
      type:
        scene.role === "hook"
          ? "emphasis-rise"
          : scene.role === "outro"
            ? "cta-hit"
            : "transition-hit",
      startSeconds: scene.startSeconds,
      endSeconds: Number(Math.min(scene.endSeconds, scene.startSeconds + 0.9).toFixed(2)),
      inferred: true,
      confidence: 0.58,
      sceneId: scene.id,
      evidence: [
        `Scene role: ${scene.role}.`,
        `Scene energy score: ${scene.energyScore}.`,
        scene.transition,
      ],
      notes:
        "Event is inferred from edit structure and visual cadence, not yet from decoded waveform features.",
    });
  }

  events.push({
    id: "audio-voiceover-window",
    type: "voiceover-window",
    startSeconds: 0,
    endSeconds: scenes.at(-1)?.endSeconds ?? 0,
    inferred: true,
    confidence: 0.6,
    sceneId: null,
    evidence: [
      "OCR-derived text suggests there is headline copy worth mirroring in VO or captions.",
    ],
    notes: "Reserve this full-duration window for captions or future VO pass.",
  });

  return events;
}

function buildStyleAnalysis(
  metadata: ReferenceMetadata,
  frameAnalyses: FrameAnalysis[],
  scenes: AnalysisScene[],
): StyleAnalysis {
  const dominantPalette = unique(frameAnalyses.flatMap((frame) => frame.palette)).slice(0, 6);
  const textLines = frameAnalyses.flatMap((frame) => frame.textLines).slice(0, 8);
  const averageBrightness =
    frameAnalyses.reduce((sum, frame) => sum + frame.brightness, 0) /
    Math.max(1, frameAnalyses.length);
  const averageContrast =
    frameAnalyses.reduce((sum, frame) => sum + frame.contrast, 0) /
    Math.max(1, frameAnalyses.length);

  return {
    summary:
      "Reference reads as a concise B2B launch edit with headline-forward frames, product-led composition, and enough contrast to support bold overlays.",
    launchFamilyFit:
      "Strong fit for the launch family because the edit supports a clear hook, an explainer middle, and modular proof beats.",
    format: {
      aspectRatio: metadata.aspectRatio,
      resolution:
        metadata.width !== null && metadata.height !== null
          ? `${metadata.width}x${metadata.height}`
          : null,
      durationBucket: durationBucket(metadata.durationSeconds),
    },
    palette: {
      dominant: dominantPalette.slice(0, 4),
      accent: dominantPalette.slice(4, 6),
      backgroundBias: averageBrightness < 0.52 ? ["dark-leaning frames"] : ["mid-to-bright frames"],
    },
    typography: {
      observedTextLines: textLines,
      casing: textLines.some((line) => line === line.toUpperCase())
        ? "uppercase-forward"
        : "mixed-case",
      density: textLines.join(" ").length > 50 ? "high" : textLines.length > 0 ? "medium" : "low",
    },
    composition: [
      "Use bold single-message frames before adding dense proof beats.",
      "Maintain enough negative space for headlines and CTA overlays.",
      `Average contrast across sampled keyframes is ${averageContrast.toFixed(2)}.`,
    ],
    notes: [
      `Sampled ${frameAnalyses.length} representative keyframes across ${scenes.length} scene beats.`,
      "Palette observations come from quantized color buckets on each keyframe, not from manual art direction guesses.",
      "Typography observations are partial because they rely on OCR-detectable text, not font recognition.",
    ],
    analysisStatus: textLines.length > 0 ? "complete" : "partial",
  };
}

function buildMotionAnalysis(scenes: AnalysisScene[], frameDiffs: FrameDiff[]): MotionAnalysis {
  const averageDifference =
    frameDiffs.reduce((sum, diff) => sum + diff.differenceScore, 0) /
    Math.max(1, frameDiffs.length);
  const averageSceneDuration =
    scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0) / Math.max(1, scenes.length);
  const pace = averageSceneDuration <= 6 ? "fast" : averageSceneDuration <= 10 ? "medium" : "slow";
  const cameraEnergy =
    averageDifference > 0.28 ? "high" : averageDifference > 0.18 ? "medium" : "low";

  return {
    summary:
      "Motion analysis uses actual frame-to-frame difference between sampled keyframes to estimate pacing and transition intensity.",
    pace,
    cameraEnergy,
    transitionProfile: frameDiffs.map((diff, index) => ({
      fromSceneId: scenes[index]?.id ?? `scene-${index + 1}`,
      toSceneId: scenes[index + 1]?.id ?? `scene-${index + 2}`,
      differenceScore: Number(diff.differenceScore.toFixed(3)),
      interpretation:
        diff.differenceScore > 0.32
          ? "Strong visual reset; punchy transition energy."
          : diff.differenceScore > 0.18
            ? "Moderate beat change; direct cut rhythm."
            : "Relatively continuous visual language.",
    })),
    notes: [
      `Average scene duration: ${averageSceneDuration.toFixed(2)} seconds.`,
      `Average normalized keyframe difference: ${averageDifference.toFixed(3)}.`,
      "This is stronger than a pure guess, but still a sampled estimate rather than full optical-flow analysis.",
    ],
    analysisStatus: frameDiffs.length > 0 ? "complete" : "partial",
  };
}

function buildEditorialAnalysis(
  scenes: AnalysisScene[],
  transcript: TranscriptOutput,
): EditorialAnalysis {
  return {
    summary:
      "The reference maps cleanly to the launch family: it opens with a claim-bearing hook, establishes context, then spends most of its runtime on modular value beats before the exit frame.",
    structure: scenes.map((scene) => ({
      role: scene.role,
      purpose: scene.editorialPurpose,
      sceneId: scene.id,
    })),
    pacingNotes: [
      "Opening beat is short enough to function as a launch hook.",
      "Middle runtime is dominated by reusable proof modules.",
      "Outro has enough room for CTA but should tighten if a stronger closing asset appears.",
    ],
    openingObservation:
      transcript.segments[0]?.text ??
      "Opening observation inferred from the first keyframe rather than spoken dialogue.",
    closingObservation:
      scenes.at(-1)?.detectedText.join(" ") ||
      "Closing observation is inferred from the outro frame and role mapping.",
    notes: [
      "Editorial interpretation uses both OCR text and scene timing.",
      "Because scene segmentation is still heuristic, structure is more reliable than exact cut timing.",
    ],
    analysisStatus: "complete",
  };
}

function buildBlueprint(
  projectName: string,
  artifactPaths: ArtifactPaths,
  metadata: ReferenceMetadata,
  scenes: AnalysisScene[],
  style: StyleAnalysis,
  audioEvents: AudioEvent[],
  transcript: TranscriptOutput,
  editorial: EditorialAnalysis,
): LaunchVideoBlueprintV1 {
  const blueprintScenes: BlueprintScene[] = scenes.map((scene) => {
    const defaults = createBlueprintSceneDefaults(scene.role, scene.beatIndex);
    return {
      id: scene.id,
      role: scene.role,
      beatIndex: scene.beatIndex,
      startSeconds: scene.startSeconds,
      endSeconds: scene.endSeconds,
      durationSeconds: scene.durationSeconds,
      referenceSceneId: scene.id,
      referenceEvidence: scene.evidence,
      sourceKeyframePath: scene.keyframePath,
      detectedText: scene.detectedText,
      copyIntent: scene.copyIntent,
      editorialPurpose: scene.editorialPurpose,
      assetsUsed: scene.assetSignals.used,
      assetsNeeded: unique([...scene.assetSignals.needed, ...defaults.assetNeeds]),
      motionDirectives: unique([...scene.motionDirectives, ...defaults.visualDirection]),
      transition: scene.transition,
      palette: scene.palette,
      typographyHints: scene.typographyHints,
      outputIntent:
        scene.role === "hook"
          ? "Render a decisive opening frame that immediately states the transformation."
          : scene.role === "outro"
            ? "Render a clean closing frame with CTA, brand memory, and destination."
            : "Render a concrete launch beat that advances clarity or proof.",
    };
  });

  return {
    version: BLUEPRINT_SCHEMA_VERSION,
    project: {
      name: projectName,
      slug: slugify(projectName),
      generatedAt: new Date().toISOString(),
      artifactRoot: artifactPaths.rootDir,
    },
    reference: {
      originalPath: metadata.originalPath,
      artifactKey: metadata.artifactKey,
      durationSeconds: metadata.durationSeconds,
      dimensions: {
        width: metadata.width,
        height: metadata.height,
        aspectRatio: metadata.aspectRatio,
      },
      analysisPaths: [
        join(artifactPaths.analysisDir, "metadata.json"),
        join(artifactPaths.analysisDir, "scenes.json"),
        join(artifactPaths.analysisDir, "transcript.json"),
        join(artifactPaths.analysisDir, "audio-events.json"),
        join(artifactPaths.analysisDir, "style.json"),
        join(artifactPaths.analysisDir, "motion.json"),
        join(artifactPaths.analysisDir, "editorial.json"),
        join(artifactPaths.analysisDir, "blueprint-seed.json"),
        join(artifactPaths.analysisDir, "notes.md"),
      ],
    },
    assets: {
      used: unique(blueprintScenes.flatMap((scene) => scene.assetsUsed)),
      needed: unique(blueprintScenes.flatMap((scene) => scene.assetsNeeded)),
      available: [],
      stagingPath: join(artifactPaths.referenceDir, "assets.md"),
    },
    style: {
      northStar: style.summary,
      palette: style.palette.dominant,
      typography: unique(blueprintScenes.flatMap((scene) => scene.typographyHints)),
      guardrails: [
        "Keep the first claim legible inside the opening three seconds.",
        "Carry forward the observed palette bias rather than inventing a disconnected look.",
        "Use consistent proof-beat motion language so the middle of the video feels modular.",
      ],
      referenceNotes: [...style.notes, `Audio events identified: ${audioEvents.length}.`],
    },
    audio: {
      voiceoverStatus:
        transcript.status === "available"
          ? "ready"
          : transcript.status === "partial"
            ? "partial"
            : "pending",
      transcriptPath: join(artifactPaths.analysisDir, "transcript.json"),
      soundtrackDirection: [
        "Use a continuous score bed that supports quick transitions without masking headline copy.",
        "Reserve audible emphasis for hook, transition beats, and CTA landing.",
      ],
      eventsPath: join(artifactPaths.analysisDir, "audio-events.json"),
    },
    performance: {
      targetDurationSeconds: metadata.durationSeconds,
      hookTargetSeconds: 3,
      pacingStrategy:
        "Short hook, clear context, then modular proof beats with enough spacing for overlays and CTA.",
      primaryCTA: "Insert launch CTA once product assets or destination copy is provided.",
      successCriteria: [
        "Hook conveys the transformation in the first 3 seconds.",
        "Every value beat adds a specific proof or capability.",
        "Closing frame leaves a single next action.",
      ],
    },
    editorial: {
      familySpecVersion: LAUNCH_FAMILY_SPEC_VERSION,
      arcSummary: editorial.summary,
      pacingNotes: editorial.pacingNotes,
      notes: editorial.notes,
    },
    scenes: blueprintScenes,
    judge: {
      status: "pending",
      judgePath: join(artifactPaths.judgeDir, "judge-v1.json"),
      thresholds: {
        structure: 8,
        timing: 8,
        typography: 7,
        palette: 7,
        motion: 7,
        emotional_tone: 7,
      },
    },
  };
}

function buildJudge(artifactRoot: string, blueprint: LaunchVideoBlueprintV1): JudgeOutput {
  const transcript = readJsonFile<TranscriptOutput>(blueprint.audio.transcriptPath);
  const structure = clampScore(8 + (blueprint.scenes.length >= 5 ? 1 : -1));
  const timing = clampScore(
    8 - (blueprint.scenes.some((scene) => scene.durationSeconds > 14) ? 1 : 0),
  );
  const typography = clampScore(
    7 + (blueprint.style.typography.length > 0 ? 1 : -1) - (transcript.status === "stub" ? 1 : 0),
  );
  const palette = clampScore(7 + (blueprint.style.palette.length >= 3 ? 1 : 0));
  const motion = clampScore(
    7 + (blueprint.scenes.some((scene) => scene.motionDirectives.length >= 2) ? 1 : 0),
  );
  const emotionalTone = clampScore(
    6 +
      (blueprint.scenes[0]?.role === "hook" ? 1 : 0) +
      (blueprint.scenes.at(-1)?.role === "outro" ? 1 : 0),
  );

  const scores = {
    structure,
    timing,
    typography,
    palette,
    motion,
    emotional_tone: emotionalTone,
  };
  const approved = Object.values(scores).every((score) => score >= 7);

  return {
    version: JUDGE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    artifactRoot,
    summary: approved
      ? "The blueprint is structurally solid enough for a first build pass."
      : "The blueprint is concrete and buildable, but still needs stronger asset specificity and text coverage before a polished render.",
    scores,
    top_fixes: [
      transcript.status !== "available"
        ? "Replace OCR-only transcript coverage with spoken-word transcription or locked copy."
        : "Tighten copy hierarchy with final VO or caption script.",
      "Add real product, proof, and brand assets so inferred asset slots become concrete inputs.",
      "Convert the preview plan into a rendered first cut once assets are staged.",
    ],
    revision_notes: [
      "Preserve the current launch-family role order in the next iteration.",
      "Use the strongest OCR-backed line as the opening hook unless final launch copy supersedes it.",
      "Tighten the outro if the final CTA can land in under 8 seconds.",
    ],
    approved,
  };
}

function buildNotesMarkdown(
  metadata: ReferenceMetadata,
  scenes: AnalysisScene[],
  style: StyleAnalysis,
  motion: MotionAnalysis,
  editorial: EditorialAnalysis,
  transcript: TranscriptOutput,
): string {
  return [
    "# Reference Launch Video Notes",
    "",
    `- Reference: \`${metadata.originalPath}\``,
    `- Artifact key: \`${metadata.artifactKey}\``,
    `- Fingerprint: \`${metadata.fingerprint}\``,
    `- Duration: ${metadata.durationSeconds?.toFixed(2) ?? "unknown"}s`,
    `- Resolution: ${metadata.width ?? "?"}x${metadata.height ?? "?"}`,
    `- Transcript status: ${transcript.status}`,
    "",
    "## Style Summary",
    "",
    `- ${style.summary}`,
    `- Palette: ${style.palette.dominant.join(", ") || "n/a"}`,
    "",
    "## Motion Summary",
    "",
    `- ${motion.summary}`,
    ...motion.transitionProfile.map(
      (item) =>
        `- ${item.fromSceneId} -> ${item.toSceneId}: ${item.differenceScore.toFixed(3)} (${item.interpretation})`,
    ),
    "",
    "## Editorial Summary",
    "",
    `- ${editorial.summary}`,
    ...editorial.pacingNotes.map((note) => `- ${note}`),
    "",
    "## Scene Notes",
    "",
    ...scenes.flatMap((scene) => [
      `### ${scene.label}`,
      `- Role: ${scene.role}`,
      `- Timing: ${scene.startSeconds.toFixed(2)}s - ${scene.endSeconds.toFixed(2)}s`,
      `- Copy intent: ${scene.copyIntent}`,
      `- Editorial purpose: ${scene.editorialPurpose}`,
      `- Detected text: ${scene.detectedText.join(" | ") || "none detected"}`,
      `- Assets used: ${scene.assetSignals.used.join(", ")}`,
      `- Assets needed: ${scene.assetSignals.needed.join(", ")}`,
      `- Motion directives: ${scene.motionDirectives.join(" | ")}`,
      `- Palette: ${scene.palette.join(", ") || "n/a"}`,
      "",
    ]),
  ].join("\n");
}

function buildRenderPlan(blueprint: LaunchVideoBlueprintV1): string {
  return [
    "# Preview Render Plan v1",
    "",
    `- Intended output: \`${join(blueprint.project.artifactRoot, "renders", "preview-v1.mp4")}\``,
    `- Blueprint source: \`${join(blueprint.project.artifactRoot, "blueprints", "blueprint-v1.json")}\``,
    "",
    "## Scene Map",
    "",
    ...blueprint.scenes.flatMap((scene) => [
      `### ${scene.id} · ${scene.role}`,
      `- Timing: ${scene.startSeconds.toFixed(2)}s - ${scene.endSeconds.toFixed(2)}s (${scene.durationSeconds.toFixed(2)}s)`,
      `- Output intent: ${scene.outputIntent}`,
      `- Copy intent: ${scene.copyIntent}`,
      `- Editorial purpose: ${scene.editorialPurpose}`,
      `- Detected text: ${scene.detectedText.join(" | ") || "none detected"}`,
      `- Assets used: ${scene.assetsUsed.join(", ")}`,
      `- Assets needed next: ${scene.assetsNeeded.join(", ")}`,
      `- Motion directives: ${scene.motionDirectives.join(" | ")}`,
      `- Transition: ${scene.transition}`,
      `- Palette: ${scene.palette.join(", ") || "n/a"}`,
      `- Typography hints: ${scene.typographyHints.join(" | ")}`,
      "",
    ]),
    "## Next Render Step",
    "",
    "1. Stage product, brand, and proof assets in the Desktop artifact folder.",
    "2. Use the scene map above to replace inferred asset slots with actual files.",
    "3. Render a first cut that preserves the scene timings and motion directives before retiming for polish.",
  ].join("\n");
}

function renderRootPath(): string {
  return resolve(
    decodeURIComponent(new URL("./render-root.tsx", import.meta.url).pathname),
  );
}

function renderCommandString(artifactRoot: string): string {
  return (
    process.env["AO_LAUNCH_VIDEO_RENDER_COMMAND"] ??
    `pnpm --filter @aoagents/ao-cli dev -- launch-video build --artifact-dir ${artifactRoot} --project-name "Launch Video MVP" --force`
  );
}

function encodeFileAsDataUrl(path: string | null): string | null {
  if (!path || !existsSync(path)) return null;
  const buffer = readFileSync(path);
  const extension = path.endsWith(".png") ? "png" : "jpeg";
  return `data:image/${extension};base64,${buffer.toString("base64")}`;
}

function buildRenderInput(
  blueprint: LaunchVideoBlueprintV1,
  keyframeRecords: KeyframeRecord[],
): LaunchVideoRenderInput {
  const fps = 30;
  const width = blueprint.reference.dimensions.width ?? 640;
  const height = blueprint.reference.dimensions.height ?? 360;
  const durationInFrames = Math.max(
    1,
    Math.round((blueprint.performance.targetDurationSeconds ?? 10) * fps),
  );

  const scenes = blueprint.scenes.map((scene) => {
    const placeholderAssetsUsed = scene.assetsNeeded.filter(
      (asset) => !scene.assetsUsed.includes(asset),
    );
    return {
      ...scene,
      keyframeDataUrl: encodeFileAsDataUrl(scene.sourceKeyframePath),
      placeholderAssetsUsed,
    };
  });

  // Build per-second keyframe scenes for dense playback
  const keyframeScenes: LaunchVideoRenderInput["keyframeScenes"] = keyframeRecords
    .filter((kf) => existsSync(kf.path))
    .map((kf, index, arr) => {
      const nextTime = arr[index + 1]?.timeSeconds ?? kf.timeSeconds + 1;
      const duration = Number((nextTime - kf.timeSeconds).toFixed(2));
      // Determine which editorial role this keyframe falls under
      const matchingScene = blueprint.scenes.find(
        (s) => kf.timeSeconds >= s.startSeconds && kf.timeSeconds < s.endSeconds,
      );
      return {
        id: `kf-${String(index).padStart(3, "0")}`,
        startSeconds: kf.timeSeconds,
        endSeconds: Number((kf.timeSeconds + duration).toFixed(2)),
        durationSeconds: duration,
        keyframeDataUrl: encodeFileAsDataUrl(kf.path) ?? "",
        role: matchingScene?.role ?? null,
        label: matchingScene
          ? `${matchingScene.role.toUpperCase()} · ${matchingScene.copyIntent.slice(0, 60)}`
          : null,
      };
    })
    .filter((kf) => kf.keyframeDataUrl !== "");

  // Resolve the reference video path for direct playback
  const refPath = blueprint.reference.originalPath;
  const referenceVideoPath = refPath && existsSync(refPath) ? refPath : null;

  return {
    blueprint,
    scenes,
    keyframeScenes,
    referenceVideoPath,
    fps,
    width,
    height,
    durationInFrames,
    placeholderAssetsUsed: unique(scenes.flatMap((scene) => scene.placeholderAssetsUsed)),
  };
}

async function inspectVideoWithFfprobe(path: string): Promise<{
  durationSeconds: number;
  fps: number;
  width: number;
  height: number;
}> {
  const { stdout } = await exec("ffprobe", [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    path,
  ]);
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      duration?: string;
    }>;
    format?: { duration?: string };
  };
  const videoStream = parsed.streams?.find((stream) => stream.codec_type === "video");
  const frameRateText = videoStream?.avg_frame_rate ?? "30/1";
  const [num, den] = frameRateText.split("/").map(Number);
  const fps = den && num ? num / den : 30;
  return {
    durationSeconds: Number(parsed.format?.duration ?? videoStream?.duration ?? 0),
    fps,
    width: videoStream?.width ?? 640,
    height: videoStream?.height ?? 360,
  };
}

async function analyzeRenderedPreview(
  renderPath: string,
  toolchain: ToolchainAvailability,
): Promise<{ frameAnalyses: FrameAnalysis[]; frameDiffs: FrameDiff[] }> {
  if (!toolchain.swiftAvailable) {
    return { frameAnalyses: [], frameDiffs: [] };
  }

  const previewInfo = await inspectVideoWithFfprobe(renderPath);
  const tempDir = mkdtempSync(join(tmpdir(), "ao-launch-video-render-judge-"));
  const keyframes = await extractKeyframes(
    renderPath,
    tempDir,
    perSecondTimes(previewInfo.durationSeconds),
    toolchain,
  );
  const frameAnalyses = await analyzeKeyframes(keyframes, toolchain);
  const frameDiffs = await diffKeyframes(keyframes, toolchain);
  rmSync(tempDir, { recursive: true, force: true });
  return { frameAnalyses, frameDiffs };
}

function buildRenderedJudge(
  artifactRoot: string,
  blueprint: LaunchVideoBlueprintV1,
  renderMetadata: { durationSeconds: number; fps: number; width: number; height: number },
  frameAnalyses: FrameAnalysis[],
  frameDiffs: FrameDiff[],
): JudgeOutput {
  const targetDuration = blueprint.performance.targetDurationSeconds ?? renderMetadata.durationSeconds;
  const durationDelta = Math.abs(renderMetadata.durationSeconds - targetDuration);
  const paletteSet = new Set(blueprint.style.palette.map((color) => color.toLowerCase()));
  const paletteOverlap = frameAnalyses
    .flatMap((frame) => frame.palette)
    .filter((color) => paletteSet.has(color.toLowerCase())).length;
  const ocrDensity = frameAnalyses.reduce((sum, frame) => sum + frame.textLines.length, 0);
  const avgDiff =
    frameDiffs.reduce((sum, diff) => sum + diff.differenceScore, 0) / Math.max(1, frameDiffs.length);

  const scores = {
    structure: clampScore(8 + (blueprint.scenes.length >= 5 ? 1 : 0)),
    timing: clampScore(9 - durationDelta * 2),
    typography: clampScore(6 + Math.min(3, ocrDensity > 0 ? 2 : 0) + (ocrDensity > 4 ? 1 : 0)),
    palette: clampScore(6 + Math.min(3, paletteOverlap)),
    motion: clampScore(6 + (avgDiff > 0.08 ? 1 : 0) + (avgDiff > 0.16 ? 1 : 0)),
    emotional_tone: clampScore(6 + (frameAnalyses[0]?.contrast ?? 0) * 4 + (ocrDensity > 0 ? 1 : 0)),
  } satisfies JudgeOutput["scores"];
  const approved = Object.values(scores).every((score) => score >= 7);

  return {
    version: "judge-v2",
    generatedAt: new Date().toISOString(),
    artifactRoot,
    summary: approved
      ? "The rendered preview is structurally coherent and watchable as a first blueprint-driven candidate."
      : "The rendered preview exists and is inspectable, but it still reads as a placeholder-heavy first pass.",
    scores,
    top_fixes: [
      "Replace placeholder asset panels with real staged product and brand media.",
      "Improve typography fidelity by replacing OCR-derived text with approved launch copy.",
      "Add a final audio layer or VO so the motion beats land with more intent.",
    ],
    revision_notes: [
      `Rendered output measures ${renderMetadata.width}x${renderMetadata.height} at ${renderMetadata.fps.toFixed(2)} fps.`,
      "Keep the launch-family scene order intact while swapping in real assets.",
      "Use the rendered preview as the basis for blueprint-v2 timing adjustments rather than re-guessing from reference only.",
    ],
    approved,
  };
}

function buildAssetsMarkdown(
  blueprint: LaunchVideoBlueprintV1,
  placeholderAssetsUsed: string[],
): string {
  return [
    "# Assets Status",
    "",
    "## Real Inputs",
    "",
    `- Reference video: \`${blueprint.reference.originalPath}\``,
    "- Extracted reference keyframes from `analysis/keyframes/*.jpg`",
    "- OCR-detected text from the reference frames",
    "",
    "## Placeholder Inputs",
    "",
    ...placeholderAssetsUsed.map((asset) => `- ${asset}`),
    "",
    "## Next Asset Drops",
    "",
    ...blueprint.assets.needed.slice(0, 12).map((asset) => `- ${asset}`),
  ].join("\n");
}

function completeAnalysisExists(paths: ArtifactPaths): boolean {
  const requiredFiles = [
    join(paths.referenceDir, "reference.json"),
    join(paths.analysisDir, "metadata.json"),
    join(paths.analysisDir, "scenes.json"),
    join(paths.analysisDir, "transcript.json"),
    join(paths.analysisDir, "audio-events.json"),
    join(paths.analysisDir, "style.json"),
    join(paths.analysisDir, "motion.json"),
    join(paths.analysisDir, "editorial.json"),
    join(paths.analysisDir, "blueprint-seed.json"),
    join(paths.analysisDir, "notes.md"),
  ];
  return requiredFiles.every((path) => existsSync(path));
}

export async function analyzeReferenceVideo(options: AnalyzeOptions): Promise<AnalyzeResult> {
  const absoluteInputPath = resolve(options.inputPath);
  const stats = statSync(absoluteInputPath);
  const artifactPaths = resolveArtifactPaths(absoluteInputPath, options.outputRoot);
  ensureArtifactTree(artifactPaths);

  const fingerprint = stableHash(`${absoluteInputPath}:${stats.size}:${stats.mtimeMs}`);
  const artifactKey = `${basename(absoluteInputPath)}--${fingerprint.slice(0, 8)}`;
  const metadataPath = join(artifactPaths.analysisDir, "metadata.json");

  if (!options.force && existsSync(metadataPath) && completeAnalysisExists(artifactPaths)) {
    const existing = readJsonFile<ReferenceMetadata>(metadataPath);
    if (existing.fingerprint === fingerprint) {
      return {
        artifactPaths,
        metadata: { ...existing, cacheStatus: "reused" },
        cached: true,
      };
    }
  }

  const toolchain = await detectToolchain();
  const inspectResult = await inspectReference(absoluteInputPath, toolchain);
  const plannedScenes = buildScenePlan(inspectResult.durationSeconds);

  // Extract one keyframe per second for dense coverage
  const allKeyframeTimes = perSecondTimes(inspectResult.durationSeconds);
  const keyframes = await extractKeyframes(
    absoluteInputPath,
    artifactPaths.keyframesDir,
    allKeyframeTimes,
    toolchain,
  );
  const frameAnalyses = await analyzeKeyframes(keyframes, toolchain);
  const frameDiffs = await diffKeyframes(keyframes, toolchain);

  // Map the nearest keyframe to each scene midpoint for per-scene analysis
  const sceneMids = sceneMidpoints(plannedScenes);
  const sceneKeyframes = sceneMids.map((mid) => findNearestKeyframe(keyframes, mid));
  const sceneFrameAnalyses = sceneKeyframes.map((kf) =>
    kf ? frameAnalyses[keyframes.indexOf(kf)] : undefined,
  );
  const sceneFrameDiffs = sceneMids.map((_mid, index) => {
    const kf = sceneKeyframes[index];
    const nextKf = sceneKeyframes[index + 1];
    if (!kf || !nextKf) return undefined;
    const kfIdx = keyframes.indexOf(kf);
    const nextKfIdx = keyframes.indexOf(nextKf);
    return frameDiffs.find(
      (d) => d.fromPath === keyframes[kfIdx]?.path && d.toPath === keyframes[nextKfIdx]?.path,
    );
  });

  const metadata: ReferenceMetadata = {
    originalPath: absoluteInputPath,
    fileName: basename(absoluteInputPath),
    artifactKey,
    fingerprint,
    fileSizeBytes: stats.size,
    modifiedAt: new Date(stats.mtimeMs).toISOString(),
    durationSeconds: inspectResult.durationSeconds,
    width: inspectResult.width,
    height: inspectResult.height,
    aspectRatio: toAspectRatio(inspectResult.width, inspectResult.height),
    nominalFrameRate: inspectResult.nominalFrameRate,
    videoCodec: inspectResult.videoCodec,
    audioCodec: inspectResult.audioCodec,
    hasAudio: inspectResult.hasAudio,
    keyframeCount: keyframes.length,
    analyzedAt: new Date().toISOString(),
    cacheStatus: "generated",
    extraction: {
      ffmpegAvailable: toolchain.ffmpegAvailable,
      ffprobeAvailable: toolchain.ffprobeAvailable,
      swiftAvailable: toolchain.swiftAvailable,
      whisperAvailable: toolchain.whisperAvailable,
      sceneDetection: "heuristic-duration-slices",
      transcription: frameAnalyses.some((frame) => frame.textLines.length > 0)
        ? "visual-ocr-fallback"
        : toolchain.whisperAvailable
          ? "whisper"
          : "stub-missing-dependency",
      keyframeExtractor: toolchain.swiftAvailable ? "swift-avfoundation" : "none",
    },
  };

  // Build scenes using per-scene mapped keyframes
  const filteredSceneKeyframes = sceneKeyframes.filter((kf): kf is KeyframeRecord => kf !== undefined);
  const filteredSceneFrameAnalyses = sceneFrameAnalyses.filter((fa): fa is FrameAnalysis => fa !== undefined);
  const filteredSceneFrameDiffs = sceneFrameDiffs.filter((fd): fd is FrameDiff => fd !== undefined);
  const scenes = buildScenes(plannedScenes, filteredSceneKeyframes, filteredSceneFrameAnalyses, filteredSceneFrameDiffs);
  const transcript = buildTranscript(scenes, toolchain);
  const audioEvents = buildAudioEvents(scenes, metadata);
  // Use ALL keyframe data for richer style and motion analysis
  const style = buildStyleAnalysis(metadata, frameAnalyses, scenes);
  const motion = buildMotionAnalysis(scenes, frameDiffs);
  const editorial = buildEditorialAnalysis(scenes, transcript);
  const blueprintSeed = buildBlueprint(
    options.projectName ?? "Launch Video MVP",
    artifactPaths,
    metadata,
    scenes,
    style,
    audioEvents,
    transcript,
    editorial,
  );

  writeJsonFile(join(artifactPaths.referenceDir, "reference.json"), {
    originalPath: absoluteInputPath,
    artifactKey,
    fingerprint,
    fileSizeBytes: stats.size,
    modifiedAt: new Date(stats.mtimeMs).toISOString(),
    outputRoot: artifactPaths.rootDir,
  });
  writeTextFile(
    join(artifactPaths.referenceDir, "assets.md"),
    [
      "# Asset Staging",
      "",
      "Place future product, brand, proof, UI, and CTA assets beside this analysis bundle.",
      "The current blueprint reads from this location as the canonical staging point for the next render pass.",
    ].join("\n"),
  );
  writeJsonFile(join(artifactPaths.analysisDir, "keyframes.json"), keyframes);
  writeJsonFile(metadataPath, metadata);
  writeJsonFile(join(artifactPaths.analysisDir, "scenes.json"), scenes);
  writeJsonFile(join(artifactPaths.analysisDir, "transcript.json"), transcript);
  writeJsonFile(join(artifactPaths.analysisDir, "audio-events.json"), audioEvents);
  writeJsonFile(join(artifactPaths.analysisDir, "style.json"), style);
  writeJsonFile(join(artifactPaths.analysisDir, "motion.json"), motion);
  writeJsonFile(join(artifactPaths.analysisDir, "editorial.json"), editorial);
  writeJsonFile(join(artifactPaths.analysisDir, "blueprint-seed.json"), blueprintSeed);
  writeTextFile(
    join(artifactPaths.analysisDir, "notes.md"),
    buildNotesMarkdown(metadata, scenes, style, motion, editorial, transcript),
  );

  return { artifactPaths, metadata, cached: false };
}

function resolveArtifactPathsFromOptions(options: CommonCommandOptions): ArtifactPaths {
  if (options.artifactDir) {
    const rootDir = resolve(options.artifactDir);
    return {
      rootDir,
      referenceDir: join(rootDir, "reference"),
      analysisDir: join(rootDir, "analysis"),
      blueprintsDir: join(rootDir, "blueprints"),
      judgeDir: join(rootDir, "judge"),
      rendersDir: join(rootDir, "renders"),
      keyframesDir: join(rootDir, "analysis", "keyframes"),
    };
  }

  if (!options.inputPath) {
    throw new Error("Provide either --artifact-dir or --input.");
  }

  return resolveArtifactPaths(options.inputPath, options.outputRoot);
}

function ensureAnalyzed(paths: ArtifactPaths): void {
  if (!completeAnalysisExists(paths)) {
    throw new Error(`Analysis bundle is incomplete at ${paths.rootDir}. Run analysis first.`);
  }
}

export async function generateBlueprint(options: CommonCommandOptions): Promise<BlueprintResult> {
  const artifactPaths = resolveArtifactPathsFromOptions(options);
  ensureArtifactTree(artifactPaths);
  ensureAnalyzed(artifactPaths);

  const blueprintPath = join(artifactPaths.blueprintsDir, "blueprint-v1.json");
  if (!options.force && existsSync(blueprintPath)) {
    return {
      artifactPaths,
      blueprint: readJsonFile<LaunchVideoBlueprintV1>(blueprintPath),
      cached: true,
    };
  }

  const metadata = readJsonFile<ReferenceMetadata>(
    join(artifactPaths.analysisDir, "metadata.json"),
  );
  const scenes = readJsonFile<AnalysisScene[]>(join(artifactPaths.analysisDir, "scenes.json"));
  const style = readJsonFile<StyleAnalysis>(join(artifactPaths.analysisDir, "style.json"));
  const audioEvents = readJsonFile<AudioEvent[]>(
    join(artifactPaths.analysisDir, "audio-events.json"),
  );
  const transcript = readJsonFile<TranscriptOutput>(
    join(artifactPaths.analysisDir, "transcript.json"),
  );
  const editorial = readJsonFile<EditorialAnalysis>(
    join(artifactPaths.analysisDir, "editorial.json"),
  );
  const blueprint = buildBlueprint(
    options.projectName ?? "Launch Video MVP",
    artifactPaths,
    metadata,
    scenes,
    style,
    audioEvents,
    transcript,
    editorial,
  );

  writeJsonFile(blueprintPath, blueprint);
  return { artifactPaths, blueprint, cached: false };
}

export async function runJudge(options: CommonCommandOptions): Promise<JudgeResult> {
  const artifactPaths = resolveArtifactPathsFromOptions(options);
  ensureArtifactTree(artifactPaths);
  ensureAnalyzed(artifactPaths);

  const renderPath = join(artifactPaths.rendersDir, "preview-v1.mp4");
  const judgePath = existsSync(renderPath)
    ? join(artifactPaths.judgeDir, "judge-v2.json")
    : join(artifactPaths.judgeDir, "judge-v1.json");
  if (!options.force && existsSync(judgePath)) {
    return { artifactPaths, judge: readJsonFile<JudgeOutput>(judgePath), cached: true };
  }

  const blueprint = existsSync(join(artifactPaths.blueprintsDir, "blueprint-v1.json"))
    ? readJsonFile<LaunchVideoBlueprintV1>(join(artifactPaths.blueprintsDir, "blueprint-v1.json"))
    : (
        await generateBlueprint({
          artifactDir: artifactPaths.rootDir,
          projectName: options.projectName,
          force: options.force,
        })
      ).blueprint;
  let judge: JudgeOutput;
  if (existsSync(renderPath)) {
    const toolchain = await detectToolchain();
    const renderMetadata = await inspectVideoWithFfprobe(renderPath);
    const renderAnalysis = await analyzeRenderedPreview(renderPath, toolchain);
    judge = buildRenderedJudge(
      artifactPaths.rootDir,
      blueprint,
      renderMetadata,
      renderAnalysis.frameAnalyses,
      renderAnalysis.frameDiffs,
    );
  } else {
    judge = buildJudge(artifactPaths.rootDir, blueprint);
  }
  writeJsonFile(judgePath, judge);
  return { artifactPaths, judge, cached: false };
}

export async function createBuildPlan(options: CommonCommandOptions): Promise<BuildResult> {
  const artifactPaths = resolveArtifactPathsFromOptions(options);
  ensureArtifactTree(artifactPaths);
  ensureAnalyzed(artifactPaths);

  const renderPlanPath = join(artifactPaths.rendersDir, "preview-v1.md");
  const renderOutputPath = join(artifactPaths.rendersDir, "preview-v1.mp4");
  const buildMetadataPath = join(artifactPaths.rendersDir, "preview-v1-build.json");
  if (!options.force && existsSync(renderOutputPath) && existsSync(buildMetadataPath)) {
    return { artifactPaths, renderOutputPath, buildMetadataPath, cached: true };
  }

  const blueprint = existsSync(join(artifactPaths.blueprintsDir, "blueprint-v1.json"))
    ? readJsonFile<LaunchVideoBlueprintV1>(join(artifactPaths.blueprintsDir, "blueprint-v1.json"))
    : (
        await generateBlueprint({
          artifactDir: artifactPaths.rootDir,
          projectName: options.projectName,
          force: options.force,
        })
      ).blueprint;

  const keyframesPath = join(artifactPaths.analysisDir, "keyframes.json");
  const keyframeRecords: KeyframeRecord[] = existsSync(keyframesPath)
    ? readJsonFile<KeyframeRecord[]>(keyframesPath)
    : [];
  const renderInput = buildRenderInput(blueprint, keyframeRecords);

  // Stage the reference video into a temp public dir so Remotion can serve it
  const publicDir = mkdtempSync(join(tmpdir(), "ao-launch-video-public-"));
  const refVideoSrc = blueprint.reference.originalPath;
  if (refVideoSrc && existsSync(refVideoSrc)) {
    copyFileSync(refVideoSrc, join(publicDir, "reference-video.mp4"));
    renderInput.referenceVideoPath = "reference-video.mp4";
  }

  const browserStatus = await ensureBrowser({ logLevel: "error" });
  if (!("path" in browserStatus)) {
    throw new Error("Remotion could not resolve a Chromium browser executable.");
  }
  const browserExecutable = browserStatus.path;
  const bundledServeUrl = await bundle({
    entryPoint: renderRootPath(),
    publicDir,
    onProgress: () => undefined,
  });
  const composition = await selectComposition({
    id: "LaunchVideoPreview",
    serveUrl: bundledServeUrl,
    inputProps: renderInput,
    browserExecutable,
    logLevel: "error",
  });

  await renderMedia({
    composition,
    serveUrl: bundledServeUrl,
    codec: "h264",
    outputLocation: renderOutputPath,
    inputProps: renderInput,
    overwrite: true,
    browserExecutable,
    muted: true,
    logLevel: "error",
  });

  writeTextFile(renderPlanPath, buildRenderPlan(blueprint));
  writeTextFile(
    join(artifactPaths.referenceDir, "assets.md"),
    buildAssetsMarkdown(blueprint, renderInput.placeholderAssetsUsed),
  );
  writeJsonFile(buildMetadataPath, {
    blueprintPath: join(artifactPaths.blueprintsDir, "blueprint-v1.json"),
    renderCommandUsed: renderCommandString(artifactPaths.rootDir),
    compositionName: composition.id,
    fps: composition.fps,
    dimensions: {
      width: composition.width,
      height: composition.height,
    },
    durationInFrames: composition.durationInFrames,
    durationSeconds: composition.durationInFrames / composition.fps,
    placeholderAssetsUsed: renderInput.placeholderAssetsUsed,
    knownFidelityGaps: [
      "Rendered output still uses placeholder asset cards where product/brand media are missing.",
      "No final VO or music bed is mixed into preview-v1.mp4 yet.",
      "Typography is driven by system fonts and OCR-derived text, not final brand type.",
    ],
  });

  // Clean up temp public dir
  rmSync(publicDir, { recursive: true, force: true });

  return { artifactPaths, renderOutputPath, buildMetadataPath, cached: false };
}

export async function createRevisionPlan(options: CommonCommandOptions): Promise<ReviseResult> {
  const artifactPaths = resolveArtifactPathsFromOptions(options);
  ensureArtifactTree(artifactPaths);
  ensureAnalyzed(artifactPaths);

  const renderPath = join(artifactPaths.rendersDir, "preview-v1.mp4");
  const revisionPlanPath = existsSync(renderPath)
    ? join(artifactPaths.judgeDir, "revision-v2.json")
    : join(artifactPaths.judgeDir, "revision-v1.json");
  if (!options.force && existsSync(revisionPlanPath)) {
    return { artifactPaths, revisionPlanPath, cached: true };
  }

  const judgePath = existsSync(renderPath)
    ? join(artifactPaths.judgeDir, "judge-v2.json")
    : join(artifactPaths.judgeDir, "judge-v1.json");
  const judge =
    !options.force && existsSync(judgePath)
      ? readJsonFile<JudgeOutput>(judgePath)
      : (await runJudge({
          artifactDir: artifactPaths.rootDir,
          projectName: options.projectName,
          force: options.force,
        })).judge;
  const blueprint = existsSync(join(artifactPaths.blueprintsDir, "blueprint-v1.json"))
    ? readJsonFile<LaunchVideoBlueprintV1>(join(artifactPaths.blueprintsDir, "blueprint-v1.json"))
    : (
        await generateBlueprint({
          artifactDir: artifactPaths.rootDir,
          projectName: options.projectName,
          force: options.force,
        })
      ).blueprint;

  writeJsonFile(revisionPlanPath, {
    version: existsSync(renderPath) ? "revision-v2" : "revision-v1",
    generatedAt: new Date().toISOString(),
    sourceJudgePath: judgePath,
    approved: judge.approved,
    nextBlueprintTarget: "blueprints/blueprint-v2.json",
    renderPath: existsSync(renderPath) ? renderPath : null,
    keep: blueprint.scenes.map((scene) => ({
      sceneId: scene.id,
      role: scene.role,
      preserve: [
        `role=${scene.role}`,
        `timing=${scene.startSeconds.toFixed(2)}-${scene.endSeconds.toFixed(2)}`,
      ],
    })),
    top_fixes: judge.top_fixes,
    revision_notes: judge.revision_notes,
    concrete_next_steps: [
      existsSync(renderPath)
        ? "Replace placeholder cards in preview-v1.mp4 with real staged product and brand assets."
        : "Replace inferred asset slots with real Desktop-staged assets.",
      "Upgrade transcript coverage from OCR fallback to spoken transcription or approved copy.",
      existsSync(renderPath)
        ? "Cut blueprint-v2.json directly against the rendered preview timing."
        : "Use preview-v1.md as the direct render checklist for the first playable preview.",
    ],
  });

  return { artifactPaths, revisionPlanPath, cached: false };
}

export function summarizeAnalyzeResult(result: AnalyzeResult): string {
  return [
    `artifact_root=${result.artifactPaths.rootDir}`,
    `cache=${result.cached ? "reused" : "generated"}`,
    `artifact_key=${result.metadata.artifactKey}`,
    `duration_seconds=${result.metadata.durationSeconds ?? "unknown"}`,
    `keyframes=${result.metadata.keyframeCount}`,
  ].join("\n");
}

export function summarizeBlueprintResult(result: BlueprintResult): string {
  return [
    `artifact_root=${result.artifactPaths.rootDir}`,
    `blueprint=${join(result.artifactPaths.blueprintsDir, "blueprint-v1.json")}`,
    `cache=${result.cached ? "reused" : "generated"}`,
  ].join("\n");
}

export function summarizeJudgeResult(result: JudgeResult): string {
  return [
    `artifact_root=${result.artifactPaths.rootDir}`,
    `approved=${result.judge.approved}`,
    `cache=${result.cached ? "reused" : "generated"}`,
  ].join("\n");
}

export function summarizeBuildResult(result: BuildResult): string {
  return [
    `artifact_root=${result.artifactPaths.rootDir}`,
    `render_output=${result.renderOutputPath}`,
    `build_metadata=${result.buildMetadataPath}`,
    `cache=${result.cached ? "reused" : "generated"}`,
  ].join("\n");
}

export function summarizeReviseResult(result: ReviseResult): string {
  return [
    `artifact_root=${result.artifactPaths.rootDir}`,
    `revision_plan=${result.revisionPlanPath}`,
    `cache=${result.cached ? "reused" : "generated"}`,
  ].join("\n");
}

// ── LLM-powered pipeline functions ──────────────────────────────────

export interface LlmBuildResult {
  artifactPaths: ArtifactPaths;
  compositionPath: string;
  renderOutputPath: string;
  buildMetadataPath: string;
}

export interface LlmJudgeResult {
  artifactPaths: ArtifactPaths;
  judge: JudgeOutput;
  judgePath: string;
}

export interface AutoResult {
  artifactPaths: ArtifactPaths;
  analyzeResult: AnalyzeResult;
  blueprintResult: BlueprintResult;
  buildResult: LlmBuildResult;
  judgeResult: LlmJudgeResult;
}

function loadKeyframeRecords(artifactPaths: ArtifactPaths): KeyframeRecord[] {
  const keyframesPath = join(artifactPaths.analysisDir, "keyframes.json");
  return existsSync(keyframesPath) ? readJsonFile<KeyframeRecord[]>(keyframesPath) : [];
}

export async function llmBuild(options: CommonCommandOptions): Promise<LlmBuildResult> {
  const { generateComposition } = await import("./llm-builder.js");

  const artifactPaths = resolveArtifactPathsFromOptions(options);
  ensureArtifactTree(artifactPaths);
  ensureAnalyzed(artifactPaths);

  const blueprint = existsSync(join(artifactPaths.blueprintsDir, "blueprint-v1.json"))
    ? readJsonFile<LaunchVideoBlueprintV1>(join(artifactPaths.blueprintsDir, "blueprint-v1.json"))
    : (
        await generateBlueprint({
          artifactDir: artifactPaths.rootDir,
          projectName: options.projectName,
          force: options.force,
        })
      ).blueprint;

  const keyframeRecords = loadKeyframeRecords(artifactPaths);

  // Generate composition via LLM
  const compositionCode = await generateComposition(blueprint, keyframeRecords);
  const compositionPath = join(artifactPaths.rendersDir, "ai-composition.tsx");
  writeFileSync(compositionPath, compositionCode, "utf8");

  // Write a render-root that imports the AI-generated composition
  const aiRootCode = `import React from "react";
import { Composition, getInputProps, registerRoot } from "remotion";
import { LaunchVideoPreviewComposition } from "./ai-composition";
import type { LaunchVideoRenderInput } from "${resolve(
    decodeURIComponent(
      new URL("./render-types.js", import.meta.url).pathname,
    ),
  ).replace(/\.js$/, "")}";

const RemotionRoot: React.FC = () => {
  const inputProps = getInputProps() as Partial<LaunchVideoRenderInput>;
  const fps = inputProps.fps ?? 30;
  const width = inputProps.width ?? 640;
  const height = inputProps.height ?? 360;
  const durationInFrames = inputProps.durationInFrames ?? 300;

  return (
    <Composition
      id="LaunchVideoPreview"
      component={LaunchVideoPreviewComposition as React.ComponentType<Record<string, unknown>>}
      fps={fps}
      width={width}
      height={height}
      durationInFrames={durationInFrames}
      defaultProps={inputProps as Record<string, unknown>}
    />
  );
};

registerRoot(RemotionRoot);
`;
  const aiRootPath = join(artifactPaths.rendersDir, "ai-root.tsx");
  writeFileSync(aiRootPath, aiRootCode, "utf8");

  // Build render input (reuse existing function)
  const renderInput = buildRenderInput(blueprint, keyframeRecords);

  // Stage reference video for Remotion
  const publicDir = mkdtempSync(join(tmpdir(), "ao-launch-video-ai-public-"));
  const refVideoSrc = blueprint.reference.originalPath;
  if (refVideoSrc && existsSync(refVideoSrc)) {
    copyFileSync(refVideoSrc, join(publicDir, "reference-video.mp4"));
    renderInput.referenceVideoPath = "reference-video.mp4";
  }

  const browserStatus = await ensureBrowser({ logLevel: "error" });
  if (!("path" in browserStatus)) {
    throw new Error("Remotion could not resolve a Chromium browser executable.");
  }
  const browserExecutable = browserStatus.path;

  // Try to bundle the AI composition; fall back to standard if it fails
  const renderOutputPath = join(artifactPaths.rendersDir, "ai-preview-v1.mp4");
  const buildMetadataPath = join(artifactPaths.rendersDir, "ai-preview-v1-build.json");

  let bundledServeUrl: string;
  try {
    bundledServeUrl = await bundle({
      entryPoint: aiRootPath,
      publicDir,
      onProgress: () => undefined,
    });
  } catch (bundleError) {
    // If AI composition has syntax errors, fall back to standard composition
    console.error("AI composition failed to bundle, falling back to standard render.");
    console.error(String(bundleError));
    bundledServeUrl = await bundle({
      entryPoint: renderRootPath(),
      publicDir,
      onProgress: () => undefined,
    });
  }

  const composition = await selectComposition({
    id: "LaunchVideoPreview",
    serveUrl: bundledServeUrl,
    inputProps: renderInput,
    browserExecutable,
    logLevel: "error",
  });

  await renderMedia({
    composition,
    serveUrl: bundledServeUrl,
    codec: "h264",
    outputLocation: renderOutputPath,
    inputProps: renderInput,
    overwrite: true,
    browserExecutable,
    muted: true,
    logLevel: "error",
  });

  rmSync(publicDir, { recursive: true, force: true });

  writeJsonFile(buildMetadataPath, {
    mode: "llm-generated",
    compositionPath,
    renderOutputPath,
    blueprintPath: join(artifactPaths.blueprintsDir, "blueprint-v1.json"),
    fps: composition.fps,
    dimensions: { width: composition.width, height: composition.height },
    durationInFrames: composition.durationInFrames,
    durationSeconds: composition.durationInFrames / composition.fps,
  });

  return { artifactPaths, compositionPath, renderOutputPath, buildMetadataPath };
}

export async function llmJudgeCommand(options: CommonCommandOptions): Promise<LlmJudgeResult> {
  const { llmJudge } = await import("./llm-judge.js");

  const artifactPaths = resolveArtifactPathsFromOptions(options);
  ensureArtifactTree(artifactPaths);
  ensureAnalyzed(artifactPaths);

  const blueprint = existsSync(join(artifactPaths.blueprintsDir, "blueprint-v1.json"))
    ? readJsonFile<LaunchVideoBlueprintV1>(join(artifactPaths.blueprintsDir, "blueprint-v1.json"))
    : (
        await generateBlueprint({
          artifactDir: artifactPaths.rootDir,
          projectName: options.projectName,
          force: options.force,
        })
      ).blueprint;

  const keyframeRecords = loadKeyframeRecords(artifactPaths);
  const judge = await llmJudge(artifactPaths.rootDir, blueprint, keyframeRecords);
  const judgePath = join(artifactPaths.judgeDir, "llm-judge-v1.json");
  writeJsonFile(judgePath, judge);

  return { artifactPaths, judge, judgePath };
}

export async function runAuto(options: CommonCommandOptions & { inputPath: string }): Promise<AutoResult> {
  console.log("=== Step 1/4: Analyzing reference video ===");
  const analyzeResult = await analyzeReferenceVideo({
    inputPath: options.inputPath,
    outputRoot: options.outputRoot,
    projectName: options.projectName,
    force: options.force,
  });
  console.log(summarizeAnalyzeResult(analyzeResult));

  console.log("\n=== Step 2/4: Generating blueprint ===");
  const blueprintResult = await generateBlueprint({
    artifactDir: analyzeResult.artifactPaths.rootDir,
    projectName: options.projectName,
    force: options.force,
  });
  console.log(summarizeBlueprintResult(blueprintResult));

  console.log("\n=== Step 3/4: AI-generating composition & rendering ===");
  const buildResult = await llmBuild({
    artifactDir: analyzeResult.artifactPaths.rootDir,
    projectName: options.projectName,
    force: true,
  });
  console.log(`composition=${buildResult.compositionPath}`);
  console.log(`render_output=${buildResult.renderOutputPath}`);

  console.log("\n=== Step 4/4: AI judge review ===");
  const judgeResult = await llmJudgeCommand({
    artifactDir: analyzeResult.artifactPaths.rootDir,
    projectName: options.projectName,
    force: true,
  });
  console.log(`approved=${judgeResult.judge.approved}`);
  console.log(`summary=${judgeResult.judge.summary}`);
  for (const fix of judgeResult.judge.top_fixes) {
    console.log(`  fix: ${fix}`);
  }

  return { artifactPaths: analyzeResult.artifactPaths, analyzeResult, blueprintResult, buildResult, judgeResult };
}
