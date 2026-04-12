"use client";

import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import {
  CheckIcon,
  SelectChevronIcon,
} from "./UnifiedSidebarIcons";

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);

  const show = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setCoords({ top: rect.bottom + 6, left: rect.left + rect.width / 2 });
    setVisible(true);
  }, []);

  const hide = useCallback(() => setVisible(false), []);

  return (
    <div ref={triggerRef} onPointerEnter={show} onPointerLeave={hide}>
      {children}
      {visible && coords
        ? createPortal(
            <span
              className="pointer-events-none fixed z-[9999] -translate-x-1/2 whitespace-nowrap rounded-[var(--radius-sm)] border border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-2 py-1 font-[family-name:var(--font-sans)] text-[11px] font-medium text-[var(--color-text-primary)] shadow-[0_4px_12px_rgba(0,0,0,0.15)]"
              style={{ top: coords.top, left: coords.left }}
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </div>
  );
}

export function SidebarIconButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onClick?.();
        }}
        aria-label={label}
        className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-[var(--radius-sm)] border border-transparent transition-all duration-100 hover:border-[var(--color-border-default)] hover:bg-[var(--color-bg-elevated-hover)] hover:text-[var(--color-text-secondary)]"
      >
        {children}
      </button>
    </Tooltip>
  );
}

export function PopoverField({
  label,
  valueLabel,
  onToggle,
  isOpen,
  onClose,
  children,
}: {
  label: string;
  valueLabel: string;
  onToggle: () => void;
  isOpen: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const fieldRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent | PointerEvent) {
      if (!fieldRef.current?.contains(event.target as Node)) {
        onClose();
      }
    }

    if (!isOpen) return;
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen, onClose]);

  return (
    <div ref={fieldRef} className="relative grid grid-cols-[60px_minmax(0,1fr)] items-center gap-2">
      <label className="font-[family-name:var(--font-mono)] text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--color-text-tertiary)]">
        {label}
      </label>
      <button
        type="button"
        onClick={onToggle}
        className="flex h-[32px] min-w-0 w-full items-center justify-between rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-[var(--color-bg-base)] px-3 text-left text-[12px] font-medium tracking-[-0.011em] text-[var(--color-text-primary)] transition-colors duration-100 hover:border-[var(--color-border-strong)]"
      >
        <span className="min-w-0 flex-1 truncate">{valueLabel}</span>
        <span className="ml-2 shrink-0 text-[var(--color-text-tertiary)]">
          <SelectChevronIcon />
        </span>
      </button>
      {isOpen ? (
        <div className="absolute right-0 top-[36px] z-30 min-w-[200px] rounded-[var(--radius-lg)] border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] p-1.5 shadow-[var(--box-shadow-lg,0_18px_44px_rgba(0,0,0,0.22))]">
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function PopoverOption({
  label,
  selected,
  onSelect,
  swatch,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  swatch?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-3 py-2 text-left text-[13px] tracking-[-0.011em] transition-colors duration-100",
        selected
          ? "bg-[var(--color-accent-subtle)] text-[var(--color-text-primary)]"
          : "text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated-hover)] hover:text-[var(--color-text-primary)]",
      )}
    >
      {swatch !== undefined ? (
        <span
          className="h-3 w-3 shrink-0 rounded-[2px]"
          style={{
            background: swatch,
            border: swatch === "transparent" ? "1px solid var(--color-border-default)" : "none",
          }}
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {selected ? <CheckIcon /> : null}
    </button>
  );
}

export function SidebarMenuButton({
  icon,
  label,
  onClick,
}: {
  icon?: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-3 py-2 text-left text-[13px] tracking-[-0.011em] text-[var(--color-text-primary)] transition-colors duration-100 hover:bg-[var(--color-bg-elevated-hover)]"
    >
      {icon ? <span className="shrink-0 text-[var(--color-text-tertiary)]">{icon}</span> : null}
      {label}
    </button>
  );
}
