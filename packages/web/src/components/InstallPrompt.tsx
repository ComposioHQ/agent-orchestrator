"use client";

import { useState, useEffect, useRef } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function InstallPrompt() {
  const [visible, setVisible] = useState(false);
  const deferredPromptRef = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      deferredPromptRef.current = e as BeforeInstallPromptEvent;
      setVisible(true);
    };

    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const handleInstall = async () => {
    const prompt = deferredPromptRef.current;
    if (!prompt) return;

    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    if (outcome === "accepted") {
      setVisible(false);
    }
    deferredPromptRef.current = null;
  };

  const handleDismiss = () => {
    setVisible(false);
    deferredPromptRef.current = null;
  };

  if (!visible) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-md animate-[slide-up_0.3s_ease-out] rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] px-4 py-3 shadow-lg md:left-auto md:right-6 md:mx-0 md:max-w-sm">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <p className="text-[13px] font-semibold text-[var(--color-text-primary)]">
            Install App
          </p>
          <p className="mt-0.5 text-[11px] text-[var(--color-text-secondary)]">
            Add AO to your home screen for quick access.
          </p>
        </div>
        <button
          onClick={handleInstall}
          className="min-h-[44px] shrink-0 rounded-md bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-[var(--color-text-inverse)] transition-opacity hover:opacity-90"
        >
          Install
        </button>
        <button
          onClick={handleDismiss}
          className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-primary)]"
          aria-label="Dismiss"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
