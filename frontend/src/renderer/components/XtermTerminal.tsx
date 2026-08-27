// Self-contained xterm.js surface, ported from yyork's terminal architecture.
//
// Design rules (the reason this component exists):
//  - The mount effect is dependency-free: the terminal instance is created once
//    per mount and NEVER torn down because a callback identity changed.
//    TerminalPane's shell-owned cache chooses the mount lifetime: retained
//    handle generations survive route switches, replacement handles get a clean
//    surface, and same-handle reconnects reuse the mounted renderer.
//  - Nothing writes into the buffer at mount. Status/empty-state belongs to DOM
//    chrome around the terminal, not inside it. Writing before layout settles
//    is what crashed xterm's Viewport (`dimensions` of a zero-sized renderer).
//  - Fitting runs on several triggers, not one: FitAddon derives the grid from
//    the measured cell box, and if it measures before the monospace font's real
//    metrics (and the post-open renderer) are resolved it mis-counts cols/rows
//    and the grid clips inside the panel. So: next frame, two settle timeouts,
//    fonts.ready, a ResizeObserver, AND an onRender convergence loop that
//    re-fits until the proposed grid stops changing (the last is the only
//    trigger that recovers a clipped grid without the host box resizing). xterm
//    itself only fires onResize when the grid actually changed, so repeated
//    fits don't spam the PTY.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { useTranslation } from "react-i18next";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { diag } from "../lib/diag";
import { terminalFontSizeDelta as shortcutFontSizeDelta } from "../../shared/shortcuts";
import type {
	AttachableTerminal,
	TerminalUserInputSource,
} from "../hooks/useTerminalSession";
import { aoBridge } from "../lib/bridge";
import { TERMINAL_FONT_SIZE_DEFAULT } from "../lib/design-tokens";
import { isWebLink, openLinkInSystemBrowser } from "../lib/external-link-policy";
import { isMacPlatform } from "../lib/platform";
import { applyDocumentTheme, applyDocumentThemeStyle } from "../lib/theme";
import { buildTerminalThemes } from "../lib/terminal-themes";
import { useUiStore, type Theme } from "../stores/ui-store";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

export type XtermTerminalProps = {
	ariaLabel?: string;
	className?: string;
	fontSize?: number;
	isFullscreen?: boolean;
	theme: Theme;
	/** Resize this terminal without changing application zoom. */
	onChangeFontSize?: (delta: number) => void;
	/** Enter or exit fullscreen for the terminal pane that owns this xterm. */
	onToggleFullscreen?: () => void;
	/**
	 * The pane app scrolls its transcript by keyboard (PageUp/PageDown) rather
	 * than acting on SGR wheel reports — e.g. opencode, which enables mouse
	 * tracking but never scrolls on wheel reports. Routes the wheel to page keys
	 * on every platform (see the wheel handler), fixing it under a mux too.
	 */
	paneScrollsByKeyboard?: boolean;
	/** Terminal construction failed; the owner decides how to surface it. */
	onError?: (error: unknown) => void;
	/** Called after a terminal hyperlink is opened in the OS browser. */
	onLinkOpen?: (uri: string) => void;
	/** Publish the positive grid after a retained terminal becomes visible. */
	onVisibleSize?: (cols: number, rows: number) => void;
	/** Hidden retained terminals keep parsing output but expose no UI overlays. */
	isVisible?: boolean;
	/** Move keyboard focus into xterm when a controller needs human input. */
	focusRequested?: boolean;
	/**
	 * The terminal is open in the DOM and ready to be attached to a PTY. The
	 * handle stays valid until unmount; cols/rows are live getters.
	 */
	onReady?: (terminal: AttachableTerminal) => void;
};

// Prefer WebGL and let xterm fall back to its built-in renderer when WebGL is
// unavailable. The old Canvas addon only supports xterm 5 and cannot be loaded
// with the 6.1 line. WebGL stays loaded for the terminal's whole lifetime — a
// visibility-scoped variant was tried and reverted because releasing the
// context could visibly change an on-screen terminal's rendering.
function loadRenderer(term: Terminal): void {
	try {
		const webgl = new WebglAddon();
		webgl.onContextLoss(() => {
			diag("gpu CONTEXT LOSS -> built-in renderer fallback");
			webgl.dispose();
		});
		term.loadAddon(webgl);
		diag(`renderer=webgl dpr=${window.devicePixelRatio}`);
		return;
	} catch {
		diag(`renderer=built-in dpr=${window.devicePixelRatio} (webgl unavailable)`);
	}
}

// xterm palette tracks the app theme (see lib/terminal-themes.ts + tokens.css).
const SUPPRESS_NATIVE_PASTE_MS = 100;
/** Long enough to notice, short enough that a second copy reads as a second copy. */
const COPY_TOAST_MS = 1400;

function preparePastedText(text: string): string {
	return text.replace(/\r?\n/g, "\r");
}

function bracketPastedText(text: string, bracketedPasteMode: boolean): string {
	return bracketedPasteMode ? `\x1b[200~${text}\x1b[201~` : text;
}

function isTerminalCopyShortcut(event: KeyboardEvent): boolean {
	if (event.key === "Insert") return event.ctrlKey && !event.altKey && !event.metaKey;
	if (event.key.toLowerCase() !== "c") return false;
	if (event.metaKey) return true;
	if (event.ctrlKey && event.shiftKey && !event.altKey) return true;
	return isWindowsPlatform() && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
}

