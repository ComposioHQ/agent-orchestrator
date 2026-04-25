"use client";

import { useEffect, useRef, useState, useMemo } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTheme } from "next-themes";
import { cn } from "@/lib/cn";
import { useMux } from "@/hooks/useMux";
import { attachTouchScroll } from "@/lib/terminal-touch-scroll";

// Import xterm CSS (must be imported in client component)
import "@xterm/xterm/css/xterm.css";

// Static type-only imports (erased at compile time, no SSR impact).
// The runtime Terminal class is loaded via dynamic import() inside useEffect to avoid SSR.
import type { ITheme, Terminal as TerminalType } from "@xterm/xterm";
import type { FitAddon as FitAddonType } from "@xterm/addon-fit";

// Font size constants
const FONT_SIZE_KEY = "ao-terminal-font-size";
const FONT_SIZE_MIN = 9;
const FONT_SIZE_MAX = 18;
const FONT_SIZE_DEFAULT = 13;

// Fallback mono stack used when the CSS custom property isn't resolvable yet.
const MONO_FONT_FALLBACK =
  '"JetBrains Mono", "SF Mono", Menlo, Monaco, "Courier New", monospace';

/**
 * Resolve the app's configured mono font token to a concrete font-family string.
 *
 * xterm's internal char-size measurement ultimately hits canvas ctx.font, which
 * cannot evaluate `var(...)`. Reading `--font-jetbrains-mono` with
 * getComputedStyle gives us the generated next/font family name (e.g.
 * `__JetBrains_Mono_abc123`), which we can safely feed into xterm while still
 * honouring the app's font configuration.
 *
 * NOTE: we deliberately read `--font-jetbrains-mono` and NOT `--font-mono`.
 * `--font-mono` in globals.css is itself a composed stack that contains
 * `var(--font-jetbrains-mono)` — if we forwarded that to xterm, the raw
 * `var(...)` token would end up back in canvas ctx.font and reintroduce the
 * original measurement bug this helper exists to fix.
 *
 * Exported for unit testing.
 */
export function resolveMonoFontFamily(): string {
  if (typeof window === "undefined") return MONO_FONT_FALLBACK;
  try {
    const resolved = getComputedStyle(document.documentElement)
      .getPropertyValue("--font-jetbrains-mono")
      .trim();
    return resolved ? `${resolved}, ${MONO_FONT_FALLBACK}` : MONO_FONT_FALLBACK;
  } catch {
    return MONO_FONT_FALLBACK;
  }
}

function getStoredFontSize(): number {
  if (typeof window === "undefined") return FONT_SIZE_DEFAULT;
  try {
    const stored = localStorage.getItem(FONT_SIZE_KEY);
    if (stored) {
      const size = parseInt(stored, 10);
      if (!Number.isNaN(size)) {
        return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, size));
      }
    }
  } catch {
    // localStorage might be unavailable
  }
  return FONT_SIZE_DEFAULT;
}

interface DirectTerminalProps {
  sessionId: string;
  /** Actual tmux session name. When provided, the terminal server uses it directly instead of resolving from sessionId. */
  tmuxName?: string;
  startFullscreen?: boolean;
  /** Visual variant. Orchestrator keeps the same design-system blue accent as the rest of the app. */
  variant?: "agent" | "orchestrator";
  appearance?: "theme" | "dark";
  /** @deprecated Terminal now fills its flex parent via flex:1. This prop is ignored. */
  height?: string;
  isOpenCodeSession?: boolean;
  reloadCommand?: string;
  chromeless?: boolean;
  /** When true, focus the terminal immediately after it mounts so keyboard input works without clicking first. */
  autoFocus?: boolean;
}

type TerminalVariant = "agent" | "orchestrator";


