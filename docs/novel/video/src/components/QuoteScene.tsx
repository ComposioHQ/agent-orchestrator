import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { WordReveal } from "./WordReveal.js";

interface QuoteSceneProps {
  text: string;
  secondary?: string;
  variant: "highlight" | "body" | "code" | "end";
}

const VARIANTS = {
  highlight: {
    fontSize: 68,
    color: "#d4a853",
    fontFamily: "'IM Fell English', 'Georgia', serif",
    fontStyle: "italic" as const,
    fontWeight: 400,
    framesPerWord: 8,
    fadeFrames: 18,
  },
  body: {
    fontSize: 46,
    color: "#e0dbd4",
    fontFamily: "'IM Fell English', 'Georgia', serif",
    fontStyle: "normal" as const,
    fontWeight: 400,
    framesPerWord: 5,
    fadeFrames: 14,
  },
  code: {
    fontSize: 52,
    color: "#4ade80",
    fontFamily: "'Courier New', 'Courier', monospace",
    fontStyle: "normal" as const,
    fontWeight: 700,
    framesPerWord: 8,
    fadeFrames: 18,
  },
  end: {
    fontSize: 58,
    color: "#f0ede6",
    fontFamily: "'IM Fell English', 'Georgia', serif",
    fontStyle: "italic" as const,
    fontWeight: 400,
    framesPerWord: 9,
    fadeFrames: 20,
  },
};

export const QuoteScene: React.FC<QuoteSceneProps> = ({
  text,
  secondary,
  variant,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const config = VARIANTS[variant];

  const fadeOutStart = durationInFrames - 35;
  const containerOpacity = interpolate(
    frame,
    [0, 20, fadeOutStart, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const secondaryOpacity = interpolate(
    frame,
    [60, 80, fadeOutStart, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Decorative opening quote mark
  const quoteMarkOpacity = interpolate(
    frame,
    [10, 30],
    [0, 1],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const showQuoteMark = variant === "highlight" || variant === "end";

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 32,
        opacity: containerOpacity,
      }}
    >
      {showQuoteMark && (
        <div
          style={{
            fontFamily: "'IM Fell English', Georgia, serif",
            fontSize: 120,
            color: "#c9963a",
            opacity: quoteMarkOpacity * 0.4,
            lineHeight: 0.6,
            userSelect: "none",
            marginBottom: -20,
          }}
        >
          "
        </div>
      )}

      <WordReveal
        text={text}
        color={config.color}
        fontSize={config.fontSize}
        fontFamily={config.fontFamily}
        fontStyle={config.fontStyle}
        fontWeight={config.fontWeight}
        framesPerWord={config.framesPerWord}
        fadeFrames={config.fadeFrames}
        startDelay={10}
      />

      {secondary && (
        <div
          style={{
            fontFamily: "'IM Fell English', 'Georgia', serif",
            fontSize: 26,
            fontStyle: "italic",
            color: "#706860",
            opacity: secondaryOpacity,
            textAlign: "center",
            letterSpacing: "0.04em",
            marginTop: 8,
          }}
        >
          {secondary}
        </div>
      )}
    </AbsoluteFill>
  );
};
