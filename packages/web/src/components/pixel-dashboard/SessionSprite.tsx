import type { CSSProperties } from "react";
import type { SceneEntity } from "./scene-model";

interface SessionSpriteProps {
  entity: SceneEntity;
  isSelected?: boolean;
  onSelect?: (sessionId: string) => void;
}

const ATTENTION_TOKENS: Record<
  SceneEntity["attentionLevel"],
  {
    bodyClass: string;
    aura: string;
    chip: string;
    chipLabel: string;
    ring: string;
    body: string;
    accent: string;
  }
> = {
  merge: {
    bodyClass: "rounded-[4px]",
    aura: "shadow-[0_0_36px_rgba(52,211,153,0.4)]",
    chip: "border-[rgba(74,222,128,0.42)] bg-[rgba(20,83,45,0.26)] text-[rgba(187,247,208,0.96)]",
    chipLabel: "merge",
    ring: "border-[rgba(74,222,128,0.5)] bg-[rgba(22,101,52,0.18)]",
    body: "bg-[linear-gradient(180deg,#86efac,#22c55e)]",
    accent: "text-[rgba(187,247,208,0.92)]",
  },
  respond: {
    bodyClass: "rounded-[10px]",
    aura: "shadow-[0_0_36px_rgba(251,146,60,0.44)]",
    chip: "border-[rgba(251,146,60,0.42)] bg-[rgba(124,45,18,0.24)] text-[rgba(254,215,170,0.96)]",
    chipLabel: "reply",
    ring: "border-[rgba(251,146,60,0.5)] bg-[rgba(124,45,18,0.18)]",
    body: "bg-[linear-gradient(180deg,#fdba74,#f97316)]",
    accent: "text-[rgba(254,215,170,0.92)]",
  },
  review: {
    bodyClass: "rounded-[2px]",
    aura: "shadow-[0_0_34px_rgba(248,113,113,0.42)]",
    chip: "border-[rgba(248,113,113,0.42)] bg-[rgba(127,29,29,0.22)] text-[rgba(254,202,202,0.96)]",
    chipLabel: "review",
    ring: "border-[rgba(248,113,113,0.5)] bg-[rgba(127,29,29,0.16)]",
    body: "bg-[linear-gradient(180deg,#fca5a5,#ef4444)]",
    accent: "text-[rgba(254,202,202,0.92)]",
  },
  pending: {
    bodyClass: "rounded-[999px]",
    aura: "shadow-[0_0_30px_rgba(250,204,21,0.32)]",
    chip: "border-[rgba(250,204,21,0.4)] bg-[rgba(113,63,18,0.22)] text-[rgba(254,240,138,0.96)]",
    chipLabel: "wait",
    ring: "border-[rgba(250,204,21,0.42)] bg-[rgba(113,63,18,0.16)]",
    body: "bg-[linear-gradient(180deg,#fde68a,#eab308)]",
    accent: "text-[rgba(254,240,138,0.92)]",
  },
  working: {
    bodyClass: "rounded-[7px]",
    aura: "shadow-[0_0_28px_rgba(96,165,250,0.3)]",
    chip: "border-[rgba(96,165,250,0.36)] bg-[rgba(30,41,59,0.24)] text-[rgba(191,219,254,0.96)]",
    chipLabel: "working",
    ring: "border-[rgba(96,165,250,0.38)] bg-[rgba(30,41,59,0.26)]",
    body: "bg-[linear-gradient(180deg,#93c5fd,#3b82f6)]",
    accent: "text-[rgba(191,219,254,0.92)]",
  },
  done: {
    bodyClass: "rounded-[999px] opacity-80",
    aura: "shadow-[0_0_20px_rgba(148,163,184,0.18)]",
    chip: "border-[rgba(148,163,184,0.28)] bg-[rgba(15,23,42,0.28)] text-[rgba(226,232,240,0.8)]",
    chipLabel: "done",
    ring: "border-[rgba(148,163,184,0.28)] bg-[rgba(15,23,42,0.28)]",
    body: "bg-[linear-gradient(180deg,#cbd5e1,#64748b)]",
    accent: "text-[rgba(226,232,240,0.78)]",
  },
};

const ATTENTION_MOTION: Record<
  SceneEntity["attentionLevel"],
  {
    direction: "down" | "up" | "right" | "left";
    frameCount: number;
    frameOffset: number;
    motion: "walk" | "typing" | "reading" | "idle";
  }
