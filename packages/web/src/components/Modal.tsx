"use client";

import { useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  size?: "sm" | "md" | "lg";
  children: ReactNode;
  footer?: ReactNode;
}

const SIZE_MAP = { sm: 440, md: 560, lg: 680 } as const;
const FOCUSABLE =
  'a[href], button:not(:disabled), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function Modal({ open, onClose, title, size = "md", children, footer }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement;
      panelRef.current?.focus();
    } else if (previousFocusRef.current instanceof HTMLElement) {
      previousFocusRef.current.focus();
      previousFocusRef.current = null;
    }
  }, [open]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key === "Tab" && panelRef.current) {
        const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [onClose],
  );

  if (!open) return null;

  if (typeof document === "undefined") return null;

  const maxWidth = SIZE_MAP[size];

  return createPortal(
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={handleKeyDown}
    >
      {/* Overlay */}
      <button
        type="button"
        className="absolute inset-0 bg-[rgba(5,8,14,0.6)] motion-safe:transition-opacity motion-safe:duration-[0.25s]"
        onClick={onClose}
        aria-label="Close modal"
        tabIndex={-1}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className="relative z-[1] flex max-h-[85vh] w-full flex-col border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] shadow-[0_24px_70px_rgba(0,0,0,0.24)] motion-safe:animate-[modal-slide-up_0.25s_ease-out]"
        style={{
          maxWidth,
          borderRadius: "var(--radius-lg)",
          boxShadow: "var(--card-inset), 0 24px 70px rgba(0,0,0,0.24)",
        }}
        tabIndex={-1}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] px-5 py-4">
          <h2 className="text-[17px] font-semibold text-[var(--color-text-primary)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-md text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-bg-elevated-hover)] hover:text-[var(--color-text-secondary)]"
            style={{ minWidth: 44, minHeight: 44, padding: "4px" }}
            aria-label="Close"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>

        {/* Footer */}
        {footer ? (
          <div className="border-t border-[var(--color-border-subtle)] px-5 py-4">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
