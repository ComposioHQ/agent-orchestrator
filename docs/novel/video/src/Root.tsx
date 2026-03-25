import React from "react";
import { Composition } from "remotion";
import { TheAwakening } from "./TheAwakening.js";
import { TOTAL_FRAMES } from "./scenes.js";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="TheAwakening"
      component={TheAwakening}
      durationInFrames={TOTAL_FRAMES}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};
