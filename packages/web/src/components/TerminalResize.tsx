import { useEffect, type RefObject } from "react";
import type { Terminal as TerminalType } from "xterm";
import type { FitAddon as FitAddonType } from "@xterm/addon-fit";

interface UseTerminalResizeOptions {
  /** Ref to the xterm.js terminal instance. */
  terminalRef: RefObject<TerminalType | null>;
  /** Ref to the FitAddon instance used to resize the terminal. */
  fitAddonRef: RefObject<FitAddonType | null>;
  /** A ref-like getter for the current WebSocket (may reconnect). */
  getWebSocket: () => WebSocket | null;
  /** Ref to the terminal container element. */
  containerRef: RefObject<HTMLDivElement | null>;
  /** Whether the terminal is in fullscreen mode. */
  fullscreen: boolean;
}

/**
 * Send a resize message over the given WebSocket if it is open.
 * Pure helper -- no side effects beyond the network send.
 */
export function sendResizeMessage(
  ws: WebSocket | null,
  cols: number,
  rows: number,
): void {
  if (ws?.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }
}

/**
 * Hook that re-fits the terminal whenever `fullscreen` changes.
 *
 * It waits for the container's CSS transition to settle (height stops
 * changing between animation frames) before performing the fit, with
 * backup timers at 300 ms and 600 ms.
 *
 * Accepts refs (not .current values) so it always reads the latest
 * ref value inside the effect, avoiding stale closures.
 */
export function useTerminalResize({
  terminalRef,
  fitAddonRef,
  getWebSocket,
  containerRef,
  fullscreen,
}: UseTerminalResizeOptions): void {
  useEffect(() => {
    const fitAddon = fitAddonRef.current;
    const terminal = terminalRef.current;
    const container = containerRef.current;

    if (!fitAddon || !terminal || !container) return;

    const ws = getWebSocket();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    let resizeAttempts = 0;
    const maxAttempts = 60;
    let cancelled = false;
    let rafId = 0;
    let lastHeight = -1;

    const resizeTerminal = () => {
      if (cancelled) return;
      resizeAttempts++;

      // Wait for the container height to stabilise (CSS transition finished)
      const currentHeight = container.getBoundingClientRect().height;
      const settled = lastHeight >= 0 && Math.abs(currentHeight - lastHeight) < 1;
      lastHeight = currentHeight;

      if (!settled && resizeAttempts < maxAttempts) {
        rafId = requestAnimationFrame(resizeTerminal);
        return;
      }

      // Container is at target size, now resize terminal
      terminal.refresh(0, terminal.rows - 1);
      fitAddon.fit();
      terminal.refresh(0, terminal.rows - 1);

      sendResizeMessage(getWebSocket(), terminal.cols, terminal.rows);
    };

    // Start resize polling
    rafId = requestAnimationFrame(resizeTerminal);

    // Also try on transitionend
    const handleTransitionEnd = (e: TransitionEvent) => {
      if (cancelled) return;
      if (e.target === container.parentElement) {
        resizeAttempts = 0;
        lastHeight = -1;
        setTimeout(() => {
          if (!cancelled) rafId = requestAnimationFrame(resizeTerminal);
        }, 50);
      }
    };

    const parent = container.parentElement;
    parent?.addEventListener("transitionend", handleTransitionEnd);

    // Backup timers in case RAF polling doesn't work
    const timer1 = setTimeout(() => {
      if (cancelled) return;
      resizeAttempts = 0;
      lastHeight = -1;
      resizeTerminal();
    }, 300);
    const timer2 = setTimeout(() => {
      if (cancelled) return;
      resizeAttempts = 0;
      lastHeight = -1;
      resizeTerminal();
    }, 600);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      parent?.removeEventListener("transitionend", handleTransitionEnd);
      clearTimeout(timer1);
      clearTimeout(timer2);
    };
  }, [fullscreen, terminalRef, fitAddonRef, getWebSocket, containerRef]);
}
