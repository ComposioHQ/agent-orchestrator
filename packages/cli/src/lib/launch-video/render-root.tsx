import React from "react";
import { Composition, getInputProps, registerRoot } from "remotion";
import { LaunchVideoPreviewComposition } from "./render-composition.js";
import type { LaunchVideoRenderInput } from "./render-types.js";

const defaultProps: LaunchVideoRenderInput = {
  blueprint: {
    version: "blueprint-schema-v1",
    project: {
      name: "Launch Video MVP",
      slug: "launch-video-mvp",
      generatedAt: new Date(0).toISOString(),
      artifactRoot: "",
    },
    reference: {
      originalPath: "",
      artifactKey: "",
      durationSeconds: 10,
      dimensions: { width: 640, height: 360, aspectRatio: "1.78:1" },
      analysisPaths: [],
    },
    assets: { used: [], needed: [], available: [], stagingPath: "" },
    style: { northStar: "", palette: [], typography: [], guardrails: [], referenceNotes: [] },
    audio: { voiceoverStatus: "pending", transcriptPath: "", soundtrackDirection: [], eventsPath: "" },
    performance: {
      targetDurationSeconds: 10,
      hookTargetSeconds: 3,
      pacingStrategy: "",
      primaryCTA: "",
      successCriteria: [],
    },
    editorial: { familySpecVersion: "launch-family-spec-v1", arcSummary: "", pacingNotes: [], notes: [] },
    scenes: [],
    judge: {
      status: "pending",
      judgePath: "",
      thresholds: {
        structure: 7,
        timing: 7,
        typography: 7,
        palette: 7,
        motion: 7,
        emotional_tone: 7,
      },
    },
  },
  scenes: [],
  keyframeScenes: [],
  referenceVideoPath: null,
  fps: 30,
  width: 640,
  height: 360,
  durationInFrames: 300,
  placeholderAssetsUsed: [],
};

const RemotionRoot: React.FC = () => {
  const inputProps = getInputProps() as Partial<LaunchVideoRenderInput>;
  const fps = inputProps.fps ?? defaultProps.fps;
  const width = inputProps.width ?? defaultProps.width;
  const height = inputProps.height ?? defaultProps.height;
  const durationInFrames = inputProps.durationInFrames ?? defaultProps.durationInFrames;

  return (
    <Composition
      id="LaunchVideoPreview"
      component={LaunchVideoPreviewComposition as React.ComponentType<Record<string, unknown>>}
      fps={fps}
      width={width}
      height={height}
      durationInFrames={durationInFrames}
      defaultProps={{ ...defaultProps, ...inputProps }}
    />
  );
};

registerRoot(RemotionRoot);
