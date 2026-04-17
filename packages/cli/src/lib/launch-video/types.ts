export const BLUEPRINT_SCHEMA_VERSION = "blueprint-schema-v1" as const;
export const LAUNCH_FAMILY_SPEC_VERSION = "launch-family-spec-v1" as const;
export const JUDGE_SCHEMA_VERSION = "judge-v1" as const;
export type JudgeSchemaVersion = "judge-v1" | "judge-v2";

export type LaunchFamilyRole = "hook" | "before" | "after" | "value-beats" | "outro";
export type AnalysisStatus = "complete" | "partial";

export interface ArtifactPaths {
  rootDir: string;
  referenceDir: string;
  analysisDir: string;
  blueprintsDir: string;
  judgeDir: string;
  rendersDir: string;
  keyframesDir: string;
}

export interface ReferenceMetadata {
  originalPath: string;
  fileName: string;
  artifactKey: string;
  fingerprint: string;
  fileSizeBytes: number;
  modifiedAt: string;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  aspectRatio: string | null;
  nominalFrameRate: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasAudio: boolean;
  keyframeCount: number;
  analyzedAt: string;
  cacheStatus: "generated" | "reused";
  extraction: {
    ffmpegAvailable: boolean;
    ffprobeAvailable: boolean;
    swiftAvailable: boolean;
    whisperAvailable: boolean;
    sceneDetection: "heuristic-duration-slices";
    transcription: "visual-ocr-fallback" | "stub-missing-dependency" | "whisper";
    keyframeExtractor: "ffmpeg" | "swift-avfoundation" | "none";
  };
}

export interface AnalysisScene {
  id: string;
  role: LaunchFamilyRole;
  beatIndex: number | null;
  label: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  keyframePath: string | null;
  detectedText: string[];
  copyIntent: string;
  editorialPurpose: string;
  assetSignals: {
    used: string[];
    needed: string[];
    confidence: "observed" | "inferred" | "missing";
  };
  motionDirectives: string[];
  transition: string;
  palette: string[];
  typographyHints: string[];
  energyScore: number;
  analysisStatus: AnalysisStatus;
  evidence: string[];
  notes: string[];
  detectionMethod: "heuristic-duration-slices";
}

export interface TranscriptSegment {
  id: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
  source: "speech" | "ocr";
  confidence: number;
  partial: boolean;
}

export interface TranscriptOutput {
  status: "available" | "partial" | "stub";
  provider: "whisper" | "visual-ocr-fallback" | "none";
  language: string | null;
  summary: string;
  segments: TranscriptSegment[];
  caveats: string[];
}

export interface AudioEvent {
  id: string;
  type: "music-bed" | "transition-hit" | "emphasis-rise" | "cta-hit" | "voiceover-window";
  startSeconds: number;
  endSeconds: number;
  inferred: boolean;
  confidence: number;
  sceneId: string | null;
  evidence: string[];
  notes: string;
}

export interface StyleAnalysis {
  summary: string;
  launchFamilyFit: string;
  format: {
    aspectRatio: string | null;
    resolution: string | null;
    durationBucket: "short" | "medium" | "long";
  };
  palette: {
    dominant: string[];
    accent: string[];
    backgroundBias: string[];
  };
  typography: {
    observedTextLines: string[];
    casing: string;
    density: "low" | "medium" | "high";
  };
  composition: string[];
  notes: string[];
  analysisStatus: AnalysisStatus;
}

export interface MotionAnalysis {
  summary: string;
  pace: "slow" | "medium" | "fast";
  cameraEnergy: "low" | "medium" | "high";
  transitionProfile: Array<{
    fromSceneId: string;
    toSceneId: string;
    differenceScore: number;
    interpretation: string;
  }>;
  notes: string[];
  analysisStatus: AnalysisStatus;
}

export interface EditorialAnalysis {
  summary: string;
  structure: Array<{
    role: LaunchFamilyRole;
    purpose: string;
    sceneId: string;
  }>;
  pacingNotes: string[];
  openingObservation: string;
  closingObservation: string;
  notes: string[];
  analysisStatus: AnalysisStatus;
}

export interface BlueprintScene {
  id: string;
  role: LaunchFamilyRole;
  beatIndex: number | null;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  referenceSceneId: string;
  referenceEvidence: string[];
  sourceKeyframePath: string | null;
  detectedText: string[];
  copyIntent: string;
  editorialPurpose: string;
  assetsUsed: string[];
  assetsNeeded: string[];
  motionDirectives: string[];
  transition: string;
  palette: string[];
  typographyHints: string[];
  outputIntent: string;
}

export interface LaunchVideoBlueprintV1 {
  version: typeof BLUEPRINT_SCHEMA_VERSION;
  project: {
    name: string;
    slug: string;
    generatedAt: string;
    artifactRoot: string;
  };
  reference: {
    originalPath: string;
    artifactKey: string;
    durationSeconds: number | null;
    dimensions: {
      width: number | null;
      height: number | null;
      aspectRatio: string | null;
    };
    analysisPaths: string[];
  };
  assets: {
    used: string[];
    needed: string[];
    available: string[];
    stagingPath: string;
  };
  style: {
    northStar: string;
    palette: string[];
    typography: string[];
    guardrails: string[];
    referenceNotes: string[];
  };
  audio: {
    voiceoverStatus: "pending" | "partial" | "ready";
    transcriptPath: string;
    soundtrackDirection: string[];
    eventsPath: string;
  };
  performance: {
    targetDurationSeconds: number | null;
    hookTargetSeconds: number;
    pacingStrategy: string;
    primaryCTA: string;
    successCriteria: string[];
  };
  editorial: {
    familySpecVersion: typeof LAUNCH_FAMILY_SPEC_VERSION;
    arcSummary: string;
    pacingNotes: string[];
    notes: string[];
  };
  scenes: BlueprintScene[];
  judge: {
    status: "pending" | "reviewed";
    judgePath: string;
    thresholds: {
      structure: number;
      timing: number;
      typography: number;
      palette: number;
      motion: number;
      emotional_tone: number;
    };
  };
}

export interface JudgeOutput {
  version: JudgeSchemaVersion;
  generatedAt: string;
  artifactRoot: string;
  summary: string;
  scores: {
    structure: number;
    timing: number;
    typography: number;
    palette: number;
    motion: number;
    emotional_tone: number;
  };
  top_fixes: string[];
  revision_notes: string[];
  approved: boolean;
}
