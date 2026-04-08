import React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { Contributor } from "../pantheon-data.js";

interface ContributorCardProps {
  contributor: Contributor;
  index: number;
}

export const ContributorCard: React.FC<ContributorCardProps> = ({
  contributor,
  index,
}) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const fadeOutStart = durationInFrames - 30;

  // ── Ordinal number (very faint, large backdrop) ────────────
  const ordinalOpacity = interpolate(frame, [0, 20], [0, 0.06], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // ── Name ──────────────────────────────────────────────────
  const nameOpacity = interpolate(
    frame,
    [15, 45, fadeOutStart, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const nameY = interpolate(frame, [15, 45], [30, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const nameScale = interpolate(frame, [15, 45], [1.04, 1.0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // ── Gold rule ─────────────────────────────────────────────
  const lineWidth = interpolate(frame, [40, 75], [0, 520], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // ── Title ─────────────────────────────────────────────────
  const titleOpacity = interpolate(
    frame,
    [55, 80, fadeOutStart, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const titleY = interpolate(frame, [55, 80], [16, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // ── Commits ───────────────────────────────────────────────
  const commitsOpacity = interpolate(
    frame,
    [75, 100, fadeOutStart, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // ── Quote — word by word ──────────────────────────────────
  const quoteWords = contributor.quote.split(" ");
  const quoteStartFrame = 105;
  const framesPerWord = 6;
  const quoteFadeFrames = 12;

  const quoteContainerOpacity = interpolate(
    frame,
    [quoteStartFrame, quoteStartFrame + 15, fadeOutStart, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  // Ordinal label (1st, 2nd, …)
  const ordinals = [
    "I",
    "II",
    "III",
    "IV",
    "V",
    "VI",
    "VII",
    "VIII",
    "IX",
    "X",
  ];
  const roman = ordinals[index] ?? String(index + 1);

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 0,
        overflow: "hidden",
      }}
    >
      {/* Roman numeral backdrop */}
      <div
        style={{
          position: "absolute",
          fontSize: 480,
          fontFamily: "'Cinzel', 'Times New Roman', serif",
          fontWeight: 700,
          color: "#c9963a",
          opacity: ordinalOpacity,
          userSelect: "none",
          lineHeight: 1,
          letterSpacing: "0.05em",
          pointerEvents: "none",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
        }}
      >
        {roman}
      </div>

      {/* Main content */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 0,
          zIndex: 1,
          width: "100%",
          padding: "0 120px",
        }}
      >
        {/* Name */}
        <div
          style={{
            fontFamily: "'Cinzel', 'Trajan Pro', 'Times New Roman', serif",
            fontSize: 88,
            fontWeight: 700,
            letterSpacing: "0.12em",
            color: "#ffffff",
            opacity: nameOpacity,
            transform: `translateY(${nameY}px) scale(${nameScale})`,
            textTransform: "uppercase",
            textAlign: "center",
            textShadow: "0 0 80px rgba(255,255,255,0.08)",
            marginBottom: 28,
          }}
        >
          {contributor.name}
        </div>

        {/* Gold rule */}
        <div
          style={{
            width: lineWidth,
            height: 1,
            background:
              "linear-gradient(90deg, transparent, #c9963a 20%, #c9963a 80%, transparent)",
            marginBottom: 24,
          }}
        />

        {/* Title */}
        <div
          style={{
            fontFamily: "'IM Fell English', 'Georgia', serif",
            fontSize: 38,
            fontStyle: "italic",
            fontWeight: 400,
            letterSpacing: "0.05em",
            color: "#c9963a",
            opacity: titleOpacity,
            transform: `translateY(${titleY}px)`,
            textAlign: "center",
            marginBottom: 22,
          }}
        >
          {contributor.title}
        </div>

        {/* Commits */}
        <div
          style={{
            fontFamily: "'Courier New', Courier, monospace",
            fontSize: 22,
            fontWeight: 400,
            letterSpacing: "0.18em",
            color: "#4ade80",
            opacity: commitsOpacity,
            textTransform: "uppercase",
            marginBottom: 56,
          }}
        >
          {contributor.commits} commit{contributor.commits !== 1 ? "s" : ""}
        </div>

        {/* Quote */}
        <div
          style={{
            fontFamily: "'IM Fell English', 'Georgia', serif",
            fontSize: 30,
            fontStyle: "italic",
            color: "#7a8090",
            opacity: quoteContainerOpacity,
            textAlign: "center",
            maxWidth: 900,
            lineHeight: 1.6,
            letterSpacing: "0.02em",
          }}
        >
          {quoteWords.map((word, wi) => {
            const wordStart = quoteStartFrame + wi * framesPerWord;
            const wOpacity = interpolate(
              frame,
              [wordStart, wordStart + quoteFadeFrames],
              [0, 1],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
            );
            const wY = interpolate(
              frame,
              [wordStart, wordStart + quoteFadeFrames],
              [8, 0],
              { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
            );
            return (
              <span
                key={wi}
                style={{
                  display: "inline-block",
                  opacity: wOpacity,
                  transform: `translateY(${wY}px)`,
                  marginRight: "0.28em",
                }}
              >
                {word}
              </span>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};
