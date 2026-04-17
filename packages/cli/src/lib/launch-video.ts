import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExecResult } from "./shell.js";
import { exec } from "./shell.js";

export interface SampledFrame {
  index: number;
  timeSeconds: number;
  timestamp: string;
  fileName: string;
  relativePath: string;
  averageLuma: number;
  averageColorHex: string;
  meanPixelDifferenceFromPrevious: number;
}

export interface RawReferenceAnalysis {
  inputPath: string;
  generatedAt: string;
  durationSeconds: number;
  width: number;
  height: number;
  nominalFrameRate: number;
  sampleIntervalSeconds: number;
  hasAudioTrack: boolean;
  audioRelativePath: string | null;
  frames: SampledFrame[];
}

export interface ReferenceScene {
  index: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  startTimestamp: string;
  endTimestamp: string;
  keyframeRelativePath: string;
  sampleFrameRelativePath: string;
  confidence: "high" | "medium";
  trigger: "opening" | "detected-cut" | "closing";
  cue: string;
  dominantColorHex: string;
  averageMotionDelta: number;
}

export interface LaunchStyleMapping {
  family: "launch-style";
  archetype: "hook-proof-payoff" | "demo-drop" | "founder-voiceover-reveal" | "social-proof-sprint";
  pacing: "measured-build" | "steady-escalation" | "rapid-cadence";
  rationale: string[];
  editorialSignals: string[];
}

export interface LaunchBlueprint {
  schemaVersion: "launch-video-blueprint/v1";
  source: {
    artifactRoot: string;
    inputPath: string;
    sourceHash: string;
    durationSeconds: number;
    dimensions: {
      width: number;
      height: number;
    };
  };
  family: "launch-style";
  style: {
    mappedArchetype: LaunchStyleMapping["archetype"];
    pacing: LaunchStyleMapping["pacing"];
    tone: string[];
    rationale: string[];
  };
  scenes: Array<{
    sceneId: string;
    order: number;
    sourceSceneIndex: number;
    startSeconds: number;
    endSeconds: number;
    durationSeconds: number;
    keyframeRelativePath: string;
    intent: string;
    visualNotes: string[];
    editorialRole: "hook" | "problem" | "proof" | "payoff" | "cta";
    motionProfile: "low" | "medium" | "high";
    emotion: {
      primary: string;
      secondary: string;
      confidence: "placeholder";
    };
    performance: {
      delivery: string;
      shotDirection: string;
      placeholder: true;
    };
  }>;
  audio: {
    sourceAudioRelativePath: string | null;
    transcriptRelativePath: string;
    strategy: string;
    notes: string[];
  };
  editorial: {
    beatStructure: string[];
    cutPattern: string;
    transitions: string[];
    placeholders: string[];
  };
  performance: {
    presenterMode: string;
    captureNeeds: string[];
  };
  emotion: {
    intendedArc: string[];
    notes: string[];
  };
}

export interface BuilderScaffold {
  schemaVersion: "launch-video-builder-scaffold/v1";
  blueprintRelativePath: string;
  sourceArtifactRoot: string;
  renderFamily: "launch-style";
  renderStatus: "pending-assets";
  builderInputs: {
    keyframesDir: string;
    transcriptPath: string;
    notesPath: string;
  };
  unresolved: string[];
  placeholders: {
    brandName: string;
    product: string;
    coreClaim: string;
    cta: string;
    assetPack: string[];
  };
}

export interface TranscriptPlaceholder {
  schemaVersion: "reference-transcript/v1";
  status: "audio_extracted_pending_transcription";
  sourceAudioRelativePath: string | null;
  generatedAt: string;
  tool: string | null;
  language: string | null;
  segments: Array<{
    startSeconds: number;
    endSeconds: number;
    text: string;
  }>;
  notes: string[];
}

export interface LaunchVideoPaths {
  artifactRoot: string;
  analysisDir: string;
  framesDir: string;
  keyframesDir: string;
  audioDir: string;
  transcriptDir: string;
  notesDir: string;
  blueprintsDir: string;
  builderDir: string;
  manifestPath: string;
  rawAnalysisPath: string;
  scenesPath: string;
  summaryPath: string;
  transcriptPath: string;
  blueprintPath: string;
  builderPath: string;
  notesPath: string;
}

