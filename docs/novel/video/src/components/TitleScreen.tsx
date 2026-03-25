import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

interface TitleScreenProps {
  title: string;
  subtitle?: string;
}

export const TitleScreen: React.FC<TitleScreenProps> = ({ title, subtitle }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const fadeInDuration = 40;
  const holdStart = 60;
  const fadeOutStart = durationInFrames - 50;

  const titleOpacity = interpolate(
    frame,
    [0, fadeInDuration, holdStart, fadeOutStart, durationInFrames],
    [0, 1, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const subtitleOpacity = interpolate(
    frame,
    [holdStart, holdStart + 40, fadeOutStart, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const titleScale = interpolate(
    frame,
    [0, fadeInDuration],
    [1.08, 1.0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const lineWidth = interpolate(
    frame,
    [holdStart + 10, holdStart + 50],
    [0, 600],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 32,
      }}
    >
      <div
        style={{
          fontFamily: "'Cinzel', 'Trajan Pro', 'Times New Roman', serif",
          fontSize: 96,
          fontWeight: 700,
          letterSpacing: "0.18em",
          color: "#ffffff",
          opacity: titleOpacity,
          transform: `scale(${titleScale})`,
          textTransform: "uppercase",
          textShadow: "0 0 60px rgba(255,255,255,0.15)",
        }}
      >
        {title}
      </div>

      <div
        style={{
          width: lineWidth,
          height: 1,
          background: "linear-gradient(90deg, transparent, #c9963a, transparent)",
        }}
      />

      {subtitle && (
        <div
          style={{
            fontFamily: "'IM Fell English', 'Georgia', serif",
            fontSize: 26,
            fontStyle: "italic",
            letterSpacing: "0.06em",
            color: "#a0998e",
            opacity: subtitleOpacity,
            textAlign: "center",
            maxWidth: 900,
            lineHeight: 1.6,
          }}
        >
          {subtitle}
        </div>
      )}
    </AbsoluteFill>
  );
};