function isWindowsPlatform(): boolean {
	const platform =
		(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
	return platform.toLowerCase().startsWith("win");
}

function isTerminalPasteShortcut(event: KeyboardEvent): boolean {
	if (event.key === "Insert") return event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
	if (event.key.toLowerCase() !== "v") return false;
	if (event.metaKey) return true;
	if (event.ctrlKey && event.shiftKey && !event.altKey) return true;
	return isWindowsPlatform() && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
}

function consumeTerminalShortcut(event: KeyboardEvent): void {
	event.preventDefault();
	event.stopPropagation();
}

function terminalFontSizeDelta(event: KeyboardEvent): -1 | 0 | 1 {
	return shortcutFontSizeDelta(
		{
			key: event.key,
			code: event.code,
			ctrl: event.ctrlKey,
			meta: event.metaKey,
			shift: event.shiftKey,
			alt: event.altKey,
		},
		isMacPlatform(),
	);
}

function normalizedTerminalShortcut(event: KeyboardEvent): string | null {
	if (event.metaKey || event.shiftKey) return null;

	if (event.altKey && !event.ctrlKey) {
		switch (event.key) {
			case "ArrowLeft":
				return "\x1bb";
			case "ArrowRight":
				return "\x1bf";
			case "Backspace":
				return "\x1b\x7f";
			case "Delete":
				return "\x1bd";
			default:
				return null;
		}
	}

	if (event.ctrlKey && !event.altKey) {
		switch (event.key) {
			case "ArrowLeft":
				return "\x1b[1;5D";
			case "ArrowRight":
				return "\x1b[1;5C";
			case "Backspace":
				return "\x1b\x7f";
			case "Delete":
				return "\x1bd";
			default:
				return null;
		}
	}

	return null;
}

function terminalHasFocus(host: HTMLElement): boolean {
	const activeElement = document.activeElement;
	return !!activeElement && host.contains(activeElement);
}

type XtermInternal = Terminal & {
	_core?: {
		element?: HTMLElement;
		_selectionService?: {
			enable: () => void;
			shouldForceSelection: (event: MouseEvent) => boolean;
		};
	};
};

type DevXtermHost = HTMLDivElement & {
	__aoXtermForTest?: Terminal;
};

type TerminalContextMenuState = {
	canCopy: boolean;
	open: boolean;
	x: number;
	y: number;
	// The web link under the cursor when the menu opened, if any — enables the
	// "Open in system browser" item (left-click opens it in the AO Browser).
	link: string | null;
};

type TerminalContextMenuAction = "copy" | "paste" | "selectAll";

type TerminalContextMenuActions = Record<TerminalContextMenuAction, () => void>;

// For mouse-tracking panes we synthesize SGR mouse-wheel reports and write them
// to the pane; tmux (with `mouse on`, set by the runtime adapter) acts on them
// and scrolls its scrollback via copy-mode. Left to itself xterm would convert
// the wheel into cursor-arrow keys (its alt-buffer fallback), which move the
// agent's cursor rather than scrolling. SGR button 64 = wheel up, 65 = down;
// reports are 1-based and a single cell is enough for a borderless single pane.
const SGR_WHEEL_UP = 64;
const SGR_WHEEL_DOWN = 65;

function sgrWheelReport(button: number, count: number): string {
	return `\x1b[<${button};1;1M`.repeat(count);
}

// PageUp (CSI 5~) / PageDown (CSI 6~) for pane apps that scroll their transcript
// by keyboard rather than mouse reports. One page key per wheel notch: a page
// already scrolls a full screen, so scaling by line count would over-scroll.
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

function pageKeyReport(lines: number): string {
	return lines < 0 ? PAGE_UP : PAGE_DOWN;
}

function forceSelectionMode(term: Terminal): void {
	const internal = term as XtermInternal;
	const selectionService = internal._core?._selectionService;
	const element = internal._core?.element;
	if (!selectionService || !element) return;
	selectionService.shouldForceSelection = () => true;
	selectionService.enable();
	element.classList.remove("enable-mouse-events");
}

export function XtermTerminal(props: XtermTerminalProps) {
	const { t } = useTranslation();
	const themeStyle = useUiStore((state) => state.themeStyle);
	const shellRef = useRef<HTMLDivElement | null>(null);
	const hostRef = useRef<HTMLDivElement | null>(null);
	const termRef = useRef<Terminal | null>(null);
	const fitRef = useRef<(() => void) | null>(null);
	const contextMenuActionsRef = useRef<TerminalContextMenuActions | null>(null);
	const [contextMenu, setContextMenu] = useState<TerminalContextMenuState>({
		canCopy: false,
		open: false,
		x: 0,
		y: 0,
		link: null,
	});
	const [copiedToast, setCopiedToast] = useState(false);
	const copiedToastTimerRef = useRef<number | undefined>(undefined);
	const showCopiedToastRef = useRef<() => void>(() => undefined);
	// The web link currently under the cursor, tracked via the link providers'
	// hover/leave callbacks so the right-click menu can offer "Open in system
	// browser" for it.
	const hoveredLinkRef = useRef<string | null>(null);
	// Latest callbacks in a ref so the mount effect stays dependency-free — we
	// never tear down and recreate the terminal because a handler identity
	// changed between renders.
	const callbacksRef = useRef(props);

	const setContextMenuOpen = useCallback((open: boolean) => {
		setContextMenu((current) => ({ ...current, open }));
	}, []);

	const runContextMenuAction = useCallback(
		(action: TerminalContextMenuAction) => {
			contextMenuActionsRef.current?.[action]();
			setContextMenuOpen(false);
		},
		[setContextMenuOpen],
	);

	callbacksRef.current = props;
	showCopiedToastRef.current = () => {
		// Hidden retained terminals keep parsing output but expose no UI overlays.
		if (callbacksRef.current.isVisible === false) return;
		setCopiedToast(true);
		if (copiedToastTimerRef.current !== undefined) window.clearTimeout(copiedToastTimerRef.current);
		copiedToastTimerRef.current = window.setTimeout(() => {
			setCopiedToast(false);
			copiedToastTimerRef.current = undefined;
		}, COPY_TOAST_MS);
	};

	useEffect(
		() => () => {
			if (copiedToastTimerRef.current !== undefined) window.clearTimeout(copiedToastTimerRef.current);
		},
		[],
	);

	useEffect(() => {
		// buildTerminalThemes() reads live CSS vars from :root. Parent shell effects
		// run after child effects, so sync both independent theme axes here before
		// reading. Retained terminals subscribe to themeStyle directly and update
		// their live palette without being torn down or losing scrollback.
		applyDocumentTheme(props.theme);
		applyDocumentThemeStyle(themeStyle);
		const term = termRef.current;
		if (!term) return;
		const { dark, light } = buildTerminalThemes();
		term.options.theme = props.theme === "dark" ? dark : light;
	}, [props.theme, themeStyle]);

	useEffect(() => {
		const term = termRef.current;
		if (!term || !props.fontSize) return undefined;
		term.options.fontSize = props.fontSize;
		fitRef.current?.();
		const timer = window.setTimeout(() => fitRef.current?.(), 50);
		return () => window.clearTimeout(timer);
	}, [props.fontSize]);

	useEffect(() => {
		const shell = shellRef.current;
		const host = hostRef.current;
		if (!shell || !host) return undefined;
		let reportedFocused = false;
		const reportFocused = (focused: boolean) => {
			const next = focused && Boolean(callbacksRef.current.onChangeFontSize);
			if (next === reportedFocused) return;
			reportedFocused = next;
			aoBridge.terminal.setFocused(next);
		};
		const handleFocusIn = () => reportFocused(true);
		const handleFocusOut = (event: FocusEvent) => {
			const next = event.relatedTarget;
			if (next instanceof Node && host.contains(next)) return;
			reportFocused(false);
		};
		host.addEventListener("focusin", handleFocusIn);
		host.addEventListener("focusout", handleFocusOut);
		const disposeFontSizeShortcut = aoBridge.terminal.onFontSizeShortcut((delta) => {
			if (!terminalHasFocus(host)) return;
			callbacksRef.current.onChangeFontSize?.(delta);
		});
		const activateLink = (event: MouseEvent, uri: string) => {
			// Left-click on a web link opens it inside the AO Browser panel (the
			// parent decides how). Non-web schemes (mailto:, etc.) still go to the OS
			// via the main process's window-open handler. Right-click to open a web
			// link in the system browser instead — see the context menu below.
			if (isWebLink(uri)) {
				if (event.altKey) {
					void openLinkInSystemBrowser(uri);
					return;
				}
				callbacksRef.current.onLinkOpen?.(uri);
				return;
			}
			window.open(uri, "_blank", "noopener");
		};
		const trackHover = (_event: MouseEvent, uri: string) => {
			hoveredLinkRef.current = isWebLink(uri) ? uri : null;
		};
		const clearHover = () => {
			hoveredLinkRef.current = null;
		};

		let term: Terminal;
		try {
			const { dark, light } = buildTerminalThemes();
			term = new Terminal({
				// Required for the Unicode 11 width addon below.
				allowProposedApi: true,
				cursorBlink: true,
				// Resolve the Nerd Font stack from --font-mono (styles.css) at
				// construction so terminal glyphs follow the app's font tokens. The
				// box-drawing grid is rasterized by the WebGL/canvas renderer itself,
				// but powerline separators and file-type icons are real PUA codepoints
				// that must come from a system-installed Nerd Font.
				fontFamily:
					getComputedStyle(shell).getPropertyValue("--font-mono").trim() ||
					'ui-monospace, Menlo, Monaco, "Courier New", monospace',
				fontSize: props.fontSize ?? TERMINAL_FONT_SIZE_DEFAULT,
				lineHeight: 1.35,
				scrollbar: { showScrollbar: false },
				linkHandler: { activate: activateLink, hover: trackHover, leave: clearHover },
				// Preserve standard terminal semantics: many agent TUIs use bold ANSI
				// colors specifically to select the bright palette.
				drawBoldTextInBrightColors: true,
				// Agent TUIs already choose foreground/background pairs. A forced
				// contrast transform changes their RGB values and makes syntax and diff
				// colors diverge from the same CLI in a native terminal.
				minimumContrastRatio: 1,
				// Alt-buffer panes (tmux attach, mouse-tracking agent TUIs) never feed
				// this buffer — the alt screen doesn't accumulate scrollback — so this
				// only matters for normal-buffer panes that print their transcript and
				// rely on the terminal's scrollback (codex, a plain shell). Keep it > 0
				// so that history survives to be scrolled locally (see the wheel
				// handler's normal-buffer branch). The scrollbar itself is hidden in
				// CSS; its matching FitAddon reservation is removed after open() below.
				scrollback: 5000,
				theme: props.theme === "dark" ? dark : light,
			});
		} catch (error) {
			callbacksRef.current.onError?.(error);
			return undefined;
		}

		termRef.current = term;

		const fit = new FitAddon();
		term.loadAddon(fit);
		const unicode = new Unicode11Addon();
		term.loadAddon(unicode);
		term.unicode.activeVersion = "11";
		// Open plain and OSC 8 links in the OS browser. The default handlers call
		// window.open() with no URL and then assigns location.href, but the
		// Electron main process denies every window.open and only forwards the URL
		// passed to it (main.ts setWindowOpenHandler), so the default handlers'
		// empty open is dropped and clicks silently no-op. Pass the matched URL to
		// window.open directly so the main process routes it to shell.openExternal.
		term.loadAddon(new WebLinksAddon(activateLink, { hover: trackHover, leave: clearHover }));
		term.loadAddon(new SearchAddon());

		term.open(host);
		// Browser integration tests need to wait on xterm's buffer state, not
		// infer it from a hidden viewport element whose scrollTop can lag.
		// Vite removes this development-only seam from packaged builds.
		if (import.meta.env.DEV) {
			(host as DevXtermHost).__aoXtermForTest = term;
		}
		loadRenderer(term);
		term.options.macOptionClickForcesSelection = true;
		forceSelectionMode(term);

		let lastCopiedSelection = "";
		const copySelection = (options?: { clipboardData?: DataTransfer | null; dedupe?: boolean }) => {
			const selection = term.getSelection();
			if (!selection || (options?.dedupe && selection === lastCopiedSelection)) return false;
			options?.clipboardData?.setData("text/plain", selection);
			void aoBridge.clipboard
				.writeText(selection)
				.then(() => {
					lastCopiedSelection = selection;
					showCopiedToastRef.current();
				})
				.catch((error) => {
					console.warn("Unable to copy terminal selection", error);
				});
			return true;
		};
		const clearCopiedSelection = () => {
			lastCopiedSelection = "";
		};
		const userInputListeners = new Set<(data: string, source: TerminalUserInputSource) => void>();
		const emitUserInput = (data: string, source: TerminalUserInputSource) => {
			if (data.length === 0) return;
			userInputListeners.forEach((listener) => listener(data, source));
		};
		const pasteText = (text: string) => {
			const prepared = preparePastedText(text);
			const bracketed = term.modes.bracketedPasteMode && term.options.ignoreBracketedPasteMode !== true;
			emitUserInput(bracketPastedText(prepared, bracketed), "paste");
		};
		let suppressNextNativePaste = false;
		let suppressPasteTimer: number | null = null;
		const clearSuppressNativePaste = () => {
			suppressNextNativePaste = false;
			if (suppressPasteTimer !== null) {
				window.clearTimeout(suppressPasteTimer);
				suppressPasteTimer = null;
			}
		};
		const suppressNativePasteOnce = () => {
			suppressNextNativePaste = true;
			if (suppressPasteTimer !== null) window.clearTimeout(suppressPasteTimer);
			suppressPasteTimer = window.setTimeout(clearSuppressNativePaste, SUPPRESS_NATIVE_PASTE_MS);
		};
		const pasteFromClipboard = () => {
			void aoBridge.clipboard
				.readText()
				.then(pasteText)
				.catch((error) => {
					console.warn("Unable to paste terminal clipboard text", error);
				});
		};
		const focusTerminal = () => {
			try {
				term.focus();
			} catch {
				// Terminal is being torn down or its hidden textarea is unavailable.
			}
		};
		contextMenuActionsRef.current = {
			copy: () => {
				copySelection();
				focusTerminal();
			},
			paste: () => {
				pasteFromClipboard();
				focusTerminal();
			},
			selectAll: () => {
				term.selectAll();
				focusTerminal();
			},
		};
		const openContextMenu = (event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			setContextMenu({
				canCopy: term.hasSelection(),
				open: true,
				x: event.clientX,
				y: event.clientY,
				link: hoveredLinkRef.current,
			});
		};
		shell.addEventListener("contextmenu", openContextMenu);
		term.attachCustomKeyEventHandler((event) => {
			// xterm invokes this same handler on keydown, keyup, AND keypress (see
			// Terminal.ts _keyDown/_keyUp/_keyPress). Only keydown should trigger our
			// shortcut actions (copy/paste/word-nav) — otherwise releasing the key
			// re-matches the same combo and fires the action a second time (double
			// paste, double word-delete, etc). keyup/keypress fall through to
			// xterm's own default handling for that event type.
			if (event.type === "keyup" || event.type === "keypress") return true;
			// Shift+Enter → newline without submitting, matching Claude Code / Codex.
			// A terminal normally sends the same CR for Enter and Shift+Enter, so the
			// agent can't distinguish them; emit the meta-return (ESC+CR) that
			// readline/Ink-based TUIs interpret as "insert a newline" rather than
			// "submit". Plain Enter still falls through to xterm's default CR.
			//
			// SCOPE: this meta-return is applied to every pane intentionally for now.
			// It is correct for agent TUIs but untested and unintended for plain login
			// shells, where ESC+CR is not a "newline" affordance. The correct fix is to
			// scope it by pane kind — TerminalPane already branches on
			// `terminalTarget?.kind === "shell"` at the XtermTerminal call site — once
			// this branch is rebased onto main, which brings that discriminator (and
			// ShellTerminalsView) that does not yet exist here. Until then the behavior
			// is left unchanged and the emitted bytes are identical for all panes.
			if (event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
				consumeTerminalShortcut(event);
				emitUserInput("\x1b\r", "keyboard");
				return false;
			}
			const fontSizeDelta = terminalFontSizeDelta(event);
			if (fontSizeDelta !== 0 && callbacksRef.current.onChangeFontSize) {
				consumeTerminalShortcut(event);
				callbacksRef.current.onChangeFontSize(fontSizeDelta);
				return false;
			}
			if (isTerminalCopyShortcut(event)) {
				if (copySelection()) {
					consumeTerminalShortcut(event);
					return false;
				}
				if ((event.ctrlKey && event.shiftKey) || (event.key === "Insert" && event.ctrlKey)) {
					consumeTerminalShortcut(event);
					return false;
				}
				return true;
			}
			if (isTerminalPasteShortcut(event)) {
				consumeTerminalShortcut(event);
				suppressNativePasteOnce();
				pasteFromClipboard();
				return false;
			}
			const normalized = normalizedTerminalShortcut(event);
			if (!normalized) return true;
			consumeTerminalShortcut(event);
			emitUserInput(normalized, "shortcut");
			return false;
		});
		const copyInput = (event: ClipboardEvent) => {
			if (!copySelection({ clipboardData: event.clipboardData })) return;
			event.preventDefault();
		};
		const copyShortcut = (event: KeyboardEvent) => {
			if (!isTerminalCopyShortcut(event) || !terminalHasFocus(shell) || !copySelection()) return;
			event.preventDefault();
			event.stopPropagation();
		};
		shell.addEventListener("copy", copyInput);
		window.addEventListener("keydown", copyShortcut, true);
		const selectionChange = term.onSelectionChange(() => {
			if (!term.hasSelection()) {
				clearCopiedSelection();
				return;
			}
			window.setTimeout(() => copySelection({ dedupe: true }), 0);
		});

		const fitTerminal = () => {
			// Parked terminals keep their last measured box and continue parsing
			// output, but must not refit or emit PTY resizes while hidden.
			if (callbacksRef.current.isVisible === false) return;
			try {
				const before = `${term.cols}x${term.rows}`;
				fit.fit();
				// Sync render ONLY when the grid actually changed: that is the only
				// case where the canvas was resized (and cleared). Forcing a full
				// synchronous viewport render on every no-op fit doubles render work
				// on every observed frame of a drag — measurable lag on iGPUs.
				if (`${term.cols}x${term.rows}` !== before) {
					diag(`fit ${before} -> ${term.cols}x${term.rows}`);
				}
			} catch {
				// Container momentarily has no size (hidden/unmounting) — a later
				// trigger retries.
			}
		};
		// VS Code's TerminalResizeDebouncer semantics, verbatim thresholds:
		// - Normal buffer under 200 lines → resizing is CHEAP (an alt-screen agent
		//   TUI never grows the normal buffer), so fit fully live on every observed
		//   frame. This is why VS Code's terminal tracks a splitter drag smoothly —
		//   the grid follows the pane in the same frame, no freeze and no snap.
		// - Normal buffer at/over 200 lines → the column reflow rewraps all of
		//   scrollback, so rows still apply live but columns wait for a 100ms quiet
		//   window (flushed early on pointer release).
		// xterm 6.1 renders synchronously after each geometry change, preventing the
		// blank canvas frame from xterm.js#4922 (fixed upstream by #5529).
		const CHEAP_RESIZE_NORMAL_BUFFER_LINES = 200;
		const FIT_QUIET_MS = 100;
		// Hidden activation must reveal promptly even if its slot never goes quiet.
		const FIT_HIDDEN_CAP_MS = 500;
		let fitQuietTimer: ReturnType<typeof setTimeout> | null = null;
		let fitCapTimer: ReturnType<typeof setTimeout> | null = null;
		let fitAllowsHidden = false;
		let disposed = false;
		const fitSettledListeners = new Set<() => void>();
		const flushScheduledFit = () => {
			if (disposed) return;
			if (fitQuietTimer !== null) {
				clearTimeout(fitQuietTimer);
				fitQuietTimer = null;
			}
			if (fitCapTimer !== null) {
				clearTimeout(fitCapTimer);
				fitCapTimer = null;
			}
			if (fitAllowsHidden || callbacksRef.current.isVisible !== false) {
				try {
					const before = `${term.cols}x${term.rows}`;
					fit.fit();
					if (`${term.cols}x${term.rows}` !== before) {
						diag(`debounced-fit ${before} -> ${term.cols}x${term.rows} hidden=${fitAllowsHidden}`);
					}
				} catch {
					// The next observer/window event retries if the host is transiently
					// unmeasurable (for example while entering fullscreen).
				}
			}
			fitAllowsHidden = false;
			for (const listener of [...fitSettledListeners]) listener();
			fitSettledListeners.clear();
		};
		const scheduleStableFit = (allowHidden = false, onSettled?: () => void) => {
			if (disposed) return;
			if (!allowHidden && callbacksRef.current.isVisible === false) return;
			fitAllowsHidden ||= allowHidden;
			if (onSettled) fitSettledListeners.add(onSettled);
			if (fitQuietTimer !== null) clearTimeout(fitQuietTimer);
			fitQuietTimer = setTimeout(flushScheduledFit, FIT_QUIET_MS);
			if (fitAllowsHidden && fitCapTimer === null) {
				fitCapTimer = setTimeout(flushScheduledFit, FIT_HIDDEN_CAP_MS);
			}
		};
		// Rows never rewrap the buffer, so they track the drag live even when the
		// column reflow is being debounced.
		const applyLiveRowResize = () => {
			if (callbacksRef.current.isVisible === false) return;
			const proposed = fit.proposeDimensions();
			if (!proposed || !proposed.cols || !proposed.rows) return;
			if (proposed.rows !== term.rows) {
				term.resize(term.cols, proposed.rows);
			}
		};
		// While activation preparation is pending, observer/window events must keep
		// extending the same quiet window even though the container is intentionally
		// hidden behind the cover. A normally parked terminal still ignores them.
		const scheduleVisibleFit = () => {
			if (fitAllowsHidden) {
				scheduleStableFit(true);
				return;
			}
			if (term.buffer.normal.length < CHEAP_RESIZE_NORMAL_BUFFER_LINES) {
				if (fitQuietTimer !== null) {
					clearTimeout(fitQuietTimer);
					fitQuietTimer = null;
				}
				fitTerminal();
				return;
			}
			applyLiveRowResize();
			scheduleStableFit(false);
		};
		fitRef.current = scheduleVisibleFit;
		// A separator drag ends on pointer release, not on a quiet box: collapse the
		// remaining quiet window so the single reflow lands on the same gesture. An
		// activation window (fitAllowsHidden) is left alone — it must still reveal
		// only after the cache has finished preparing the real slot.
		const flushFitOnPointerRelease = () => {
			if (fitAllowsHidden || fitQuietTimer === null) return;
			flushScheduledFit();
		};
		window.addEventListener("pointerup", flushFitOnPointerRelease, true);
		window.addEventListener("pointercancel", flushFitOnPointerRelease, true);

		const raf = requestAnimationFrame(fitTerminal);
		// 50/250ms catch the common settle; 600/1200ms are a session-bounded
		// backstop. By 600ms the font metrics are unambiguously stable, so even if
		// the convergence loop below detached at a briefly-stable
		// wrong measurement, this re-measures the real cell box and corrects,
		// firing the PTY resize that makes the pane repaint cleanly (clearing
		// any ghost frame). fit() is idempotent: a no-op when the grid is already
		// right, so a correct terminal never reflows.
		const settleTimers = [50, 250, 600, 1200].map((ms) => window.setTimeout(scheduleVisibleFit, ms));
		if (document.fonts?.ready) {
			void document.fonts.ready.then(() => scheduleStableFit());
		}
		const observer = new ResizeObserver(scheduleVisibleFit);
		observer.observe(host);

		// Recovery re-fit that does NOT depend on the host box changing size.
		//
		// FitAddon derives the grid by dividing the pane box by the renderer's
		// measured cell box. That box is measured asynchronously: the monospace
		// font's real metrics resolve a frame or more after open(), so the early fits
		// above can divide by a
		// not-yet-final cell box, mis-count cols/rows, and clip the grid inside the
		// pane. The fixed settle window (rAF, timeouts, fonts.ready) may all run
		// before the cell box is final, and the ResizeObserver never fires to
		// correct it because the host's pixel box is a stable height:100%, so a
		// wrong grid would otherwise freeze for the whole session.
		//
		// onRender fires on every renderer repaint, including the repaint after
		// the metrics settle. Each fire re-proposes dimensions from the *current*
		// measured cell box. Crucially we never re-fit straight off a single
		// frame's proposal: font or DPI settling can emit a one-frame transient cell
		// box (e.g. a doubled box on a HiDPI display) that halves the grid,
		// and committing it would lock the terminal at half size and detach (the
		// #313 ghost). So a differing proposal must REPEAT identically across two
		// consecutive renders — proving the measurement settled — before we apply
		// it. proposeDimensions returns undefined until the cell box is non-zero,
		// so a fit is never accepted from an unmeasured cell. Once the proposal
		// holds at the live grid for a few frames (or a hard re-fit cap is hit) the
		// listener detaches, so steady-state content renders cost nothing.
		const STABLE_FRAMES_TARGET = 3;
		const MAX_REFITS = 20;
		let stableFrames = 0;
		let refits = 0;
		let pending: { cols: number; rows: number } | null = null;
		const stabilizer = term.onRender(() => {
			// A scheduled fit already owns the geometry. Without this the mid-drag
			// pause between two pointer frames looks like a settled measurement, and
			// this listener commits a reflow the debounce was deliberately holding —
			// two geometry owners fighting, which is the churn we are removing.
			if (fitQuietTimer !== null || fitCapTimer !== null) {
				pending = null;
				stableFrames = 0;
				return;
			}
			const proposed = fit.proposeDimensions();
			if (!proposed || !proposed.cols || !proposed.rows) return;
			if (proposed.cols !== term.cols || proposed.rows !== term.rows) {
				stableFrames = 0;
				// Only act once the same differing proposal repeats — a single-frame
				// transient never gets committed, it just updates `pending`.
				if (pending && pending.cols === proposed.cols && pending.rows === proposed.rows) {
					pending = null;
					if (refits++ >= MAX_REFITS) {
						stabilizer.dispose();
						return;
					}
					fitTerminal();
					return;
				}
				pending = { cols: proposed.cols, rows: proposed.rows };
				return;
			}
			pending = null;
			if (++stableFrames >= STABLE_FRAMES_TARGET) stabilizer.dispose();
		});

		// OS window resize and monitor/DPR changes also alter the true cell box
		// without touching the host's height:100% box, so the ResizeObserver above
		// misses them. Listen on window directly as a session-long recovery path.
		window.addEventListener("resize", scheduleVisibleFit);

		// Do not replace this with term.onData. xterm's raw data stream can include
		// terminal-generated control responses during attach/repaint; forwarding
		// those bytes through the mux writes dirty input into the real Codex PTY and
		// corrupts the TUI. Keyboard is the only safe generic text path here; paste,
		// composition, shortcuts, and wheel reports are emitted explicitly below.
		const keyInput = term.onKey(({ key }) => emitUserInput(key, "keyboard"));

		// Translate wheel motion into SGR wheel reports for the pane (see
		// sgrWheelReport), one report per scrolled line. WheelEvent.deltaMode
		// varies by platform/device: trackpads and normalized wheels report
		// pixels (mode 0, the macOS case), while many Linux/Windows mouse wheels
		// report whole lines (mode 1) or pages (mode 2). Mirror xterm's native
		// getLinesScrolled across all three so scroll works everywhere; pixel
		// deltas accumulate so a full cell-height emits one line. Returning false
		// suppresses xterm's arrow-key wheel fallback. Ctrl/Cmd wheel is the
		// font-size zoom (CenterPane), so leave it for that handler.
		let wheelAccumPx = 0;
		term.attachCustomWheelEventHandler((event) => {
			if (event.ctrlKey || event.metaKey) return false;
			let lines: number;
			if (event.deltaMode === 1 /* DOM_DELTA_LINE */) {
				lines = Math.trunc(event.deltaY) || Math.sign(event.deltaY);
			} else if (event.deltaMode === 2 /* DOM_DELTA_PAGE */) {
				lines = (Math.trunc(event.deltaY) || Math.sign(event.deltaY)) * term.rows;
			} else {
				const rowHeight = (term.options.fontSize ?? TERMINAL_FONT_SIZE_DEFAULT) * (term.options.lineHeight ?? 1);
				wheelAccumPx += event.deltaY;
				lines = Math.trunc(wheelAccumPx / rowHeight);
				wheelAccumPx -= lines * rowHeight;
			}
			if (lines === 0) return false;
			// A full-screen TUI that keeps its own transcript and scrolls it only by
			// keyboard (opencode) ignores wheel/mouse reports on every platform; route
			// its wheel to page keys. Kept first so opencode is unaffected by the
			// buffer-aware paths below.
			if (callbacksRef.current.paneScrollsByKeyboard) {
				emitUserInput(pageKeyReport(lines), "wheel");
				return false;
			}
			// A normal-buffer pane with mouse tracking off (codex, a plain shell)
			// prints its transcript and relies on the terminal's own scrollback — the
			// way it scrolls in a raw terminal. Scroll xterm's viewport locally; the
			// pane never sees these bytes. Requires scrollback > 0 (see Terminal opts).
			if (term.modes.mouseTrackingMode === "none" && term.buffer.active.type === "normal") {
				term.scrollLines(lines);
				return false;
			}
			// Mouse tracking on: the pane (tmux/zellij copy-mode, or any app that
			// tracks the mouse) acts on SGR wheel reports. On Windows conpty this
			// reaches the app directly; under a mux it drives copy-mode.
			if (term.modes.mouseTrackingMode !== "none") {
				const button = lines < 0 ? SGR_WHEEL_UP : SGR_WHEEL_DOWN;
				emitUserInput(sgrWheelReport(button, Math.abs(lines)), "wheel");
				return false;
			}
			// Alt-buffer pane with mouse tracking off and no keyboard-scroll hint:
			// no scrollback to move locally, so fall back to page keys.
			emitUserInput(pageKeyReport(lines), "wheel");
			return false;
		});
		const pasteInput = (event: ClipboardEvent) => {
			event.preventDefault();
			event.stopPropagation();
			if (suppressNextNativePaste) {
				clearSuppressNativePaste();
				return;
			}
			const text = event.clipboardData?.getData("text/plain") ?? "";
			pasteText(text);
		};
		const compositionInput = (event: CompositionEvent) => {
			emitUserInput(event.data, "composition");
		};
		shell.addEventListener("paste", pasteInput, true);
		shell.addEventListener("compositionend", compositionInput, true);

		// A file dropped on the pane inserts its path, mirroring a native terminal
		// so an agent (e.g. Claude Code) attaches it. The sandboxed renderer cannot
		// read a dropped file's original path on macOS, so the bytes are stashed to
		// a temp file by the main process and that path is inserted instead.
		const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
		const dragOverInput = (event: DragEvent) => {
			if (!isFileDrag(event)) return;
			event.preventDefault();
			if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
		};
		// A dropped folder is the app-wide "open as project" gesture (see
		// _shell.tsx's window-level drop handler), not a file to attach. Let it
		// bubble untouched — swallowing it here (preventDefault/stopPropagation)
		// would silently absorb the drop into this file-attach flow instead.
		const isDirectoryDrag = (event: DragEvent) =>
			event.dataTransfer?.items?.[0]?.webkitGetAsEntry?.()?.isDirectory ?? false;
		const dropInput = (event: DragEvent) => {
			if (isDirectoryDrag(event)) return;
			const files = Array.from(event.dataTransfer?.files ?? []);
			if (files.length === 0) return;
			event.preventDefault();
			// Deliberately no stopPropagation: _shell.tsx's window-level listener
			// still needs this drop to reset its drag-depth counter (bumped by the
			// dragenter that already bubbled past this host, unseen by this
			// handler), or the next folder drag inherits a stale nonzero depth and
			// never shows the overlay.
			void (async () => {
				const paths: string[] = [];
				for (const file of files) {
					try {
						const bytes = new Uint8Array(await file.arrayBuffer());
						const saved = await aoBridge.terminal.saveDroppedFile({ name: file.name, bytes });
						if (saved) paths.push(saved);
					} catch (error) {
						console.warn("Unable to attach dropped file", error);
					}
				}
				if (paths.length === 0) return;
				pasteText(`${paths.map((p) => (/\s/.test(p) ? `'${p}'` : p)).join(" ")} `);
			})();
		};
		shell.addEventListener("dragover", dragOverInput);
		shell.addEventListener("drop", dropInput);

		const showLatestOutput = () => {
			term.scrollToBottom();
			// Hidden output can leave the offscreen DOM scrollbar stale even
			// after xterm's logical viewport moves. Synchronize it before either
			// the first-load cover or retained-cache container is revealed.
			const viewport = host.querySelector<HTMLElement>(".xterm-viewport");
			if (!viewport) return;
			viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
		};

		let cancelActivationPreparation: (() => void) | null = null;
		const prepareForActivation = (): Promise<void> => {
			diag("prepareForActivation (pane hidden behind cover)");
			cancelActivationPreparation?.();
			return new Promise((resolve) => {
				let firstFrame: number | null = null;
				let paintFrame: number | null = null;
				let finished = false;
				const finish = () => {
					if (finished) return;
					finished = true;
					if (firstFrame !== null) cancelAnimationFrame(firstFrame);
					if (paintFrame !== null) cancelAnimationFrame(paintFrame);
					if (cancelActivationPreparation === finish) cancelActivationPreparation = null;
					resolve();
				};
				cancelActivationPreparation = finish;

				const finishAcrossPaintFrames = () => {
					if (finished) return;
					showLatestOutput();
					firstFrame = requestAnimationFrame(() => {
						firstFrame = null;
						// Reconcile after the settled fit, then remain hidden through a
						// second frame so Chromium composites the final viewport.
						showLatestOutput();
						paintFrame = requestAnimationFrame(() => {
							paintFrame = null;
							finish();
						});
					});
				};
				// The container is in its real slot but remains hidden. Wait for its
				// dimensions to settle (including fullscreen/sidebar transitions), fit
				// once, and avoid the old unconditional full-grid refresh.
				scheduleStableFit(true, finishAcrossPaintFrames);
			});
		};

		// Live cols/rows getters: the owner reads the current grid at attach time,
		// not a snapshot taken at ready time (the first fit may not have run yet).
		const handle: AttachableTerminal = {
			get cols() {
				return term.cols;
			},
			get rows() {
				return term.rows;
			},
			// Forward xterm's write callback: it fires once THIS chunk has been
			// parsed into the buffer, which is what lets the attachment reveal the
			// pane at the replay's settled scroll position (issue #3160).
			write: (data, done) => term.write(data, done),
			writeln: (line) => term.writeln(line),
			showLatestOutput,
			prepareForActivation,
			onUserInput: (listener) => {
				userInputListeners.add(listener);
				return { dispose: () => userInputListeners.delete(listener) };
			},
			onResize: (listener) => term.onResize(listener),
		};
		callbacksRef.current.onReady?.(handle);

		return () => {
			disposed = true;
			if (reportedFocused) aoBridge.terminal.setFocused(false);
			disposeFontSizeShortcut();
			host.removeEventListener("focusin", handleFocusIn);
			host.removeEventListener("focusout", handleFocusOut);
			delete (host as DevXtermHost).__aoXtermForTest;
			termRef.current = null;
			fitRef.current = null;
			cancelAnimationFrame(raf);
			for (const timer of settleTimers) window.clearTimeout(timer);
			if (fitQuietTimer !== null) clearTimeout(fitQuietTimer);
			if (fitCapTimer !== null) clearTimeout(fitCapTimer);
			fitSettledListeners.clear();
			observer.disconnect();
			stabilizer.dispose();
			window.removeEventListener("resize", scheduleVisibleFit);
			window.removeEventListener("pointerup", flushFitOnPointerRelease, true);
			window.removeEventListener("pointercancel", flushFitOnPointerRelease, true);
			shell.removeEventListener("copy", copyInput);
			window.removeEventListener("keydown", copyShortcut, true);
			selectionChange.dispose();
			shell.removeEventListener("contextmenu", openContextMenu);
			shell.removeEventListener("paste", pasteInput, true);
			shell.removeEventListener("compositionend", compositionInput, true);
			shell.removeEventListener("dragover", dragOverInput);
			shell.removeEventListener("drop", dropInput);
			contextMenuActionsRef.current = null;
			cancelActivationPreparation?.();
			clearSuppressNativePaste();
			keyInput.dispose();
			userInputListeners.clear();
			try {
				term.dispose();
			} catch {
				// Some renderer addons can throw during dispose in certain GPU
				// environments; the terminal is being torn down regardless.
			}
		};
	}, []);

	useEffect(() => {
		if (!props.focusRequested || props.isVisible === false) return undefined;
		try {
			termRef.current?.focus();
		} catch {
			// The retained terminal may have been parked during this effect.
		}
		return undefined;
	}, [props.focusRequested, props.isVisible]);

	useLayoutEffect(() => {
		if (props.isVisible === false) {
			setContextMenuOpen(false);
			setCopiedToast(false);
			if (copiedToastTimerRef.current !== undefined) {
				window.clearTimeout(copiedToastTimerRef.current);
				copiedToastTimerRef.current = undefined;
			}
		}
	}, [props.isVisible, setContextMenuOpen]);

	const wasVisibleRef = useRef(props.isVisible !== false);
	useEffect(() => {
		const visible = props.isVisible !== false;
		const becameVisible = visible && !wasVisibleRef.current;
		wasVisibleRef.current = visible;
		if (!becameVisible) return;
		// Activation preparation already fitted the terminal after the slot became
		// stable. Publish that grid without fitting a second time after reveal.
		const term = termRef.current;
		if (term) callbacksRef.current.onVisibleSize?.(term.cols, term.rows);
	}, [props.isVisible]);

	const fullscreenElement = document.fullscreenElement;
	const contextMenuPortalContainer =
		props.isFullscreen &&
		fullscreenElement instanceof HTMLElement &&
		hostRef.current &&
		fullscreenElement.contains(hostRef.current)
			? fullscreenElement
			: undefined;

	return (
		<>
			<div
				ref={shellRef}
				aria-label={props.ariaLabel}
				className={props.className}
				style={{
					height: "100%",
					overflow: "hidden",
					position: "relative",
					width: "100%",
				}}
			>
				<div
					ref={hostRef}
					style={{
						backgroundColor: "var(--color-bg-terminal-opaque)",
						height: "100%",
						overflow: "hidden",
						width: "100%",
					}}
				/>
				{copiedToast && props.isVisible !== false ? (
					<div
						aria-live="polite"
						className="pointer-events-none absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-md border border-[var(--color-border-import-modal)] bg-[var(--color-bg-import-modal)] px-3 py-1.5 text-xs text-[var(--color-text-import-title)] shadow-[var(--shadow-import-modal)]"
						role="status"
					>
						{t("terminal.copiedToClipboard")}
					</div>
				) : null}
			</div>
			<DropdownMenu modal={false} open={contextMenu.open} onOpenChange={setContextMenuOpen}>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						aria-hidden="true"
						tabIndex={-1}
						style={{
							border: 0,
							height: 0,
							left: contextMenu.x,
							opacity: 0,
							padding: 0,
							pointerEvents: "none",
							position: "fixed",
							top: contextMenu.y,
							width: 0,
						}}
					/>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="start"
					className="min-w-36"
					onCloseAutoFocus={(event) => event.preventDefault()}
					portalContainer={contextMenuPortalContainer}
					side="right"
					sideOffset={2}
				>
					{contextMenu.link ? (
						<>
							<DropdownMenuItem
								onSelect={() => {
									const { link } = contextMenu;
									setContextMenuOpen(false);
									if (link) void aoBridge.app.openExternal(link);
								}}
							>
								{t("terminal.openSystemBrowser")}
							</DropdownMenuItem>
							<DropdownMenuSeparator />
						</>
					) : null}
					<DropdownMenuItem disabled={!contextMenu.canCopy} onSelect={() => runContextMenuAction("copy")}>
						{t("titlebar.copy")}
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => runContextMenuAction("paste")}>{t("titlebar.paste")}</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => runContextMenuAction("selectAll")}>{t("titlebar.selectAll")}</DropdownMenuItem>
					{props.onToggleFullscreen ? (
						<DropdownMenuItem
							onSelect={() => {
								setContextMenuOpen(false);
								callbacksRef.current.onToggleFullscreen?.();
							}}
						>
							{props.isFullscreen ? t("terminal.exitFullscreen") : t("terminal.fullscreen")}
						</DropdownMenuItem>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
		</>
	);
}
