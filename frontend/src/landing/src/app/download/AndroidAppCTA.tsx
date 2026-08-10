"use client";

import { useState } from "react";
import { FaAndroid } from "react-icons/fa";
import { track } from "../../lib/analytics";
import { Platform, usePlatform } from "../hooks/useOS";
import {
  ANDROID_BETA_TRIGGER_CLASS,
  ANDROID_BETA_TRIGGER_LABEL,
  AndroidBetaDialog,
} from "./AndroidBetaDialog";
import { AndroidBetaMobileSheet } from "./AndroidBetaMobileSheet";

export function AndroidAppCTA() {
  const { platform } = usePlatform();
  const [open, setOpen] = useState(false);

  if (androidCtaMode(platform) === "dialog") return <AndroidBetaDialog />;

  return (
    <>
      <button
        type="button"
        onClick={() => {
          track("android_beta_sheet_opened");
          setOpen(true);
        }}
        className={ANDROID_BETA_TRIGGER_CLASS}
      >
        <FaAndroid className="size-4 shrink-0" aria-hidden="true" />
        {ANDROID_BETA_TRIGGER_LABEL}
      </button>

      <AndroidBetaMobileSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function androidCtaMode(platform: Platform): "sheet" | "dialog" {
  return platform === Platform.Mobile ? "sheet" : "dialog";
}
