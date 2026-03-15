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

export function SessionSprite({ entity, isSelected = false, onSelect }: SessionSpriteProps) {
  const tokens = ATTENTION_TOKENS[entity.attentionLevel];

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
      <div className="relative flex w-[108px] flex-col items-center gap-1.5">
        <div
          className={`absolute left-1/2 top-[32px] h-4 w-12 -translate-x-1/2 rounded-full border ${tokens.ring}`}
          aria-hidden="true"
        />
        <div
          className={`absolute left-1/2 top-[-8px] h-2 w-2 -translate-x-1/2 rounded-full ${tokens.body}`}
          aria-hidden="true"
        />
        <div
          className={`relative flex h-9 w-9 items-end justify-center rounded-[12px] border bg-[rgba(15,23,42,0.84)] ${tokens.aura} ${
            isSelected
              ? "border-[rgba(191,219,254,0.9)] ring-2 ring-[rgba(96,165,250,0.65)]"
              : "border-[rgba(255,255,255,0.12)]"
          }`}
        >
          <div className={`mb-1 h-[18px] w-[18px] ${tokens.bodyClass} ${tokens.body}`} aria-hidden="true" />
        </div>
        <div className="w-full text-center">
          <div className={`truncate text-[10px] font-semibold leading-4 ${tokens.accent}`}>{entity.label}</div>
          <div className="truncate text-[9px] leading-4 text-[rgba(148,163,184,0.82)]">
            {entity.branch ?? entity.summary}
          </div>
          <div
            className={`mt-0.5 inline-flex rounded-full border px-1.5 py-0.5 text-[7px] font-bold uppercase tracking-[0.16em] ${tokens.chip}`}
          >
            {entity.isArchived ? "archived" : tokens.chipLabel}
          </div>
        </div>
      </div>
    </button>
  );
}
