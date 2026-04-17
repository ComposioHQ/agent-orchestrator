import React from "react";
import {
  AbsoluteFill,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { LaunchVideoRenderInput, RenderSceneInput } from "./render-types.js";

const ROLE_COLORS: Record<string, string> = {
  hook: "#EF4444",
  before: "#F59E0B",
  after: "#22C55E",
  "value-beats": "#6366F1",
  outro: "#A855F7",
};

const SceneOverlay: React.FC<{ scene: RenderSceneInput }> = ({ scene }) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();

  const fadeIn = interpolate(frame, [0, 8], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const totalFrames = Math.max(1, Math.round(scene.durationSeconds * fps));
  const fadeOut = interpolate(frame, [totalFrames - 8, totalFrames], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const opacity = Math.min(fadeIn, fadeOut);

  const pillIn = spring({
    frame,
    fps,
    config: { damping: 200, stiffness: 170 },
  });
  const pillY = interpolate(pillIn, [0, 1], [20, 0]);

  const roleColor = ROLE_COLORS[scene.role] ?? "#64748B";
  const headline = scene.detectedText[0] ?? scene.copyIntent;

  return (
    <AbsoluteFill style={{ opacity }}>
      {/* Bottom gradient for text legibility */}
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(180deg, transparent 60%, rgba(0,0,0,0.6) 85%, rgba(0,0,0,0.85) 100%)",
        }}
      />

      {/* Role pill + timing */}
      <div
        style={{
          position: "absolute",
          bottom: 64,
          left: 28,
          display: "flex",
          gap: 10,
          alignItems: "center",
          transform: `translateY(${pillY}px)`,
        }}
      >
        <span
          style={{
            borderRadius: 999,
            padding: "6px 14px",
            background: roleColor,
            color: "white",
            fontSize: 14,
            fontWeight: 700,
            fontFamily: "Helvetica Neue, Arial, sans-serif",
            letterSpacing: 0.8,
            textTransform: "uppercase",
          }}
        >
          {scene.role}
        </span>
        <span
          style={{
            borderRadius: 999,
            padding: "5px 12px",
            background: "rgba(0, 0, 0, 0.6)",
            backdropFilter: "blur(8px)",
            color: "rgba(255,255,255,0.9)",
            fontSize: 13,
            fontWeight: 500,
            fontFamily: "Helvetica Neue, Arial, sans-serif",
          }}
        >
          {scene.startSeconds.toFixed(1)}s – {scene.endSeconds.toFixed(1)}s
        </span>
      </div>

      {/* Headline text */}
      <div
        style={{
          position: "absolute",
          bottom: 24,
          left: 28,
          right: 28,
          color: "white",
          fontFamily: "Helvetica Neue, Arial, sans-serif",
          fontSize: 18,
          fontWeight: 500,
          lineHeight: 1.3,
          opacity: 0.92,
          textShadow: "0 1px 6px rgba(0,0,0,0.8)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {headline}
      </div>
    </AbsoluteFill>
  );
};

export const LaunchVideoPreviewComposition: React.FC<LaunchVideoRenderInput> = ({
  referenceVideoPath,
  scenes,
  keyframeScenes,
}) => {
  const { fps, width, height } = useVideoConfig();

  // Primary mode: play the actual reference video with editorial overlays
  if (referenceVideoPath) {
    const videoSrc = staticFile(referenceVideoPath);
    return (
      <AbsoluteFill style={{ backgroundColor: "#000" }}>
        {/* Full-duration reference video playback */}
        <OffthreadVideo
          src={videoSrc}
          muted
          style={{ width, height, objectFit: "cover" }}
        />

        {/* Editorial scene overlays */}
        {scenes.map((scene) => {
          const from = Math.round(scene.startSeconds * fps);
          const durationInFrames = Math.max(1, Math.round(scene.durationSeconds * fps));
          return (
            <Sequence key={scene.id} from={from} durationInFrames={durationInFrames}>
              <SceneOverlay scene={scene} />
            </Sequence>
          );
        })}
      </AbsoluteFill>
    );
  }

  // Fallback: per-second keyframe slideshow
  if (keyframeScenes && keyframeScenes.length > 0) {
    return (
      <AbsoluteFill style={{ backgroundColor: "#020617" }}>
        {keyframeScenes.map((scene) => {
          const from = Math.round(scene.startSeconds * fps);
          const durationInFrames = Math.max(1, Math.round(scene.durationSeconds * fps));
          return (
            <Sequence key={scene.id} from={from} durationInFrames={durationInFrames}>
              <AbsoluteFill style={{ overflow: "hidden" }}>
                <Img
                  src={scene.keyframeDataUrl}
                  style={{ width, height, objectFit: "cover" }}
                />
                {scene.role ? (
                  <div
                    style={{
                      position: "absolute",
                      bottom: 20,
                      left: 20,
                      borderRadius: 999,
                      padding: "5px 12px",
                      background: ROLE_COLORS[scene.role] ?? "rgba(100,116,139,0.85)",
                      color: "white",
                      fontSize: 13,
                      fontWeight: 600,
                      fontFamily: "Helvetica Neue, Arial, sans-serif",
                      textTransform: "uppercase",
                    }}
                  >
                    {scene.role}
                  </div>
                ) : null}
              </AbsoluteFill>
            </Sequence>
          );
        })}
      </AbsoluteFill>
    );
  }

  // Last fallback: old scene-card rendering
  return (
    <AbsoluteFill style={{ backgroundColor: "#020617" }}>
      {scenes.map((scene) => {
        const from = Math.round(scene.startSeconds * fps);
        const durationInFrames = Math.max(1, Math.round(scene.durationSeconds * fps));
        return (
          <Sequence key={scene.id} from={from} durationInFrames={durationInFrames}>
            <AbsoluteFill
              style={{
                background: `linear-gradient(135deg, ${scene.palette[0] ?? "#101828"} 0%, ${scene.palette[1] ?? "#4f46e5"} 100%)`,
                color: "white",
                fontFamily: "Helvetica Neue, Arial, sans-serif",
                justifyContent: "center",
                alignItems: "center",
                fontSize: 32,
                fontWeight: 700,
              }}
            >
              {scene.detectedText[0] ?? scene.copyIntent}
            </AbsoluteFill>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
