"use client";

import { useEffect, useMemo, useState } from "react";
import { arrowSeq, ctrlChar, escSeq, pgDnSeq, pgUpSeq, tabSeq } from "@/lib/terminal-keys";

interface MobileTerminalKeysProps {
  onSend: (data: string) => void;
}

function isNarrowViewport(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(max-width: 900px)").matches;
}

export function MobileTerminalKeys({ onSend }: MobileTerminalKeysProps) {
  const [isMobile, setIsMobile] = useState<boolean>(() => isNarrowViewport());
  const [imeVisible, setImeVisible] = useState(false);
  const [bottomOffset, setBottomOffset] = useState(0);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [altArmed, setAltArmed] = useState(false);

  useEffect(() => {
    const onResize = () => setIsMobile(isNarrowViewport());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.visualViewport === "undefined") return;
    const viewport = window.visualViewport;
    if (!viewport) return;

    const onViewportResize = () => {
      const viewportHeight = viewport.height;
      const keyboardHeight = window.innerHeight - viewportHeight;
      const open = keyboardHeight > 120;
      setImeVisible(open);
      setBottomOffset(open ? keyboardHeight : 0);
    };

    viewport.addEventListener("resize", onViewportResize);
    viewport.addEventListener("scroll", onViewportResize);
    onViewportResize();
    return () => {
      viewport.removeEventListener("resize", onViewportResize);
      viewport.removeEventListener("scroll", onViewportResize);
    };
  }, []);

  const sendWithModifiers = useMemo(
    () => (payload: string) => {
      if (ctrlArmed) {
        onSend(ctrlChar(payload[0] ?? payload));
        setCtrlArmed(false);
        setAltArmed(false);
        return;
      }
      if (altArmed) {
        onSend(escSeq() + payload);
        setAltArmed(false);
        return;
      }
      onSend(payload);
    },
    [altArmed, ctrlArmed, onSend],
  );

  if (!isMobile || !imeVisible) return null;

  return (
    <div className="mobile-terminal-keys" style={{ bottom: `${bottomOffset}px` }}>
      <div className="mobile-terminal-keys__row">
        <button onClick={() => sendWithModifiers(escSeq())}>Esc</button>
        <button
          className={ctrlArmed ? "mobile-terminal-keys__mod-active" : undefined}
          onClick={() => setCtrlArmed((current) => !current)}
        >
          Ctrl
        </button>
        <button onClick={() => sendWithModifiers(arrowSeq("up"))}>↑</button>
        <button onClick={() => sendWithModifiers(pgUpSeq())}>PgUp</button>
      </div>
      <div className="mobile-terminal-keys__row">
        <button onClick={() => sendWithModifiers(tabSeq())}>Tab</button>
        <button
          className={altArmed ? "mobile-terminal-keys__mod-active" : undefined}
          onClick={() => setAltArmed((current) => !current)}
        >
          Alt
        </button>
        <div className="mobile-terminal-keys__arrows">
          <button onClick={() => sendWithModifiers(arrowSeq("left"))}>←</button>
          <button onClick={() => sendWithModifiers(arrowSeq("down"))}>↓</button>
          <button onClick={() => sendWithModifiers(arrowSeq("right"))}>→</button>
        </div>
        <button onClick={() => sendWithModifiers(pgDnSeq())}>PgDn</button>
      </div>
    </div>
  );
}
