"use client";

import { useState, useCallback, createContext, useContext, useRef, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { AlertTriangle } from "lucide-react";

type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
};

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(async () => false);

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { open: boolean }) | null>(null);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setState({ ...options, open: true });
    });
  }, []);

  const handleClose = (result: boolean) => {
    setState((prev) => prev ? { ...prev, open: false } : null);
    setTimeout(() => {
      resolveRef.current?.(result);
      resolveRef.current = null;
    }, 150);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <DialogPrimitive.Root open={state?.open ?? false} onOpenChange={(o) => { if (!o) handleClose(false); }}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="dialog-overlay data-[state=open]:animate-overlay-in data-[state=closed]:animate-overlay-out" />
          <DialogPrimitive.Content
            className="fixed left-1/2 top-1/2 z-[200] w-[min(400px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-[var(--card)] text-[var(--foreground)] shadow-xl data-[state=open]:animate-modal-in data-[state=closed]:animate-modal-out motion-reduce:animate-none"
          >
            <div className="p-5">
              <div className="flex items-start gap-3">
                {state?.destructive ? (
                  <div className="grid size-8 shrink-0 place-items-center rounded-full bg-[var(--destructive)]/10">
                    <AlertTriangle className="size-4 text-[var(--destructive)]" aria-hidden="true" />
                  </div>
                ) : null}
                <div className="min-w-0 flex-1">
                  <DialogPrimitive.Title className="text-sm font-semibold">
                    {state?.title}
                  </DialogPrimitive.Title>
                  {state?.description ? (
                    <DialogPrimitive.Description className="mt-1.5 text-xs leading-5 text-[var(--muted-foreground)]">
                      {state.description}
                    </DialogPrimitive.Description>
                  ) : (
                    <DialogPrimitive.Description className="sr-only">
                      {state?.title}
                    </DialogPrimitive.Description>
                  )}
                </div>
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  type="button"
                  className="h-8 cursor-pointer rounded-md px-3 text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                  onClick={() => handleClose(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={`h-8 cursor-pointer rounded-md px-4 text-xs font-semibold ${
                    state?.destructive
                      ? "bg-[var(--destructive)] text-white hover:bg-[var(--destructive)]/90"
                      : "bg-[var(--color-accent-strong)] text-[var(--color-accent-foreground)]"
                  }`}
                  onClick={() => handleClose(true)}
                >
                  {state?.confirmLabel ?? "Confirm"}
                </button>
              </div>
            </div>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </ConfirmContext.Provider>
  );
}
