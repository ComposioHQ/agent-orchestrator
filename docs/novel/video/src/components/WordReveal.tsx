import React from "react";
import { interpolate, useCurrentFrame } from "remotion";

interface WordRevealProps {
  text: string;
  color?: string;
  fontSize?: number;
  fontFamily?: string;
  fontStyle?: string;
  fontWeight?: string | number;
  lineHeight?: number;
  letterSpacing?: string;
  wordSpacing?: number;
  textAlign?: React.CSSProperties["textAlign"];
  framesPerWord?: number;
  fadeFrames?: number;
  startDelay?: number;
}

export const WordReveal: React.FC<WordRevealProps> = ({
  text,
  color = "#f0ede6",
  fontSize = 48,
  fontFamily = "'IM Fell English', 'Georgia', serif",
  fontStyle = "normal",
  fontWeight = 400,
  lineHeight = 1.5,
  letterSpacing = "0.02em",
  textAlign = "center",
  framesPerWord = 6,
  fadeFrames = 14,
  startDelay = 0,
}) => {
  const frame = useCurrentFrame();

  const lines = text.split("\n");
  let wordIndex = 0;

  return (
    <div
      style={{
        fontFamily,
        fontSize,
        fontStyle,
        fontWeight,
        lineHeight,
        letterSpacing,
        textAlign,
        color,
        maxWidth: "1400px",
        margin: "0 auto",
        padding: "0 80px",
      }}
    >
      {lines.map((line, lineIdx) => {
        const words = line.split(" ");
        return (
          <div
            key={lineIdx}
            style={{ marginBottom: lineIdx < lines.length - 1 ? "0.4em" : 0 }}
          >
            {words.map((word, wIdx) => {
              const idx = wordIndex++;
              const wordStart = startDelay + idx * framesPerWord;
              const opacity = interpolate(
                frame,
                [wordStart, wordStart + fadeFrames],
                [0, 1],
                { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
              );
              const translateY = interpolate(
                frame,
                [wordStart, wordStart + fadeFrames],
                [12, 0],
                { extrapolateLeft: "clamp", extrapolateRight: "clamp" }
              );
              return (
                <span
                  key={wIdx}
                  style={{
                    display: "inline-block",
                    opacity,
                    transform: `translateY(${translateY}px)`,
                    marginRight: "0.3em",
                  }}
                >
                  {word}
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};