export interface LaunchVideoIngestOptions {
  inputPath: string;
  cwd: string;
  outputRoot?: string;
  sampleIntervalSeconds?: number;
  sceneThreshold?: number;
  minSceneLengthSeconds?: number;
  force?: boolean;
}

export interface LaunchVideoIngestResult {
  artifactRoot: string;
  blueprintPath: string;
  builderPath: string;
  transcriptPath: string;
  scenesPath: string;
  notesPath: string;
  reusedAnalysis: boolean;
  sceneCount: number;
  keyframeCount: number;
}

interface ArtifactManifest {
  schemaVersion: "reference-launch-artifact/v1";
  sourceHash: string;
  sourcePath: string;
  generatedAt: string;
  sampleIntervalSeconds: number;
  sceneThreshold: number;
  minSceneLengthSeconds: number;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function toTimestamp(totalSeconds: number): string {
  const safeSeconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(2).padStart(5, "0")}`;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp.${process.pid}.${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await rename(tempPath, path);
}

async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf-8")) as T;
}

async function hashFile(path: string): Promise<string> {
  const buffer = await readFile(path);
  return createHash("sha256").update(buffer).digest("hex");
}

export async function resolveLaunchVideoPaths(
  cwd: string,
  inputPath: string,
  outputRoot?: string,
): Promise<{ paths: LaunchVideoPaths; sourceHash: string }> {
  const absoluteInputPath = resolve(inputPath);
  const sourceHash = await hashFile(absoluteInputPath);
  const outputBase = outputRoot
    ? resolve(cwd, outputRoot)
    : resolve(cwd, "artifacts", "reference-launch-videos");
  const artifactRoot = join(
    outputBase,
    `${slugify(absoluteInputPath.split("/").pop() ?? "reference-video")}-${sourceHash.slice(0, 12)}`,
  );

  return {
    sourceHash,
    paths: {
      artifactRoot,
      analysisDir: join(artifactRoot, "analysis"),
      framesDir: join(artifactRoot, "frames"),
      keyframesDir: join(artifactRoot, "keyframes"),
      audioDir: join(artifactRoot, "audio"),
      transcriptDir: join(artifactRoot, "transcript"),
      notesDir: join(artifactRoot, "notes"),
      blueprintsDir: join(artifactRoot, "blueprints"),
      builderDir: join(artifactRoot, "builder"),
      manifestPath: join(artifactRoot, "manifest.json"),
      rawAnalysisPath: join(artifactRoot, "analysis", "raw-analysis.json"),
      scenesPath: join(artifactRoot, "analysis", "scenes.json"),
      summaryPath: join(artifactRoot, "analysis", "summary.json"),
      transcriptPath: join(artifactRoot, "transcript", "transcript.json"),
      blueprintPath: join(artifactRoot, "blueprints", "launch-style-blueprint.json"),
      builderPath: join(artifactRoot, "builder", "builder-scaffold.json"),
      notesPath: join(artifactRoot, "notes", "launch-style-notes.md"),
    },
  };
}

async function ensureArtifactDirs(paths: LaunchVideoPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.analysisDir, { recursive: true }),
    mkdir(paths.framesDir, { recursive: true }),
    mkdir(paths.keyframesDir, { recursive: true }),
    mkdir(paths.audioDir, { recursive: true }),
    mkdir(paths.transcriptDir, { recursive: true }),
    mkdir(paths.notesDir, { recursive: true }),
    mkdir(paths.blueprintsDir, { recursive: true }),
    mkdir(paths.builderDir, { recursive: true }),
  ]);
}

function getAnalyzerScriptPath(): string {
  return fileURLToPath(new URL("../assets/reference-video-analyzer.swift", import.meta.url));
}

async function runSwiftAnalyzer(
  inputPath: string,
  paths: LaunchVideoPaths,
  sampleIntervalSeconds: number,
  force: boolean,
): Promise<ExecResult> {
  if (process.platform !== "darwin") {
    throw new Error("The launch-video MVP analyzer currently supports macOS only.");
  }

  const args = [
    getAnalyzerScriptPath(),
    "--input",
    inputPath,
    "--frames-dir",
    paths.framesDir,
    "--audio-dir",
    paths.audioDir,
    "--output-json",
    paths.rawAnalysisPath,
    "--sample-interval",
    String(sampleIntervalSeconds),
  ];

  if (force) {
    args.push("--force");
  }

  return exec("swift", args);
}

async function maybeReuseRawAnalysis(
  paths: LaunchVideoPaths,
  sourceHash: string,
  sampleIntervalSeconds: number,
): Promise<boolean> {
  if (!(await fileExists(paths.manifestPath)) || !(await fileExists(paths.rawAnalysisPath))) {
    return false;
  }

  const manifest = await readJsonFile<ArtifactManifest>(paths.manifestPath);
  return (
    manifest.sourceHash === sourceHash && manifest.sampleIntervalSeconds === sampleIntervalSeconds
  );
}

export function deriveScenes(
  frames: SampledFrame[],
  durationSeconds: number,
  sceneThreshold: number,
  minSceneLengthSeconds: number,
): ReferenceScene[] {
  if (frames.length === 0) {
    return [];
  }

  const startIndexes = [0];

  for (let index = 1; index < frames.length; index += 1) {
    const frame = frames[index];
    const lastStart = frames[startIndexes[startIndexes.length - 1]];
    const secondsSinceLastStart = frame.timeSeconds - lastStart.timeSeconds;
    const diff = frame.meanPixelDifferenceFromPrevious;

    if (diff >= sceneThreshold && secondsSinceLastStart >= minSceneLengthSeconds) {
      startIndexes.push(index);
    }
  }

  return startIndexes.map((startIndex, sceneIndex) => {
    const frame = frames[startIndex];
    const nextStartFrame =
      startIndexes[sceneIndex + 1] !== undefined ? frames[startIndexes[sceneIndex + 1]] : null;
    const endSeconds = nextStartFrame ? nextStartFrame.timeSeconds : durationSeconds;
    const sceneFrames = frames.filter((candidate) => {
      const isAfterStart = candidate.timeSeconds >= frame.timeSeconds;
      const isBeforeEnd = candidate.timeSeconds < endSeconds || nextStartFrame === null;
      return isAfterStart && isBeforeEnd;
    });
    const averageMotionDelta = average(
      sceneFrames.map((candidate) => candidate.meanPixelDifferenceFromPrevious),
    );

    let trigger: ReferenceScene["trigger"] = "detected-cut";
    if (sceneIndex === 0) {
      trigger = "opening";
    } else if (sceneIndex === startIndexes.length - 1) {
      trigger = "closing";
    }

    return {
      index: sceneIndex,
      startSeconds: frame.timeSeconds,
      endSeconds,
      durationSeconds: Number((endSeconds - frame.timeSeconds).toFixed(2)),
      startTimestamp: toTimestamp(frame.timeSeconds),
      endTimestamp: toTimestamp(endSeconds),
      keyframeRelativePath: join(
        "keyframes",
        `scene-${String(sceneIndex + 1).padStart(2, "0")}.jpg`,
      ),
      sampleFrameRelativePath: frame.relativePath,
      confidence:
        frame.meanPixelDifferenceFromPrevious >= sceneThreshold * 1.25 ? "high" : "medium",
      trigger,
      cue: `${trigger === "opening" ? "opening setup" : "visual cadence shift"} around ${frame.averageColorHex}`,
      dominantColorHex: frame.averageColorHex,
      averageMotionDelta: Number(averageMotionDelta.toFixed(2)),
    };
  });
}

async function persistKeyframes(
  scenes: ReferenceScene[],
  paths: LaunchVideoPaths,
  force: boolean,
): Promise<void> {
  if (force) {
    await rm(paths.keyframesDir, { recursive: true, force: true });
    await mkdir(paths.keyframesDir, { recursive: true });
  }

  for (const scene of scenes) {
    const sourcePath = join(paths.artifactRoot, scene.sampleFrameRelativePath);
    const targetPath = join(paths.artifactRoot, scene.keyframeRelativePath);
    if (!force && (await fileExists(targetPath))) {
      continue;
    }
    await copyFile(sourcePath, targetPath);
  }
}

function buildLaunchStyleMapping(
  rawAnalysis: RawReferenceAnalysis,
  scenes: ReferenceScene[],
): LaunchStyleMapping {
  const averageSceneLength = average(scenes.map((scene) => scene.durationSeconds));
  const pacing: LaunchStyleMapping["pacing"] =
    averageSceneLength <= 4
      ? "rapid-cadence"
      : averageSceneLength <= 8
        ? "steady-escalation"
        : "measured-build";

  const archetype: LaunchStyleMapping["archetype"] =
    rawAnalysis.hasAudioTrack && scenes.length >= 8
      ? "founder-voiceover-reveal"
      : scenes.length >= 8
        ? "demo-drop"
        : rawAnalysis.durationSeconds >= 45
          ? "hook-proof-payoff"
          : "social-proof-sprint";

  return {
    family: "launch-style",
    archetype,
    pacing,
    rationale: [
      `Reference runs ${rawAnalysis.durationSeconds.toFixed(1)}s with ${scenes.length} detected scenes.`,
      `Average scene length is ${averageSceneLength.toFixed(1)}s, which suggests ${pacing.replace("-", " ")} pacing.`,
      rawAnalysis.hasAudioTrack
        ? "Audio track exists, so the family is prepared for VO-led assembly later."
        : "No audio track was detected, so the builder should bias toward text-led pacing.",
    ],
    editorialSignals: [
      "lead with a tight hook frame from the first scene",
      "carry proof beats through scene changes instead of rebuilding from scratch",
      "reserve the final scene for payoff or CTA framing",
    ],
  };
}

function editorialRoleForScene(
  order: number,
  total: number,
): "hook" | "problem" | "proof" | "payoff" | "cta" {
  if (order === 0) return "hook";
  if (order === total - 1) return "cta";
  if (order === total - 2) return "payoff";
  if (order === 1) return "problem";
  return "proof";
}

export function buildLaunchBlueprint(
  rawAnalysis: RawReferenceAnalysis,
  scenes: ReferenceScene[],
  sourceHash: string,
  paths: LaunchVideoPaths,
): LaunchBlueprint {
  const mapping = buildLaunchStyleMapping(rawAnalysis, scenes);

  return {
    schemaVersion: "launch-video-blueprint/v1",
    source: {
      artifactRoot: paths.artifactRoot,
      inputPath: rawAnalysis.inputPath,
      sourceHash,
      durationSeconds: rawAnalysis.durationSeconds,
      dimensions: {
        width: rawAnalysis.width,
        height: rawAnalysis.height,
      },
    },
    family: "launch-style",
    style: {
      mappedArchetype: mapping.archetype,
      pacing: mapping.pacing,
      tone: ["credible", "aspirational", "product-led"],
      rationale: mapping.rationale,
    },
    scenes: scenes.map((scene, order) => ({
      sceneId: `scene-${String(order + 1).padStart(2, "0")}`,
      order: order + 1,
      sourceSceneIndex: scene.index,
      startSeconds: scene.startSeconds,
      endSeconds: scene.endSeconds,
      durationSeconds: scene.durationSeconds,
      keyframeRelativePath: scene.keyframeRelativePath,
      intent:
        editorialRoleForScene(order, scenes.length) === "hook"
          ? "Establish the opening visual promise fast."
          : editorialRoleForScene(order, scenes.length) === "cta"
            ? "Land the offer and close with a direct action."
            : "Advance the launch narrative with a concrete proof beat.",
      visualNotes: [
        `Dominant color cue ${scene.dominantColorHex}.`,
        `Average sampled motion delta ${scene.averageMotionDelta.toFixed(1)}.`,
        `Detected from ${scene.trigger} transition at ${scene.startTimestamp}.`,
      ],
      editorialRole: editorialRoleForScene(order, scenes.length),
      motionProfile:
        scene.averageMotionDelta >= 18 ? "high" : scene.averageMotionDelta >= 10 ? "medium" : "low",
      emotion: {
        primary: order === 0 ? "curiosity" : order >= scenes.length - 2 ? "confidence" : "momentum",
        secondary: order >= scenes.length - 2 ? "urgency" : "focus",
        confidence: "placeholder",
      },
      performance: {
        delivery:
          rawAnalysis.hasAudioTrack && order <= 1
            ? "voiceover or presenter bridge likely fits this beat"
            : "support with supers, motion, or b-roll overlays",
        shotDirection:
          "match the reference composition first, then replace with product assets later",
        placeholder: true,
      },
    })),
    audio: {
      sourceAudioRelativePath: rawAnalysis.audioRelativePath,
      transcriptRelativePath: join("transcript", "transcript.json"),
      strategy: rawAnalysis.hasAudioTrack
        ? "Use extracted audio as the transcript source for the next iteration."
        : "Build text-first and add VO later.",
      notes: [
        "Transcript file is persisted even if speech-to-text is not wired yet.",
        "Keep timing anchored to source scene boundaries when replacing narration.",
      ],
    },
    editorial: {
      beatStructure: ["hook", "problem", "proof", "payoff", "cta"],
      cutPattern: `${mapping.pacing} with scene-first reuse from the reference artifact set`,
      transitions: [
        "hard cuts",
        "speed ramps if asset motion supports it",
        "title-card punctuation",
      ],
      placeholders: ["headline copy", "proof stat", "customer quote", "final CTA line"],
    },
    performance: {
      presenterMode: rawAnalysis.hasAudioTrack ? "voiceover-ready" : "caption-led",
      captureNeeds: ["product UI footage", "brand text system", "logo lockup"],
    },
    emotion: {
      intendedArc: ["curiosity", "clarity", "belief", "urgency"],
      notes: [
        "Current emotion/performance fields are placeholders for later judge/build loops.",
        "Use the detected scene cadence as the timing backbone before refining tone.",
      ],
    },
  };
}

export function buildBuilderScaffold(
  blueprint: LaunchBlueprint,
  paths: LaunchVideoPaths,
): BuilderScaffold {
  return {
    schemaVersion: "launch-video-builder-scaffold/v1",
    blueprintRelativePath: join("blueprints", "launch-style-blueprint.json"),
    sourceArtifactRoot: paths.artifactRoot,
    renderFamily: "launch-style",
    renderStatus: "pending-assets",
    builderInputs: {
      keyframesDir: join(paths.artifactRoot, "keyframes"),
      transcriptPath: join(paths.artifactRoot, "transcript", "transcript.json"),
      notesPath: join(paths.artifactRoot, "notes", "launch-style-notes.md"),
    },
    unresolved: [
      "Replace placeholder transcript segments with speech-to-text output or manual script.",
      "Supply product assets, logos, and any required brand guardrails.",
      "Choose the final render stack for the builder loop.",
    ],
    placeholders: {
      brandName: "TBD",
      product: "TBD",
      coreClaim: blueprint.style.rationale[0] ?? "TBD",
      cta: "TBD",
      assetPack: ["logo", "ui-captures", "headline-copy", "social-proof"],
    },
  };
}

function buildSummary(
  rawAnalysis: RawReferenceAnalysis,
  scenes: ReferenceScene[],
  blueprint: LaunchBlueprint,
): Record<string, unknown> {
  return {
    schemaVersion: "reference-analysis-summary/v1",
    generatedAt: new Date().toISOString(),
    durationSeconds: rawAnalysis.durationSeconds,
    frameCount: rawAnalysis.frames.length,
    sceneCount: scenes.length,
    launchFamily: blueprint.family,
    mappedArchetype: blueprint.style.mappedArchetype,
    pacing: blueprint.style.pacing,
    reusableOutputs: [
      "analysis/raw-analysis.json",
      "analysis/scenes.json",
      "analysis/summary.json",
      "blueprints/launch-style-blueprint.json",
      "builder/builder-scaffold.json",
      "transcript/transcript.json",
      "notes/launch-style-notes.md",
    ],
  };
}

function buildTranscriptPlaceholder(rawAnalysis: RawReferenceAnalysis): TranscriptPlaceholder {
  return {
    schemaVersion: "reference-transcript/v1",
    status: "audio_extracted_pending_transcription",
    sourceAudioRelativePath: rawAnalysis.audioRelativePath,
    generatedAt: new Date().toISOString(),
    tool: null,
    language: null,
    segments: [],
    notes: [
      rawAnalysis.hasAudioTrack
        ? "Audio has been extracted and persisted. Run speech-to-text in a later loop against the saved audio file."
        : "No audio track was detected in the reference asset.",
      "This placeholder exists so future judge/build loops can update transcript data without reprocessing video scenes or keyframes.",
    ],
  };
}

function buildNotesMarkdown(
  rawAnalysis: RawReferenceAnalysis,
  scenes: ReferenceScene[],
  blueprint: LaunchBlueprint,
): string {
  const sceneLines = scenes
    .map(
      (scene) =>
        `- Scene ${scene.index + 1}: ${scene.startTimestamp} -> ${scene.endTimestamp} | ${scene.durationSeconds.toFixed(2)}s | ${scene.cue}`,
    )
    .join("\n");

  return `# Launch Video MVP Notes

## Reference

- Input: \`${rawAnalysis.inputPath}\`
- Duration: ${rawAnalysis.durationSeconds.toFixed(2)}s
- Resolution: ${rawAnalysis.width}x${rawAnalysis.height}
- Sample interval: ${rawAnalysis.sampleIntervalSeconds}s
- Detected scenes: ${scenes.length}
- Launch family: ${blueprint.family}
- Mapped archetype: ${blueprint.style.mappedArchetype}

## Scene Breakdown

${sceneLines}

## Reuse Contract

- Reuse \`analysis/raw-analysis.json\` for stable sampled-frame metadata.
- Reuse \`analysis/scenes.json\` and \`keyframes/\` for blueprint edits.
- Reuse \`audio/\` and \`transcript/transcript.json\` for future speech-to-text loops.
- Update \`blueprints/launch-style-blueprint.json\` instead of re-deriving editorial structure from scratch.

## Next Manual Inputs

- Product assets and brand system
- Approved headline / CTA copy
- Speech-to-text output or manual transcript
- Final render implementation choice
`;
}

