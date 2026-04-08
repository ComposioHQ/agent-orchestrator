import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

interface ChapterTitleProps {
  chapter: string;
  subtitle?: string;
}

export const ChapterTitle: React.FC<ChapterTitleProps> = ({ chapter, subtitle }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const fadeIn = 25;
  const fadeOutStart = durationInFrames - 30;

  const opacity = interpolate(
    frame,
    [0, fadeIn, fadeOutStart, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const chapterY = interpolate(
    frame,
    [0, fadeIn],
    [-20, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const subtitleOpacity = interpolate(
    frame,
    [fadeIn, fadeIn + 20, fadeOutStart, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 20,
      }}
    >
      <div
        style={{
          fontFamily: "'Cinzel', 'Trajan Pro', 'Times New Roman', serif",
          fontSize: 22,
          fontWeight: 400,
          letterSpacing: "0.35em",
          color: "#c9963a",
          opacity,
          transform: `translateY(${chapterY}px)`,
          textTransform: "uppercase",
        }}
      >
        {chapter}
      </div>

      {subtitle && (
        <div
          style={{
            fontFamily: "'IM Fell English', 'Georgia', serif",
            fontSize: 64,
            fontStyle: "italic",
            fontWeight: 400,
            letterSpacing: "0.04em",
            color: "#f0ede6",
            opacity: subtitleOpacity,
          }}
        >
          {subtitle}
        </div>
      )}

      <div
        style={{
          width: 60,
          height: 1,
          background: "#c9963a",
          opacity: subtitleOpacity,
          marginTop: 8,
        }}
      />
    </AbsoluteFill>
  );
};
