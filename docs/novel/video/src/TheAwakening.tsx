import React from "react";
import { AbsoluteFill, Sequence } from "remotion";
import { SCENES } from "./scenes.js";
import { TitleScreen } from "./components/TitleScreen.js";
import { ChapterTitle } from "./components/ChapterTitle.js";
import { QuoteScene } from "./components/QuoteScene.js";

const Background: React.FC = () => (
  <AbsoluteFill
    style={{
      background: "#0a0a0a",
    }}
  >
    {/* Subtle vignette */}
    <div
      style={{
        position: "absolute",
        inset: 0,
        background:
          "radial-gradient(ellipse at 50% 50%, transparent 40%, rgba(0,0,0,0.65) 100%)",
        pointerEvents: "none",
      }}
    />
    {/* Very faint grain overlay */}
    <svg
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        opacity: 0.04,
        pointerEvents: "none",
      }}
    >
      <filter id="grain">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.65"
          numOctaves="3"
          stitchTiles="stitch"
        />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#grain)" />
    </svg>
  </AbsoluteFill>
);

// Google Fonts loader — injected once into the document head
const FontLoader: React.FC = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700&family=IM+Fell+English:ital@0;1&display=swap');
  `}</style>
);

export const TheAwakening: React.FC = () => {
  return (
    <AbsoluteFill>
      <FontLoader />
      <Background />

      {SCENES.map((scene, i) => {
        const inner = (() => {
          switch (scene.kind) {
            case "film-title":
              return (
                <TitleScreen title={scene.primary} subtitle={scene.secondary} />
              );
            case "chapter":
              return (
                <ChapterTitle
                  chapter={scene.primary}
                  subtitle={scene.secondary}
                />
              );
            case "quote-highlight":
              return (
                <QuoteScene
                  text={scene.primary}
                  secondary={scene.secondary}
                  variant="highlight"
                />
              );
            case "quote-body":
              return (
                <QuoteScene
                  text={scene.primary}
                  secondary={scene.secondary}
                  variant="body"
                />
              );
            case "quote-code":
              return (
                <QuoteScene
                  text={scene.primary}
                  secondary={scene.secondary}
                  variant="code"
                />
              );
            case "end":
              return (
                <QuoteScene
                  text={scene.primary}
                  secondary={scene.secondary}
                  variant="end"
                />
              );
          }
        })();

        return (
          <Sequence
            key={i}
            from={scene.from}
            durationInFrames={scene.duration}
            name={scene.kind}
          >
            {inner}
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
