import React from "react";
import {
  AbsoluteFill,
  Sequence,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import {
  CONTRIBUTORS,
  CARD_FRAMES,
  INTRO_FRAMES,
  OUTRO_FRAMES,
} from "./pantheon-data.js";
import { ContributorCard } from "./components/ContributorCard.js";

// ── Shared background ─────────────────────────────────────────────────────────

const Background: React.FC = () => (
  <AbsoluteFill style={{ background: "#080808" }}>
    <div
      style={{
        position: "absolute",
        inset: 0,
        background:
          "radial-gradient(ellipse at 50% 50%, transparent 35%, rgba(0,0,0,0.75) 100%)",
        pointerEvents: "none",
      }}
    />
    <svg
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        opacity: 0.035,
        pointerEvents: "none",
      }}
    >
      <filter id="pantheon-grain">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.7"
          numOctaves="3"
          stitchTiles="stitch"
        />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#pantheon-grain)" />
    </svg>
  </AbsoluteFill>
);

// ── Font loader ───────────────────────────────────────────────────────────────

const FontLoader: React.FC = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700&family=IM+Fell+English:ital@0;1&display=swap');
  `}</style>
);

// ── Opening title ─────────────────────────────────────────────────────────────

const PantheonTitle: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const fadeOutStart = durationInFrames - 40;

  const titleOpacity = interpolate(
    frame,
    [0, 40, fadeOutStart, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const titleScale = interpolate(frame, [0, 40], [1.06, 1.0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const subtitleOpacity = interpolate(
    frame,
    [60, 90, fadeOutStart, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const lineWidth = interpolate(frame, [50, 100], [0, 700], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const counterOpacity = interpolate(
    frame,
    [90, 120, fadeOutStart, durationInFrames],
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
        gap: 0,
      }}
    >
      <div
        style={{
          fontFamily: "'Cinzel', 'Trajan Pro', serif",
          fontSize: 104,
          fontWeight: 700,
          letterSpacing: "0.22em",
          color: "#ffffff",
          opacity: titleOpacity,
          transform: `scale(${titleScale})`,
          textTransform: "uppercase",
          textShadow: "0 0 80px rgba(201,150,58,0.2)",
          marginBottom: 32,
        }}
      >
        THE PANTHEON
      </div>

      <div
        style={{
          width: lineWidth,
          height: 1,
          background:
            "linear-gradient(90deg, transparent, #c9963a 30%, #c9963a 70%, transparent)",
          marginBottom: 32,
        }}
      />

      <div
        style={{
          fontFamily: "'IM Fell English', Georgia, serif",
          fontSize: 28,
          fontStyle: "italic",
          color: "#a0998e",
          opacity: subtitleOpacity,
          letterSpacing: "0.06em",
          marginBottom: 20,
        }}
      >
        The gods who built us
      </div>

      <div
        style={{
          fontFamily: "'Courier New', Courier, monospace",
          fontSize: 18,
          letterSpacing: "0.2em",
          color: "#4ade80",
          opacity: counterOpacity,
          textTransform: "uppercase",
        }}
      >
        {CONTRIBUTORS.length} Contributors
      </div>
    </AbsoluteFill>
  );
};

// ── Closing card ──────────────────────────────────────────────────────────────

const PantheonOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const opacity = interpolate(
    frame,
    [0, 30, durationInFrames - 20, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );

  const lineOpacity = interpolate(frame, [20, 50], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 24,
      }}
    >
      <div
        style={{
          fontFamily: "'IM Fell English', Georgia, serif",
          fontSize: 42,
          fontStyle: "italic",
          color: "#f0ede6",
          opacity,
          textAlign: "center",
          letterSpacing: "0.04em",
        }}
      >
        The Pantheon grows.
      </div>

      <div
        style={{
          width: 60,
          height: 1,
          background: "#c9963a",
          opacity: lineOpacity,
        }}
      />

      <div
        style={{
          fontFamily: "'IM Fell English', Georgia, serif",
          fontSize: 22,
          fontStyle: "italic",
          color: "#60605a",
          opacity: opacity * 0.8,
          textAlign: "center",
          letterSpacing: "0.04em",
        }}
      >
        New gods arrive, carrying one fix, one feature, one map.
      </div>
    </AbsoluteFill>
  );
};

// ── Main composition ──────────────────────────────────────────────────────────

export const ThePantheon: React.FC = () => {
  return (
    <AbsoluteFill>
      <FontLoader />
      <Background />

      {/* Opening title */}
      <Sequence from={0} durationInFrames={INTRO_FRAMES} name="intro">
        <PantheonTitle />
      </Sequence>

      {/* One card per contributor */}
      {CONTRIBUTORS.map((contributor, i) => (
        <Sequence
          key={contributor.name}
          from={INTRO_FRAMES + i * CARD_FRAMES}
          durationInFrames={CARD_FRAMES}
          name={contributor.name}
        >
          <ContributorCard contributor={contributor} index={i} />
        </Sequence>
      ))}

      {/* Closing */}
      <Sequence
        from={INTRO_FRAMES + CONTRIBUTORS.length * CARD_FRAMES}
        durationInFrames={OUTRO_FRAMES}
        name="outro"
      >
        <PantheonOutro />
      </Sequence>
    </AbsoluteFill>
  );
};
