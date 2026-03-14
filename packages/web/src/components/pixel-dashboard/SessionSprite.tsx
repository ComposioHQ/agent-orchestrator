import type { SceneEntity } from "./scene-model";

interface SessionSpriteProps {
  entity: SceneEntity;
}

const ATTENTION_TOKENS: Record<
  SceneEntity["attentionLevel"],
  {
    aura: string;
    ring: string;
    body: string;
    accent: string;
  }
> = {
  merge: {
    aura: "shadow-[0_0_36px_rgba(52,211,153,0.4)]",
    ring: "border-[rgba(74,222,128,0.5)] bg-[rgba(22,101,52,0.18)]",
    body: "bg-[linear-gradient(180deg,#86efac,#22c55e)]",
    accent: "text-[rgba(187,247,208,0.92)]",
  },
  respond: {
    aura: "shadow-[0_0_36px_rgba(251,146,60,0.44)]",
    ring: "border-[rgba(251,146,60,0.5)] bg-[rgba(124,45,18,0.18)]",
    body: "bg-[linear-gradient(180deg,#fdba74,#f97316)]",
    accent: "text-[rgba(254,215,170,0.92)]",
  },
  review: {
    aura: "shadow-[0_0_34px_rgba(248,113,113,0.42)]",
    ring: "border-[rgba(248,113,113,0.5)] bg-[rgba(127,29,29,0.16)]",
    body: "bg-[linear-gradient(180deg,#fca5a5,#ef4444)]",
    accent: "text-[rgba(254,202,202,0.92)]",
  },
  pending: {
    aura: "shadow-[0_0_30px_rgba(250,204,21,0.32)]",
    ring: "border-[rgba(250,204,21,0.42)] bg-[rgba(113,63,18,0.16)]",
    body: "bg-[linear-gradient(180deg,#fde68a,#eab308)]",
    accent: "text-[rgba(254,240,138,0.92)]",
  },
  working: {
    aura: "shadow-[0_0_28px_rgba(96,165,250,0.3)]",
    ring: "border-[rgba(96,165,250,0.38)] bg-[rgba(30,41,59,0.26)]",
    body: "bg-[linear-gradient(180deg,#93c5fd,#3b82f6)]",
    accent: "text-[rgba(191,219,254,0.92)]",
  },
  done: {
    aura: "shadow-[0_0_20px_rgba(148,163,184,0.18)]",
    ring: "border-[rgba(148,163,184,0.28)] bg-[rgba(15,23,42,0.28)]",
    body: "bg-[linear-gradient(180deg,#cbd5e1,#64748b)]",
    accent: "text-[rgba(226,232,240,0.78)]",
  },
};

export function SessionSprite({ entity }: SessionSpriteProps) {
  const tokens = ATTENTION_TOKENS[entity.attentionLevel];

  return (
    <div
      className="absolute"
      data-attention-level={entity.attentionLevel}
      data-archived={entity.isArchived ? "true" : "false"}
      data-testid={`session-sprite-${entity.sessionId}`}
      style={{
        left: entity.position.x,
        top: entity.position.y,
        transform: "translate(-50%, -50%)",
      }}
    >
      <div className="relative flex flex-col items-center gap-2">
        <div
          className={`absolute left-1/2 top-[34px] h-5 w-14 -translate-x-1/2 rounded-full border ${tokens.ring}`}
          aria-hidden="true"
        />
        <div
          className={`relative flex h-10 w-10 items-end justify-center rounded-[14px] border border-[rgba(255,255,255,0.12)] bg-[rgba(15,23,42,0.84)] ${tokens.aura}`}
        >
          <div className={`mb-1 h-5 w-5 rounded-[7px] ${tokens.body}`} aria-hidden="true" />
        </div>
        <div className="max-w-[122px] text-center">
          <div className={`truncate text-[11px] font-semibold ${tokens.accent}`}>{entity.label}</div>
          <div className="truncate text-[10px] text-[rgba(148,163,184,0.82)]">
            {entity.branch ?? entity.summary}
          </div>
        </div>
      </div>
    </div>
  );
}
