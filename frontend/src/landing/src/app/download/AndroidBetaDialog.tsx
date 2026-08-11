"use client";

import { ANDROID_TESTER_GROUP_URL } from "@ao/shared/constants";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { X } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useCallback, useEffect, useState } from "react";
import { FaAndroid } from "react-icons/fa";
import { AndroidBetaInstructions } from "./AndroidBetaInstructions";

export const ANDROID_BETA_TRIGGER_CLASS =
  "inline-flex min-h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-3xl bg-foreground px-3 py-2 text-sm font-semibold tracking-[-0.5px] text-background transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none sm:px-6 sm:py-3 sm:text-base";
export const ANDROID_BETA_TRIGGER_LABEL = "Join Android Beta";

export function AndroidBetaDialog() {
  const [open, setOpen] = useState(false);
  const shouldReduceMotion = useReducedMotion();
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open, close]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={ANDROID_BETA_TRIGGER_CLASS}
      >
        <FaAndroid className="size-4 shrink-0" aria-hidden="true" />
        {ANDROID_BETA_TRIGGER_LABEL}
      </button>

      <AnimatePresence>
        {open ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.button
              type="button"
              tabIndex={-1}
              aria-label="Close"
              onClick={close}
              initial={shouldReduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: shouldReduceMotion ? 0 : 0.18 }}
              className="absolute inset-0 cursor-default bg-black/70 backdrop-blur-sm outline-none"
            />

            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="android-beta-dialog-title"
              initial={
                shouldReduceMotion
                  ? false
                  : { opacity: 0, y: 12, scale: 0.98 }
              }
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }}
              transition={
                shouldReduceMotion
                  ? { duration: 0 }
                  : { type: "spring", duration: 0.34, bounce: 0.12 }
              }
              className="relative max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-card p-6 shadow-[0_32px_80px_-24px_rgba(0,0,0,0.8)] sm:p-7"
            >
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                autoFocus
                className="absolute right-2 top-2 grid size-10 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              >
                <X className="size-4" aria-hidden="true" />
              </button>

              <h2
                id="android-beta-dialog-title"
                className="pr-8 text-xl font-semibold text-foreground"
              >
                Get AO Mobile on Android
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Three steps, about a minute. The closed beta is free.
              </p>

              <div className="mt-6">
                <AndroidBetaInstructions />
              </div>

              <div className="mt-6 flex flex-col items-center rounded-xl border border-border bg-background/40 p-4">
                <p className="text-sm font-semibold text-foreground">
                  Continue on your Android phone
                </p>
                <p className="mt-1 text-center text-xs leading-5 text-muted-foreground">
                  Scan to join the Google tester group on your phone.
                </p>
                <div className="mt-3 rounded-xl bg-white p-3">
                  <QRCodeSVG
                    value={ANDROID_TESTER_GROUP_URL}
                    size={148}
                    className="block"
                  />
                </div>
              </div>
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
