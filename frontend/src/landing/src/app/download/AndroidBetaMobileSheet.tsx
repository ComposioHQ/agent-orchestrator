"use client";

import {
  ANDROID_TESTER_GROUP_URL,
  ANDROID_TEST_OPT_IN_URL,
} from "@ao/shared/constants";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ExternalLink, X } from "lucide-react";
import { useEffect } from "react";
import { track } from "../../lib/analytics";

const ACTION_CLASS =
  "mt-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-2xl bg-foreground px-4 py-3.5 text-sm font-semibold text-background transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card motion-reduce:transition-none";

interface AndroidBetaMobileSheetProps {
  open: boolean;
  onClose: () => void;
}

export function AndroidBetaMobileSheet({
  open,
  onClose,
}: AndroidBetaMobileSheetProps) {
  const shouldReduceMotion = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previouslyFocused?.focus();
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-end justify-center">
          <motion.button
            type="button"
            tabIndex={-1}
            aria-label="Close"
            onClick={onClose}
            initial={shouldReduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: shouldReduceMotion ? 0 : 0.18 }}
            className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm outline-none"
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="android-beta-sheet-title"
            initial={shouldReduceMotion ? false : { y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={
              shouldReduceMotion
                ? { duration: 0 }
                : { type: "spring", duration: 0.36, bounce: 0.08 }
            }
            className="relative max-h-[90dvh] w-full max-w-md overflow-y-auto rounded-t-2xl border border-border bg-card px-5 pt-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] shadow-[0_-24px_60px_-20px_rgba(0,0,0,0.8)]"
          >
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              autoFocus
              className="absolute right-2 top-2 grid size-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            >
              <X className="size-4" aria-hidden="true" />
            </button>

            <h2
              id="android-beta-sheet-title"
              className="pr-8 text-xl font-semibold text-foreground"
            >
              Get AO on this Android
            </h2>
            <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
              Three quick steps. Use the Google account linked to Google Play.
            </p>

            <ol className="mt-6 space-y-6">
              <li>
                <Step number={1} title="Join the tester group">
                  Join with the same Google account you use in Google Play.
                </Step>
                <a
                  href={ANDROID_TESTER_GROUP_URL}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => track("android_beta_group_clicked")}
                  className={ACTION_CLASS}
                >
                  Join the Google Group
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              </li>

              <li>
                <Step number={2} title="Become a tester">
                  Open the closed-test invite and tap Become a tester.
                </Step>
                <a
                  href={ANDROID_TEST_OPT_IN_URL}
                  target="_blank"
                  rel="noreferrer"
                  onClick={() => track("android_beta_invite_clicked")}
                  className={ACTION_CLASS}
                >
                  Open the testing invite
                  <ExternalLink className="size-3.5" aria-hidden="true" />
                </a>
              </li>

              <li>
                <Step number={3} title="Install AO Mobile">
                  After opting in, tap the Google Play install link on that
                  page.
                </Step>
              </li>
            </ol>

            <div className="mt-6 rounded-xl border border-border bg-background/40 p-4 text-sm leading-6 text-muted-foreground">
              <p>
                Just joined? Google Play access can take up to an hour to
                activate.
              </p>
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span
        aria-hidden="true"
        className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-bold text-background"
      >
        {number}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          {children}
        </p>
      </div>
    </div>
  );
}
