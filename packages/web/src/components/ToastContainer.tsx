"use client";

import type { Toast } from "@/hooks/useToast";

interface ToastContainerProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[var(--z-toast)] flex flex-col gap-2 max-sm:left-4 max-sm:right-4"
      aria-live="assertive"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="alert"
          className="flex items-center gap-3 border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-4 py-3 shadow-[var(--box-shadow-lg)] motion-safe:animate-[modal-slide-up_0.18s_ease-out]"
          style={{
            borderRadius: "2px",
            borderLeftWidth: 3,
            borderLeftColor:
              toast.type === "error"
                ? "var(--color-status-error)"
                : "var(--color-status-ready)",
          }}
        >
          <span className="flex-1 text-[13px] text-[var(--color-text-primary)]">
            {toast.message}
          </span>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            className="shrink-0 text-[var(--color-text-tertiary)] transition-colors hover:text-[var(--color-text-secondary)]"
            aria-label="Dismiss notification"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