> = {
  merge: {
    direction: "up",
    frameCount: 3,
    frameOffset: 0,
    motion: "walk",
  },
  respond: {
    direction: "right",
    frameCount: 2,
    frameOffset: 3,
    motion: "typing",
  },
  review: {
    direction: "left",
    frameCount: 2,
    frameOffset: 5,
    motion: "reading",
  },
  pending: {
    direction: "down",
    frameCount: 1,
    frameOffset: 5,
    motion: "idle",
  },
  working: {
    direction: "right",
    frameCount: 2,
    frameOffset: 3,
    motion: "typing",
  },
  done: {
    direction: "left",
    frameCount: 1,
    frameOffset: 5,
    motion: "idle",
  },
};

export function SessionSprite({ entity, isSelected = false, onSelect }: SessionSpriteProps) {
  const tokens = ATTENTION_TOKENS[entity.attentionLevel];
  const motion = ATTENTION_MOTION[entity.attentionLevel];
  const spriteIndex = hashString(entity.sessionId) % 6;
  const spritePath = `/pixel-agents/assets/characters/char_${spriteIndex}.png`;
  const spriteRow =
    motion.direction === "down" ? 0 : motion.direction === "up" ? 1 : 2;
  const animationClass =
    motion.motion === "walk"
      ? "pixel-agent-sprite--walk"
      : motion.motion === "typing"
        ? "pixel-agent-sprite--typing"
        : motion.motion === "reading"
          ? "pixel-agent-sprite--reading"
          : "";
  const spriteStyle = {
    "--pixel-agent-frame-count": String(motion.frameCount),
    "--pixel-agent-frame-offset": String(motion.frameOffset),
    "--pixel-agent-mirror": motion.direction === "left" ? "-1" : "1",
    "--pixel-agent-opacity": entity.isArchived ? "0.72" : "1",
    "--pixel-agent-row": String(spriteRow),
    "--pixel-agent-sheet": `url(${spritePath})`,
  } as CSSProperties;

  return (
    <button
      type="button"
      className="absolute"
      aria-label={`${entity.label} ${entity.attentionLevel} session`}
      aria-pressed={isSelected}
      data-attention-level={entity.attentionLevel}
      data-archived={entity.isArchived ? "true" : "false"}
      data-selected={isSelected ? "true" : "false"}
      data-testid={`session-sprite-${entity.sessionId}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect?.(entity.sessionId);
      }}
      onPointerDown={(event) => event.stopPropagation()}
      style={{
        left: entity.position.x,
        top: entity.position.y,
        transform: "translate(-50%, -50%)",
      }}
    >
      <div className="relative flex w-[84px] flex-col items-center gap-1">
        <div
          className={`absolute left-1/2 top-[43px] h-3.5 w-8 -translate-x-1/2 rounded-full border ${tokens.ring}`}
          aria-hidden="true"
        />
        <div
          className={`relative flex h-[62px] w-[44px] items-end justify-center rounded-[16px] border bg-[linear-gradient(180deg,rgba(15,23,42,0.36),rgba(15,23,42,0.1))] ${tokens.aura} ${
            isSelected
              ? "border-[rgba(191,219,254,0.9)] ring-2 ring-[rgba(96,165,250,0.65)]"
              : "border-[rgba(255,255,255,0.08)]"
          }`}
        >
          <div
            className="pointer-events-none absolute inset-x-3 bottom-2 h-7 rounded-full bg-[radial-gradient(circle,rgba(59,130,246,0.22),transparent_72%)] blur-[6px]"
            aria-hidden="true"
          />
          <div
            className={`pixel-agent-sprite ${animationClass} ${entity.isArchived ? "opacity-70 saturate-[0.7]" : ""}`}
            aria-hidden="true"
            style={spriteStyle}
          />
        </div>
        <div className="w-full text-center">
          <div className={`truncate text-[8px] font-semibold leading-3 ${tokens.accent}`}>{entity.label}</div>
          {entity.isArchived ? (
            <div
              className={`mt-0.5 inline-flex max-w-full truncate rounded-full border px-1.5 py-0.5 text-[6px] font-bold uppercase tracking-[0.12em] ${tokens.chip}`}
            >
              archived
            </div>
          ) : null}
        </div>
      </div>
    </button>
  );
}

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}