export async function ingestLaunchVideoReference(
  options: LaunchVideoIngestOptions,
): Promise<LaunchVideoIngestResult> {
  const sampleIntervalSeconds = options.sampleIntervalSeconds ?? 2;
  const sceneThreshold = options.sceneThreshold ?? 18;
  const minSceneLengthSeconds = options.minSceneLengthSeconds ?? 4;
  const absoluteInputPath = resolve(options.inputPath);
  const { paths, sourceHash } = await resolveLaunchVideoPaths(
    options.cwd,
    absoluteInputPath,
    options.outputRoot,
  );

  await ensureArtifactDirs(paths);

  const reusedAnalysis =
    options.force === true
      ? false
      : await maybeReuseRawAnalysis(paths, sourceHash, sampleIntervalSeconds);

  if (!reusedAnalysis) {
    await runSwiftAnalyzer(absoluteInputPath, paths, sampleIntervalSeconds, options.force === true);
  }

  const rawAnalysis = await readJsonFile<RawReferenceAnalysis>(paths.rawAnalysisPath);
  const scenes = deriveScenes(
    rawAnalysis.frames,
    rawAnalysis.durationSeconds,
    sceneThreshold,
    minSceneLengthSeconds,
  );
  await persistKeyframes(scenes, paths, options.force === true);

  const blueprint = buildLaunchBlueprint(rawAnalysis, scenes, sourceHash, paths);
  const builderScaffold = buildBuilderScaffold(blueprint, paths);
  const transcript = buildTranscriptPlaceholder(rawAnalysis);
  const summary = buildSummary(rawAnalysis, scenes, blueprint);
  const notes = buildNotesMarkdown(rawAnalysis, scenes, blueprint);

  const manifest: ArtifactManifest = {
    schemaVersion: "reference-launch-artifact/v1",
    sourceHash,
    sourcePath: absoluteInputPath,
    generatedAt: new Date().toISOString(),
    sampleIntervalSeconds,
    sceneThreshold,
    minSceneLengthSeconds,
  };

  await Promise.all([
    writeJsonAtomic(paths.manifestPath, manifest),
    writeJsonAtomic(paths.scenesPath, scenes),
    writeJsonAtomic(paths.summaryPath, summary),
    writeJsonAtomic(paths.transcriptPath, transcript),
    writeJsonAtomic(paths.blueprintPath, blueprint),
    writeJsonAtomic(paths.builderPath, builderScaffold),
    writeFile(paths.notesPath, notes, "utf-8"),
  ]);

  return {
    artifactRoot: paths.artifactRoot,
    blueprintPath: paths.blueprintPath,
    builderPath: paths.builderPath,
    transcriptPath: paths.transcriptPath,
    scenesPath: paths.scenesPath,
    notesPath: paths.notesPath,
    reusedAnalysis,
    sceneCount: scenes.length,
    keyframeCount: scenes.length,
  };
}