export function buildTerminalThemes(variant: TerminalVariant): { dark: ITheme; light: ITheme } {
  const agentAccent = {
    cursor: "#5b7ef8",
    selDark: "rgba(91, 126, 248, 0.30)",
    selLight: "rgba(91, 126, 248, 0.25)",
  };
  const orchAccent = agentAccent;
  const accent = variant === "orchestrator" ? orchAccent : agentAccent;

  const dark: ITheme = {
    background: "#0a0a0f",
    foreground: "#d4d4d8",
    cursor: accent.cursor,
    cursorAccent: "#0a0a0f",
    selectionBackground: accent.selDark,
    selectionInactiveBackground: "rgba(128, 128, 128, 0.2)",
    // ANSI colors — slightly warmer than pure defaults
    black: "#1a1a24",
    red: "#ef4444",
    green: "#22c55e",
    yellow: "#f59e0b",
    blue: "#5b7ef8",
    magenta: "#a371f7",
    cyan: "#22d3ee",
    white: "#d4d4d8",
    brightBlack: "#50506a",
    brightRed: "#f87171",
    brightGreen: "#4ade80",
    brightYellow: "#fbbf24",
    brightBlue: "#7b9cfb",
    brightMagenta: "#c084fc",
    brightCyan: "#67e8f9",
    brightWhite: "#eeeef5",
  };

  const light: ITheme = {
    background: "#fafafa",
    foreground: "#24292f",
    cursor: accent.cursor,
    cursorAccent: "#fafafa",
    selectionBackground: accent.selLight,
    selectionInactiveBackground: "rgba(128, 128, 128, 0.15)",
    // ANSI colors — darkened for legibility on #fafafa terminal background
    black: "#24292f",
    red: "#b42318",
    green: "#1f7a3d",
    yellow: "#8a5a00",
    blue: "#175cd3",
    magenta: "#8e24aa",
    cyan: "#0b7285",
    white: "#4b5563",
    brightBlack: "#374151",
    brightRed: "#912018",
    brightGreen: "#176639",
    brightYellow: "#6f4a00",
    brightBlue: "#1d4ed8",
    brightMagenta: "#7b1fa2",
    brightCyan: "#155e75",
    brightWhite: "#374151",
  };

  return { dark, light };
}

/**
 * Direct xterm.js terminal with native WebSocket connection.
 * Implements Extended Device Attributes (XDA) handler to enable
 * tmux clipboard support (OSC 52) without requiring iTerm2 attachment.
 *
 * Based on DeepWiki analysis:
 * - tmux queries for XDA (CSI > q / XTVERSION) to detect terminal type
 * - When tmux sees "XTerm(" in response, it enables TTYC_MS (clipboard)
 * - xterm.js doesn't implement XDA by default, so we register custom handler
 */
export function DirectTerminal({
  sessionId,
  tmuxName,
  startFullscreen = false,
  variant = "agent",
  appearance = "theme",
  height: _height = "max(440px, calc(100dvh - 440px))",
  isOpenCodeSession = false,
  reloadCommand,
  chromeless = false,
  autoFocus = false,
}: DirectTerminalProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { resolvedTheme } = useTheme();
  const terminalThemes = useMemo(() => buildTerminalThemes(variant), [variant]);
  const { subscribeTerminal, writeTerminal, resizeTerminal: resizeTerminalMux, openTerminal, closeTerminal, status: muxStatus } = useMux();

  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstance = useRef<TerminalType | null>(null);
  const fitAddon = useRef<FitAddonType | null>(null);
  const muxStatusRef = useRef(muxStatus);
  muxStatusRef.current = muxStatus;
  const [fullscreen, setFullscreen] = useState(startFullscreen);
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const [fontSize, setFontSize] = useState(getStoredFontSize());
  const followOutputRef = useRef(true);
  const [followOutput, setFollowOutput] = useState(true);
  const programmaticScrollRef = useRef(false);

  // Update URL when fullscreen changes
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());

    if (fullscreen) {
      params.set("fullscreen", "true");
    } else {
      params.delete("fullscreen");
    }

    const newUrl = params.toString() ? `${pathname}?${params.toString()}` : pathname;
    router.replace(newUrl, { scroll: false });
  }, [fullscreen, pathname, router, searchParams]);

  async function handleReload(): Promise<void> {
    if (!isOpenCodeSession || reloading) return;
    setReloadError(null);
    setReloading(true);
    try {
      let commandToSend = reloadCommand;

      if (!commandToSend) {
        const remapRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/remap`, {
          method: "POST",
        });
        if (!remapRes.ok) {
          throw new Error(`Failed to remap OpenCode session: ${remapRes.status}`);
        }
        const remapData = (await remapRes.json()) as { opencodeSessionId?: unknown };
        if (
          typeof remapData.opencodeSessionId !== "string" ||
          remapData.opencodeSessionId.length === 0
        ) {
          throw new Error("Missing OpenCode session id after remap");
        }
        commandToSend = `/exit\nopencode --session ${remapData.opencodeSessionId}\n`;
      }

      const sendRes = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: commandToSend }),
      });
      if (!sendRes.ok) {
        throw new Error(`Failed to send reload command: ${sendRes.status}`);
      }
    } catch (err) {
      setReloadError(err instanceof Error ? err.message : "Failed to reload OpenCode session");
    } finally {
      setReloading(false);
    }
  }

  useEffect(() => {
    if (!terminalRef.current) return;

    // Dynamically import xterm.js to avoid SSR issues
    let mounted = true;
    let cleanup: (() => void) | null = null;
    let inputDisposable: { dispose(): void } | null = null;
    let unsubscribe: (() => void) | null = null;

    Promise.all([
      import("@xterm/xterm").then((mod) => mod.Terminal),
      import("@xterm/addon-fit").then((mod) => mod.FitAddon),
      import("@xterm/addon-web-links").then((mod) => mod.WebLinksAddon),
      document.fonts.ready,
    ])
      .then(([Terminal, FitAddon, WebLinksAddon]) => {
        if (!mounted || !terminalRef.current) return;

        const isDark = appearance === "dark" || resolvedTheme !== "light";
        const activeTheme = isDark ? terminalThemes.dark : terminalThemes.light;

        // Initialize xterm.js Terminal
        // NOTE: xterm's internal char-size measurement uses canvas ctx.font which
        // cannot resolve `var(...)`. resolveMonoFontFamily() reads the CSS custom
        // property at runtime so we still honour the app's configured font token
        // (next/font generated name) while handing xterm a concrete string.
        const terminal = new Terminal({
          cursorBlink: true,
          fontSize: fontSize,
          fontFamily: resolveMonoFontFamily(),
          // xterm v6 default lineHeight (1.0) collides rows with JetBrains Mono's
          // tall x-height. 1.2 restores visual breathing room between lines.
          lineHeight: 1.2,
          theme: activeTheme,
          // Light mode needs an explicit contrast floor because agent UIs often emit
          // dim/faint ANSI sequences that become unreadable on a near-white background.
          minimumContrastRatio: isDark ? 1 : 7,
          scrollback: 10000,
          allowProposedApi: true,
          fastScrollSensitivity: 3,
          scrollSensitivity: 1,
        });

        // Add FitAddon for responsive sizing
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        fitAddon.current = fit;

        // Add WebLinksAddon for clickable links
        const webLinks = new WebLinksAddon();
        terminal.loadAddon(webLinks);

        // **CRITICAL FIX**: Register XDA (Extended Device Attributes) handler
        // This makes tmux recognize our terminal and enable clipboard support
        terminal.parser.registerCsiHandler(
          { prefix: ">", final: "q" }, // CSI > q is XTVERSION / XDA
          () => {
            // Respond with XTerm identification that tmux recognizes
            // tmux looks for "XTerm(" in the response (see tmux tty-keys.c)
            // Format: DCS > | XTerm(version) ST
            // DCS = \x1bP, ST = \x1b\\
            terminal.write("\x1bP>|XTerm(370)\x1b\\");
            console.log("[DirectTerminal] Sent XDA response for clipboard support");
            return true; // Handled
          },
        );

        // Register OSC 52 handler for clipboard support
        // tmux sends OSC 52 with base64-encoded text when copying
        terminal.parser.registerOscHandler(52, (data) => {
          const parts = data.split(";");
          if (parts.length < 2) return false;
          const b64 = parts[parts.length - 1];
          try {
            // Decode base64 → binary string → Uint8Array → UTF-8 text
            // atob() alone only handles Latin-1; TextDecoder is needed for UTF-8
            const binary = atob(b64);
            const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
            const text = new TextDecoder().decode(bytes);
            navigator.clipboard?.writeText(text).catch(() => {});
          } catch {
            // Ignore decode errors
          }
          return true;
        });

        // Open terminal in DOM
        terminal.open(terminalRef.current);
        terminalInstance.current = terminal;

        if (autoFocus) {
          terminal.focus();
        }

        // Fit terminal to container
        fit.fit();

        // Deferred fit to handle cases where container wasn't sized yet
        const deferredFitTimeout = setTimeout(() => {
          if (mounted && fitAddon.current) {
            try {
              fitAddon.current.fit();
              resizeTerminalMux(sessionId, terminal.cols, terminal.rows);
            } catch {
              // Ignore fit errors
            }
          }
        }, 100);

        // Re-measure when webfonts finish loading. next/font uses font-display:swap,
        // so document.fonts.ready can resolve before JetBrains Mono actually swaps
        // in. Without this, xterm's initial cell measurement stays pinned to the
        // fallback font — producing wide-looking horizontal cells once the real
        // font swaps. Listening to 'loadingdone' forces a re-fit when the swap
        // actually completes.
        const handleFontsLoadingDone = () => {
          if (!mounted || !fitAddon.current || !terminalInstance.current) return;
          try {
            // Re-resolve the CSS var in case next/font registered its family
            // name after initial construction, then force a re-measure.
            terminalInstance.current.options.fontFamily = resolveMonoFontFamily();
            terminalInstance.current.clearTextureAtlas?.();
            fitAddon.current.fit();
            resizeTerminalMux(sessionId, terminalInstance.current.cols, terminalInstance.current.rows);
          } catch {
            // Ignore fit errors
          }
        };
        // Feature-detect `FontFaceSet.addEventListener` — it's missing in
        // jsdom's `document.fonts` mock and some older runtimes. Without the
        // guard, init throws a TypeError and the terminal never attaches.
        const fontsFace =
          typeof document !== "undefined" ? document.fonts : undefined;
        const fontsListenerAttached =
          !!fontsFace && typeof fontsFace.addEventListener === "function";
        if (fontsListenerAttached) {
          fontsFace!.addEventListener("loadingdone", handleFontsLoadingDone);
        }

        // Attach touch scroll for mobile — disable follow-output while user is scrolling.
        // Note: onScrollTowardLatest intentionally does NOT hide the button. In normal
        // buffer, terminal.onScroll fires after scrollLines() and decides based on real
        // position. In alternate buffer (tmux), there's no way to detect when the user
        // has truly returned to the live tail, so the button stays visible until clicked.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cleanupTouchScroll = attachTouchScroll(terminal as any, (data) => {
          writeTerminal(sessionId, data);
        }, {
          onScrollAway: () => { followOutputRef.current = false; setFollowOutput(false); },
        });

        // Set up ResizeObserver to handle flex layout changes
        let resizeObserver: ResizeObserver | null = null;
        if (terminalRef.current) {
          resizeObserver = new ResizeObserver(() => {
            if (mounted && fitAddon.current) {
              try {
                fitAddon.current.fit();
                resizeTerminalMux(sessionId, terminal.cols, terminal.rows);
              } catch {
                // Ignore fit errors
              }
            }
          });
          resizeObserver.observe(terminalRef.current);
        }

        // ── Preserve selection while terminal receives output ────────
        // xterm.js clears the selection on every terminal.write(). We
        // buffer incoming data while a selection is active so the
        // highlight stays visible for Cmd+C. The buffer is flushed
        // when the selection is cleared (click, keypress, etc.).
        const writeBuffer: string[] = [];
        let selectionActive = false;
        let safetyTimer: ReturnType<typeof setTimeout> | null = null;
        let bufferBytes = 0;
        const MAX_BUFFER_BYTES = 1_048_576; // 1 MB

        const flushWriteBuffer = () => {
          if (safetyTimer) {
            clearTimeout(safetyTimer);
            safetyTimer = null;
          }
          if (writeBuffer.length > 0) {
            terminal.write(writeBuffer.join(""));
            writeBuffer.length = 0;
            bufferBytes = 0;
          }
        };

        const selectionDisposable = terminal.onSelectionChange(() => {
          if (terminal.hasSelection()) {
            selectionActive = true;
            // Safety: flush after 5s to prevent unbounded buffering
            if (!safetyTimer) {
              safetyTimer = setTimeout(() => {
                selectionActive = false;
                flushWriteBuffer();
              }, 5_000);
            }
          } else {
            selectionActive = false;
            flushWriteBuffer();
          }
        });

        // Intercept Cmd+C (Mac) and Ctrl+Shift+C (Linux/Win) for copy.
        // Paste (Cmd+V / Ctrl+Shift+V) is handled natively by xterm.js
        // via its internal textarea — no custom handler needed.
        terminal.attachCustomKeyEventHandler((e: KeyboardEvent) => {
          if (e.type !== "keydown") return true;

          // Cmd+C / Ctrl+Shift+C — copy selection
          const isCopy =
            (e.metaKey && !e.ctrlKey && !e.altKey && e.code === "KeyC") ||
            (e.ctrlKey && e.shiftKey && e.code === "KeyC");
          if (isCopy && terminal.hasSelection()) {
            navigator.clipboard?.writeText(terminal.getSelection()).catch(() => {});
            // Clear selection so the terminal resumes receiving output
            terminal.clearSelection();
            return false;
          }

          return true;
        });

        // Open terminal via mux
        openTerminal(sessionId, tmuxName);

        // Subscribe to terminal data via mux
        unsubscribe = subscribeTerminal(sessionId, (data) => {
          if (selectionActive) {
            writeBuffer.push(data);
            bufferBytes += data.length;
            // Flush if buffer exceeds 1 MB to prevent OOM
            if (bufferBytes > MAX_BUFFER_BYTES) {
              selectionActive = false;
              flushWriteBuffer();
            }
          } else {
            terminal.write(data);
            if (followOutputRef.current) {
              programmaticScrollRef.current = true;
              terminal.scrollToBottom();
            }
          }
        });

        // Use xterm's onScroll event (fires with new viewportY) instead of a DOM
        // scroll listener — xterm v6 may update scrollTop via RAF, making DOM
        // "scroll" events unreliable for detecting user-initiated scrolls.
        const scrollDisposable = terminal.onScroll(() => {
          if (programmaticScrollRef.current) {
            programmaticScrollRef.current = false;
            return;
          }
          const buf = terminal.buffer.active;
          const atBottom = buf.viewportY + terminal.rows >= buf.length;
          if (atBottom) {
            followOutputRef.current = true;
            setFollowOutput(true);
          } else {
            followOutputRef.current = false;
            setFollowOutput(false);
          }
        });

        // Handle window resize
        const handleResize = () => {
          if (fit) {
            fit.fit();
            resizeTerminalMux(sessionId, terminal.cols, terminal.rows);
          }
        };

        window.addEventListener("resize", handleResize);

        // Terminal input → mux
        inputDisposable = terminal.onData((data) => {
          writeTerminal(sessionId, data);
        });

        // Send initial size
        resizeTerminalMux(sessionId, terminal.cols, terminal.rows);

        // Store cleanup function to be called from useEffect cleanup
        cleanup = () => {
          clearTimeout(deferredFitTimeout);
          resizeObserver?.disconnect();
          cleanupTouchScroll();
          selectionDisposable.dispose();
          if (safetyTimer) clearTimeout(safetyTimer);
          window.removeEventListener("resize", handleResize);
          if (fontsListenerAttached && fontsFace) {
            fontsFace.removeEventListener("loadingdone", handleFontsLoadingDone);
          }
          scrollDisposable.dispose();
          inputDisposable?.dispose();
          inputDisposable = null;
          unsubscribe?.();
          closeTerminal(sessionId);
          terminal.dispose();
        };
      })
      .catch((err) => {
        console.error("[DirectTerminal] Failed to load xterm.js:", err);
        setError("Failed to load terminal");
      });

    return () => {
      mounted = false;
      cleanup?.();
    };
    // fontSize intentionally NOT in deps — it's handled by a dedicated effect
    // below that mutates terminal.options.fontSize in place. Adding it here
    // would tear down and recreate the terminal (and WebSocket) on every
    // stepper click, losing scrollback and flashing content.
  }, [
    appearance,
    sessionId,
    variant,
    resolvedTheme,
    terminalThemes,
    subscribeTerminal,
    writeTerminal,
    resizeTerminalMux,
    openTerminal,
    closeTerminal,
  ]);

  // Re-send terminal dimensions on every reconnect so the server-side PTY
  // matches the client's xterm.js size (new PTYs spawn at 80×24 default).
  useEffect(() => {
    if (muxStatus !== "connected") return;
    const fit = fitAddon.current;
    const terminal = terminalInstance.current;
    if (!fit || !terminal) return;
    fit.fit();
    resizeTerminalMux(sessionId, terminal.cols, terminal.rows);
  }, [muxStatus, sessionId, resizeTerminalMux]);

  // Live theme switching without terminal recreation
  useEffect(() => {
    const terminal = terminalInstance.current;
    if (!terminal) return;
    const isDark = appearance === "dark" || resolvedTheme !== "light";
    terminal.options.theme = isDark ? terminalThemes.dark : terminalThemes.light;
    terminal.options.minimumContrastRatio = isDark ? 1 : 7;
  }, [appearance, resolvedTheme, terminalThemes]);

  // Font size change effect
  useEffect(() => {
    const terminal = terminalInstance.current;
    const fit = fitAddon.current;
    if (!terminal || !fit) return;
    terminal.options.fontSize = fontSize;
    try {
      localStorage.setItem(FONT_SIZE_KEY, String(fontSize));
    } catch {
      // localStorage might be unavailable
    }
    // Re-fit locally AND tell the server-side PTY about the new cols/rows.
    // Without the mux resize, the shell keeps wrapping at the old dimensions
    // and the rendered output stops matching the visible grid until the
    // next resize event (window resize, tab switch, etc.).
    fit.fit();
    resizeTerminalMux(sessionId, terminal.cols, terminal.rows);
  }, [fontSize, sessionId, resizeTerminalMux]);

  // Re-fit terminal when fullscreen changes
  useEffect(() => {
    const fit = fitAddon.current;
    const terminal = terminalInstance.current;
    const container = terminalRef.current;

    if (!fit || !terminal || muxStatusRef.current !== "connected" || !container) {
      return;
    }

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
        // Container is still transitioning, try again next frame
        rafId = requestAnimationFrame(resizeTerminal);
        return;
      }

      // Container is at target size, now resize terminal
      terminal.refresh(0, terminal.rows - 1);
      fit.fit();
      terminal.refresh(0, terminal.rows - 1);

      // Send new size to server via mux
      resizeTerminalMux(sessionId, terminal.cols, terminal.rows);
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
  }, [fullscreen, sessionId, resizeTerminalMux]);

  const accentColor = "var(--color-accent)";

  // Local errors (e.g. xterm.js load failure) take priority over mux connection state
  const displayStatus = error ? "error" : muxStatus;

  const statusDotClass =
    displayStatus === "connected"
      ? "bg-[var(--color-status-ready)]"
      : displayStatus === "error" || displayStatus === "disconnected"
        ? "bg-[var(--color-status-error)]"
        : "bg-[var(--color-status-attention)] animate-[pulse_1.5s_ease-in-out_infinite]";

  const statusText =
    displayStatus === "connected"
      ? "Connected"
      : displayStatus === "error"
        ? (error ?? "Error")
        : displayStatus === "disconnected"
          ? "Disconnected"
          : "Connecting…";

  const statusTextColor =
    displayStatus === "connected"
      ? "text-[var(--color-status-ready)]"
      : displayStatus === "error" || displayStatus === "disconnected"
        ? "text-[var(--color-status-error)]"
        : "text-[var(--color-text-tertiary)]";
  const isDarkChrome = appearance === "dark" || resolvedTheme !== "light";

  const fontSizeControls = (
    <div className="flex items-center">
      <button
        onClick={() => setFontSize((prev) => Math.max(FONT_SIZE_MIN, prev - 1))}
        disabled={fontSize <= FONT_SIZE_MIN}
        className="w-5 h-5 text-xs flex items-center justify-center rounded hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        aria-label="Decrease font size"
      >
        −
      </button>
      <span className="w-9 text-center text-xs font-medium text-[var(--color-text-secondary)]">
        {fontSize}px
      </span>
      <button
        onClick={() => setFontSize((prev) => Math.min(FONT_SIZE_MAX, prev + 1))}
        disabled={fontSize >= FONT_SIZE_MAX}
        className="w-5 h-5 text-xs flex items-center justify-center rounded hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        aria-label="Increase font size"
      >
        +
      </button>
    </div>
  );

  const fullscreenButton = (
    <button
      onClick={() => setFullscreen(!fullscreen)}
      className={cn(
        "flex items-center gap-1 px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)]",
        !isOpenCodeSession && !chromeless && "ml-auto",
      )}
      aria-label={fullscreen ? "exit fullscreen" : "fullscreen"}
    >
      {fullscreen ? (
        <>
          <svg
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
          </svg>
          exit fullscreen
        </>
      ) : (
        <>
          <svg
            className="h-3 w-3"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
          </svg>
          fullscreen
        </>
      )}
    </button>
  );

  return (
    <div
      className={cn(
        "overflow-hidden border border-[var(--color-border-default)] flex flex-col",
        fullscreen ? "fixed inset-0 z-50 rounded-none border-0" : "relative h-full",
        isDarkChrome ? "bg-[#0a0a0f]" : "bg-[#fafafa]",
        chromeless && "border-0",
      )}
    >
      {!chromeless ? (
        <div className="terminal-chrome-bar flex items-center gap-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-elevated)] px-3 py-2">
          {/* Pane label — matches the workspace pane-header style used elsewhere */}
          <span className="terminal-chrome-pane-label">TERMINAL</span>
          {/* Identity group: session name on top, status+XDA below on mobile */}
          <div className="terminal-chrome-identity">
            <span className="terminal-chrome-session-id font-[var(--font-mono)] text-[11px]" style={{ color: accentColor }}>
              {sessionId}
            </span>
            <div className="terminal-chrome-status-row">
              <div className={cn("h-2 w-2 shrink-0 rounded-full", statusDotClass)} />
              <span
                className={cn("text-[10px] font-medium uppercase tracking-[0.06em]", statusTextColor)}
              >
                {statusText}
              </span>
              <span
                className="px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.06em]"
                style={{
                  color: accentColor,
                  background: `color-mix(in srgb, ${accentColor} 12%, transparent)`,
                }}
              >
                XDA
              </span>
            </div>
          </div>
          <div className="flex-1" />
          {fontSizeControls}
          {isOpenCodeSession ? (
            <button
              onClick={handleReload}
              disabled={reloading || muxStatus !== "connected"}
              title="Restart OpenCode session (/exit then resume mapped session)"
              aria-label="Restart OpenCode session"
              className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {reloading ? (
                <>
                  <svg
                    className="h-3 w-3 animate-spin"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                  >
                    <path d="M12 3a9 9 0 109 9" />
                  </svg>
                  restarting
                </>
              ) : (
                <>
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                  >
                    <path d="M21 12a9 9 0 11-2.64-6.36" />
                    <path d="M21 3v6h-6" />
                  </svg>
                  restart
                </>
              )}
            </button>
          ) : null}
          {reloadError ? (
            <span
              className="max-w-[40ch] truncate text-[10px] font-medium text-[var(--color-status-error)]"
              title={reloadError}
            >
              {reloadError}
            </span>
          ) : null}
          {fullscreenButton}
        </div>
      ) : null}
      {chromeless ? (
        <div className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded-[6px] border border-[var(--color-border-subtle)] bg-[color-mix(in_srgb,var(--color-bg-elevated)_92%,transparent)] px-1.5 py-1 shadow-[0_8px_24px_rgba(0,0,0,0.18)] backdrop-blur-sm">
          {isOpenCodeSession ? (
            <button
              onClick={handleReload}
              disabled={reloading || muxStatus !== "connected"}
              title="Restart OpenCode session (/exit then resume mapped session)"
              aria-label="Restart OpenCode session"
              className="flex items-center gap-1 px-2 py-0.5 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-70"
            >
              {reloading ? (
                <>
                  <svg
                    className="h-3 w-3 animate-spin"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                  >
                    <path d="M12 3a9 9 0 109 9" />
                  </svg>
                  restarting
                </>
              ) : (
                <>
                  <svg
                    className="h-3 w-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    viewBox="0 0 24 24"
                  >
                    <path d="M21 12a9 9 0 11-2.64-6.36" />
                    <path d="M21 3v6h-6" />
                  </svg>
                  restart
                </>
              )}
            </button>
          ) : null}
          {fullscreenButton}
        </div>
      ) : null}
      {/* Terminal area — flex:1 so it fills remaining space after the chrome bar */}
      <div className="relative flex-1 min-h-0 flex flex-col">
        {!followOutput ? (
          <button
            type="button"
            onClick={() => {
              const t = terminalInstance.current;
              if (t) {
                if (t.buffer.active.type === "normal") {
                  // Normal buffer: scrollback exists in xterm, use its API.
                  programmaticScrollRef.current = true;
                  t.scrollToBottom();
                } else {
                  // Alternate buffer (tmux/vim): xterm has no scrollback to scroll
                  // to. The user is in tmux copy-mode (entered by attachTouchScroll
                  // on swipe). Send 'q' to exit copy-mode and return to live tail.
                  writeTerminal(sessionId, "q");
                }
              }
              followOutputRef.current = true;
              setFollowOutput(true);
            }}
            className="absolute bottom-3 right-3 z-20 flex h-8 w-8 items-center justify-center rounded-full border border-[var(--color-border-default)] bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] shadow-md active:scale-95"
            aria-label="Jump to latest"
            title="Jump to latest"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
          </button>
        ) : null}
        <div
          ref={terminalRef}
          className="w-full flex flex-col flex-1 min-h-0 overflow-hidden"
        />
      </div>
    </div>
  );
}
