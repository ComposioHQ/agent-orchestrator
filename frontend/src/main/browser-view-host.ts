import type {
	IpcMain,
	IpcMainEvent,
	IpcMainInvokeEvent,
	DownloadItem,
	NativeImage,
	Rectangle,
	Session,
	View,
	WebContents,
	WebFrameMain,
} from "electron";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
	BrowserAnnotationCancelPayload,
	BrowserAnnotationModeInput,
	BrowserAnnotationPageCancelPayload,
	BrowserAnnotationPageSubmitPayload,
	BrowserAnnotationSubmitPayload,
} from "../shared/browser-annotations";
import { attachAppShortcuts } from "./app-shortcuts";
import type { KeybindingOverrides } from "../shared/shortcuts";

export type BrowserRect = Pick<Rectangle, "x" | "y" | "width" | "height">;

export type BrowserNavState = {
	viewId: string;
	url: string;
	title: string;
	canGoBack: boolean;
	canGoForward: boolean;
	isLoading: boolean;
	error?: string;
};

export type BrowserTabState = {
	id: string;
	url: string;
	title: string;
	active: boolean;
};

export type BrowserTabsState = {
	viewId: string;
	activeTabId: string;
	tabs: BrowserTabState[];
	change?: {
		kind: "opened" | "popup" | "selected" | "closed";
		tabId: string;
	};
};

export type BrowserAgentActivityState = {
	viewId: string;
	active: boolean;
	action: string;
	phase?: "started" | "finished";
	commandId?: string;
};

type BrowserBoundsInput = {
	viewId: string;
	rect: BrowserRect;
	visible: boolean;
	parked?: boolean;
};

type BrowserNavigateInput = {
	viewId: string;
	url: string;
};

type BrowserTabInput = {
	viewId: string;
	tabId: string;
};

type BrowserWebContents = Pick<
	WebContents,
	| "id"
	| "canGoBack"
	| "canGoForward"
	| "capturePage"
	| "clearHistory"
	| "debugger"
	| "mainFrame"
	| "getTitle"
	| "getURL"
	| "goBack"
	| "goForward"
	| "isLoading"
	| "loadURL"
	| "on"
	| "reload"
	| "send"
	| "setWindowOpenHandler"
	| "stop"
> & {
	close?: () => void;
	session?: Pick<Session, "setPermissionCheckHandler" | "setPermissionRequestHandler"> &
		Partial<Pick<Session, "on">>;
};

type BrowserViewLike = View & {
	webContents: BrowserWebContents;
	setBounds: (bounds: BrowserRect) => void;
	setBorderRadius?: (radius: number) => void;
	setVisible?: (visible: boolean) => void;
};

type BrowserWindowLike = {
	contentView: {
		addChildView: (view: BrowserViewLike) => void;
		removeChildView?: (view: BrowserViewLike) => void;
	};
	getContentBounds: () => BrowserRect;
	webContents: Pick<WebContents, "focus" | "id" | "send"> & {
		session?: Pick<Session, "setDisplayMediaRequestHandler">;
	};
	isDestroyed?: () => boolean;
};

type ShellLike = {
	openExternal: (url: string) => Promise<void>;
};

type WebContentsViewConstructor = new (options: { webPreferences: Electron.WebPreferences }) => BrowserViewLike;

export type BrowserViewHostOptions = {
	mainWindow: BrowserWindowLike;
	ipcMain: Pick<IpcMain, "handle" | "on" | "removeHandler" | "off">;
	shell: ShellLike;
	WebContentsView: WebContentsViewConstructor;
	annotatePreloadPath: string;
	rendererOrigin: string;
	// Platform flag for application shortcuts forwarded from each preview view
	// to the shell. Defaults to non-mac when omitted (tests).
	isMac?: boolean;
	getKeybindingOverrides?: () => KeybindingOverrides;
	isKeybindingRecording?: () => boolean;
	isCloseShellTerminalShortcutEnabled?: () => boolean;
};

export type BrowserViewHost = {
	dispose: () => void;
	destroy: (viewId: string) => void;
	destroyAll: () => void;
	execute: (sessionId: string, action: string, args?: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
	// webContents of the most recently focused browser panel (or null); the titlebar menu targets it for Edit/Reload/Zoom/DevTools.
	getLastFocusedPanelContents: () => WebContents | null;
	// Drop the remembered panel; call when the shell gains focus for a real reason so a stale panel stops absorbing menu actions.
	forgetLastFocusedPanel: () => void;
};

type BrowserEntry = {
	sessionId: string;
	tabId: string;
	view: BrowserViewLike;
	state: BrowserNavState;
	annotationEnabled: boolean;
	refGeneration: number;
	refs: Map<string, BrowserElementRef>;
	consoleMessages: BrowserLogEntry[];
	errors: BrowserLogEntry[];
	dialog?: { type: string; message: string; defaultPrompt?: string };
	networkCapture?: BrowserNetworkCapture;
};

type BrowserLocator = {
	role?: string;
	name?: string;
	label?: string;
	placeholder?: string;
	text?: string;
	testId?: string;
	css?: string;
	exact?: boolean;
};

type BrowserElementRef = {
	backendNodeId: number;
	generation: number;
	fingerprint: BrowserLocator;
};

type BrowserExpectedState = {
	tabId: string;
	expectedUrl: string;
	snapshotGeneration: number;
};

type BrowserSessionEntry = {
	sessionId: string;
	viewId: string;
	profilePartition: string;
	tabs: Map<string, BrowserEntry>;
	activeTabId: string;
	nextTabNumber: number;
	bounds: BrowserRect;
	visible: boolean;
	parked: boolean;
	networkTabId?: string;
	agentBrowserCommands: number;
	downloads: Array<{ id: string; filename: string; path: string; url: string; state: string }>;
};

type BrowserLogEntry = {
	level: string;
	message: string;
	source?: string;
	line?: number;
	timestamp: string;
};

type BrowserNetworkRequest = {
	id: string;
	method: string;
	url: string;
	resourceType?: string;
	startedAt: string;
	status?: number;
	statusText?: string;
	mimeType?: string;
	durationMs?: number;
	failed?: boolean;
	canceled?: boolean;
	errorText?: string;
	fromCache?: boolean;
	fromServiceWorker?: boolean;
	redirectedTo?: string;
	requestHeaders?: Record<string, string>;
	responseHeaders?: Record<string, string>;
};

type InternalBrowserNetworkRequest = BrowserNetworkRequest & {
	protocolRequestId: string;
	startedMonotonic?: number;
};

type BrowserNetworkCapture = {
	active: boolean;
	tabId: string;
	startedAt: string;
	expiresAt: string;
	stoppedAt?: string;
	stopReason?: string;
	maxEntries: number;
	nextSequence: number;
	requests: InternalBrowserNetworkRequest[];
	byRequestId: Map<string, InternalBrowserNetworkRequest>;
	timer?: ReturnType<typeof setTimeout>;
};

// Hidden targets still need a real viewport for screenshots, responsive
// layout, scrolling, and pointer automation before the panel is first shown.
const OFFSCREEN_BOUNDS: BrowserRect = { x: -10_000, y: -10_000, width: 1280, height: 720 };
const BROWSER_VIEW_BORDER_RADIUS = 8;
const DEFAULT_NETWORK_CAPTURE_SECONDS = 60;
const MAX_NETWORK_CAPTURE_SECONDS = 300;
const MAX_NETWORK_REQUESTS = 200;
const MAX_BROWSER_TABS = 16;
const MAX_EXTERNAL_TEXT_BYTES = 1 << 20;
const MAX_SNAPSHOT_LINES = 1_000;
const MAX_LOG_MESSAGE_CHARS = 16_384;
const UNTRUSTED_BEGIN = "<<<BEGIN UNTRUSTED EXTERNAL CONTENT>>>";
const UNTRUSTED_END = "<<<END UNTRUSTED EXTERNAL CONTENT>>>";
// The human-facing address bar may open local preview files. Agent commands use
// normalizeAgentBrowserURL below, which permits only explicit HTTP(S) targets.
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:"]);

export function normalizeBrowserURL(input: string): URL {
	const raw = input.trim();
	if (raw === "") {
		throw new Error("URL is required");
	}
	const candidate = withDefaultScheme(raw);
	const url = new URL(candidate);
	if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
		throw new Error(`Unsupported browser URL scheme: ${url.protocol}`);
	}
	return url;
}

export function isAllowedBrowserURL(input: string, rendererOrigin?: string): boolean {
	try {
		const url = normalizeBrowserURL(input);
		if (rendererOrigin && url.origin === rendererOrigin) return false;
		return true;
	} catch {
		return false;
	}
}

export function clampBoundsToWindow(
	rect: BrowserRect,
	windowBounds: Pick<BrowserRect, "width" | "height">,
): BrowserRect {
	const rounded = {
		x: Math.round(rect.x),
		y: Math.round(rect.y),
		width: Math.max(0, Math.round(rect.width)),
		height: Math.max(0, Math.round(rect.height)),
	};
	const maxX = Math.max(0, Math.round(windowBounds.width));
	const maxY = Math.max(0, Math.round(windowBounds.height));
	const x = Math.min(Math.max(rounded.x, 0), maxX);
	const y = Math.min(Math.max(rounded.y, 0), maxY);
	return {
		x,
		y,
		width: Math.min(rounded.width, Math.max(0, maxX - x)),
		height: Math.min(rounded.height, Math.max(0, maxY - y)),
	};
}

export function scaleBoundsForZoom(rect: BrowserRect, zoomFactor: number): BrowserRect {
	if (!Number.isFinite(zoomFactor) || zoomFactor <= 0 || zoomFactor === 1) return rect;
	return {
		x: rect.x * zoomFactor,
		y: rect.y * zoomFactor,
		width: rect.width * zoomFactor,
		height: rect.height * zoomFactor,
	};
}

export function createBrowserViewHost(options: BrowserViewHostOptions): BrowserViewHost {
	const entries = new Map<string, BrowserSessionEntry>();
	const viewIdsBySessionId = new Map<string, string>();
	const rendererOwnersByViewId = new Map<string, Set<number>>();
	const tabsByWebContentsId = new Map<number, BrowserEntry>();
	const ipcDisposers: Array<() => void> = [];
	// viewId of the panel that most recently held focus; cleared when it is hidden or destroyed.
	let lastFocusedViewId: string | null = null;
	const forgetIfFocused = (viewId: string): void => {
		if (lastFocusedViewId === viewId) lastFocusedViewId = null;
	};
	const setAgentBrowserActivity = (
		session: BrowserSessionEntry,
		action: string,
		active: boolean,
		commandId?: string,
		phase?: BrowserAgentActivityState["phase"],
	): void => {
		session.agentBrowserCommands = Math.max(0, session.agentBrowserCommands + (active ? 1 : -1));
		options.mainWindow.webContents.send("browser:agentActivity", {
			viewId: session.viewId,
			active: session.agentBrowserCommands > 0,
			action,
			...(phase ? { phase } : {}),
			...(commandId ? { commandId } : {}),
		} satisfies BrowserAgentActivityState);
	};
	const applyBrowserViewBounds = (view: BrowserViewLike, bounds: BrowserRect, visible?: boolean): void => {
		view.setBounds(bounds);
		if (visible !== undefined) view.setVisible?.(visible);
		view.setBorderRadius?.(BROWSER_VIEW_BORDER_RADIUS);
	};
	let pendingMirror: { viewId: string; expires: number; frame: WebFrameMain } | null = null;

	const sameFrame = (a: WebFrameMain, b: WebFrameMain | null | undefined): boolean =>
		Boolean(b) && a.processId === b!.processId && a.routingId === b!.routingId;

	const displayMediaSession = options.mainWindow.webContents.session;
	const mirrorSupported = Boolean(displayMediaSession?.setDisplayMediaRequestHandler);
	if (mirrorSupported) {
		displayMediaSession!.setDisplayMediaRequestHandler((request, callback) => {
			const pending = pendingMirror;
			pendingMirror = null;
			const session =
				pending && pending.expires > Date.now() && sameFrame(pending.frame, request.frame)
					? entries.get(pending.viewId)
					: undefined;
			try {
				if (session) {
					callback({ video: activeEntry(session).view.webContents.mainFrame });
				} else {
					callback({});
				}
			} catch {
				return;
			}
		});
		ipcDisposers.push(() => {
			try {
				displayMediaSession?.setDisplayMediaRequestHandler(null);
			} catch {
				return;
			}
		});
	}

	const createTab = (session: BrowserSessionEntry, activate: boolean): BrowserEntry => {
		if (session.tabs.size >= MAX_BROWSER_TABS) {
			throw browserError("BROWSER_TAB_LIMIT", `Browser tab limit of ${MAX_BROWSER_TABS} reached`);
		}
		const view = new options.WebContentsView({
			webPreferences: {
				contextIsolation: true,
				nodeIntegration: false,
				partition: session.profilePartition,
				preload: options.annotatePreloadPath,
				sandbox: true,
			},
		});
		applyBrowserViewBounds(view, OFFSCREEN_BOUNDS, false);
		options.mainWindow.contentView.addChildView(view);
		view.setBorderRadius?.(BROWSER_VIEW_BORDER_RADIUS);
		view.webContents.session?.setPermissionCheckHandler?.(() => false);
		view.webContents.session?.setPermissionRequestHandler?.((_contents, _permission, callback) => callback(false));

		const tabId = `t${session.nextTabNumber++}`;
		const state: BrowserNavState = emptyNavState(session.viewId);
		const entry: BrowserEntry = {
			sessionId: session.sessionId,
			tabId,
			view,
			state,
			annotationEnabled: false,
			refGeneration: 0,
			refs: new Map(),
			consoleMessages: [],
			errors: [],
		};
		if (session.tabs.size === 0) configureSessionDownloads(view.webContents.session, session);
		session.tabs.set(tabId, entry);
		tabsByWebContentsId.set(view.webContents.id, entry);
		hardenWebContents(view.webContents, options, entry, () => {
			const popup = createTab(session, true);
			pushTabsState(options, session, { kind: "popup", tabId: popup.tabId });
			return popup.view.webContents;
		}, () => session.tabs.size < MAX_BROWSER_TABS);
		wireNavEvents(
			view.webContents,
			options,
			entry,
			() => entries.get(session.viewId)?.activeTabId === entry.tabId,
			() => applySessionBounds(session, entry),
			() => pushTabsState(options, session),
		);
		wireAutomationEvents(view.webContents, entry);
		// The preview is a separate WebContentsView, so renderer-window keydown
		// listeners never see keys typed here. Forward application shortcuts to the
		// shell renderer so they still work with the panel focused.
		attachAppShortcuts(
			view.webContents,
			Boolean(options.isMac),
			options.mainWindow.webContents,
			true,
			options.getKeybindingOverrides,
			options.isKeybindingRecording,
		);
		view.webContents.on("focus", () => {
			lastFocusedViewId = session.viewId;
		});
		if (activate) activateTab(session, tabId, false);
		return entry;
	};

	const ensureSession = (sessionId: string, rendererId?: number): BrowserSessionEntry => {
		const existingViewId = viewIdsBySessionId.get(sessionId);
		const viewId = existingViewId ?? `${rendererId ?? 0}:${sessionId}`;
		let session = entries.get(viewId);
		if (!session) {
			session = {
				sessionId,
				viewId,
				// A non-persist: Electron partition is memory-only. Every tab in
				// this worker shares it, while a fresh worker runtime receives a
				// different partition even if a session ID is ever reused.
				profilePartition: `ao-browser-${randomUUID()}`,
				tabs: new Map(),
				activeTabId: "",
				nextTabNumber: 1,
				bounds: OFFSCREEN_BOUNDS,
				visible: false,
				parked: false,
				agentBrowserCommands: 0,
				downloads: [],
			};
			entries.set(viewId, session);
			viewIdsBySessionId.set(sessionId, viewId);
			createTab(session, true);
		}
		if (rendererId !== undefined) {
			const owners = rendererOwnersByViewId.get(viewId) ?? new Set<number>();
			owners.add(rendererId);
			rendererOwnersByViewId.set(viewId, owners);
		}
		return session;
	};

	const openTab = async (
		session: BrowserSessionEntry,
		url: string | undefined,
		activate: boolean,
		reason: "opened" | "popup" = "opened",
	): Promise<BrowserEntry> => {
		let normalizedURL: string | undefined;
		if (url) {
			const normalized = normalizeBrowserURL(url);
			if (!isAllowedBrowserURL(normalized.href, options.rendererOrigin)) {
				throw browserError("NAVIGATION_FAILED", "Unsupported browser URL");
			}
			normalizedURL = normalized.href;
		}
		const entry = createTab(session, activate);
		if (normalizedURL) {
			const navigation = navigateEntry(entry, normalizedURL);
			pushTabsState(options, session, { kind: reason, tabId: entry.tabId });
			const state = await navigation;
			if (state.error) throw browserError("NAVIGATION_FAILED", state.error);
		} else {
			pushTabsState(options, session, { kind: reason, tabId: entry.tabId });
		}
		return entry;
	};

	function activateTab(session: BrowserSessionEntry, tabId: string, notify = true): BrowserEntry {
		const next = session.tabs.get(tabId);
		if (!next) throw browserError("TAB_NOT_FOUND", `Browser tab ${tabId} does not exist`);
		const previous = session.tabs.get(session.activeTabId);
		if (previous && previous !== next) {
			applyBrowserViewBounds(previous.view, OFFSCREEN_BOUNDS, false);
		}
		session.activeTabId = tabId;
		applySessionBounds(session, next);
		pushNavState(options, next);
		if (notify) pushTabsState(options, session, { kind: "selected", tabId });
		return next;
	}

	function closeTab(session: BrowserSessionEntry, tabId = session.activeTabId): BrowserTabsState {
		if (session.tabs.size === 1) {
			throw browserError("CANNOT_CLOSE_LAST_TAB", "The only browser tab cannot be closed");
		}
		const tab = session.tabs.get(tabId);
		if (!tab) throw browserError("TAB_NOT_FOUND", `Browser tab ${tabId} does not exist`);
		const wasActive = tabId === session.activeTabId;
		disposeNetworkCapture(tab, "tab-closed");
		if (session.networkTabId === tabId) session.networkTabId = undefined;
		session.tabs.delete(tabId);
		tabsByWebContentsId.delete(tab.view.webContents.id);
		destroyTabView(tab);
		if (wasActive) {
			const nextTabId = [...session.tabs.keys()].at(-1)!;
			activateTab(session, nextTabId, false);
		}
		const state = listTabs(session, { kind: "closed", tabId });
		options.mainWindow.webContents.send("browser:tabsState", state);
		return state;
	}

	function applySessionBounds(session: BrowserSessionEntry, entry: BrowserEntry): void {
		if (!session.visible) {
			applyBrowserViewBounds(entry.view, OFFSCREEN_BOUNDS, false);
			return;
		}
		applyBrowserViewBounds(
			entry.view,
			session.bounds,
			session.parked || (session.bounds.width > 0 && session.bounds.height > 0),
		);
	}

	const isRendererOwned = (event: IpcMainInvokeEvent | IpcMainEvent, viewId: string): boolean =>
		rendererOwnersByViewId.get(viewId)?.has(event.sender.id) ?? false;

	const setBounds = ({ viewId, rect, visible, parked }: BrowserBoundsInput, zoomFactor = 1): void => {
		const session = entries.get(viewId);
		if (!session) return;
		const entry = activeEntry(session);
		if (parked) {
			const scaled = scaleBoundsForZoom(rect, zoomFactor);
			const width = Math.max(1, Math.round(scaled.width));
			const height = Math.max(1, Math.round(scaled.height));
			session.bounds = { x: OFFSCREEN_BOUNDS.x, y: 0, width, height };
			session.visible = true;
			session.parked = true;
			applySessionBounds(session, entry);
			return;
		}
		if (!visible) {
			session.bounds = OFFSCREEN_BOUNDS;
			session.visible = false;
			session.parked = false;
			applySessionBounds(session, entry);
			forgetIfFocused(viewId);
			return;
		}
		// The renderer measures the slot in page-zoomed CSS pixels, while
		// WebContentsView bounds are window coordinates. Convert before clamping so
		// Cmd+/Cmd- page zoom does not detach the native view from its React slot.
		session.bounds = clampBoundsToWindow(
			scaleBoundsForZoom(rect, zoomFactor),
			options.mainWindow.getContentBounds(),
		);
		session.visible = true;
		session.parked = false;
		applySessionBounds(session, entry);
	};

	const navigate = async ({ viewId, url }: BrowserNavigateInput): Promise<BrowserNavState> => {
		const session = entries.get(viewId);
		if (!session) throw browserError("BROWSER_TARGET_UNAVAILABLE", "Browser target is unavailable");
		return navigateEntry(activeEntry(session), url);
	};

	const navigateEntry = async (entry: BrowserEntry, url: string): Promise<BrowserNavState> => {
		cancelAnnotation(options, entry, "navigation");
		const normalized = normalizeBrowserURL(url);
		if (!isAllowedBrowserURL(normalized.href, options.rendererOrigin)) {
			throw new Error("Unsupported browser URL");
		}
		try {
			await entry.view.webContents.loadURL(normalized.href);
		} catch (err) {
			if ((err as { errorCode?: number })?.errorCode === -3) return pushNavState(options, entry);
			entry.view.setVisible?.(false);
			entry.state = { ...readNavState(entry), error: String((err as Error)?.message || "Unable to load page") };
			options.mainWindow.webContents.send("browser:navState", entry.state);
			return entry.state;
		}
		const session = entries.get(entry.state.viewId);
		if (session?.activeTabId === entry.tabId) applySessionBounds(session, entry);
		return pushNavState(options, entry);
	};

	// clear resets the view to a blank page (`ao preview clear`). about:blank is
	// loaded directly, bypassing the URL allowlist — it carries no content and
	// readNavState normalizes it back to an empty url so the panel shows its
	// empty state.
	const clear = async (viewId: string): Promise<BrowserNavState> => {
		const session = entries.get(viewId);
		if (!session) throw browserError("BROWSER_TARGET_UNAVAILABLE", "Browser target is unavailable");
		const entry = activeEntry(session);
		cancelAnnotation(options, entry, "navigation");
		session.visible = false;
		session.parked = false;
		session.bounds = OFFSCREEN_BOUNDS;
		applySessionBounds(session, entry);
		forgetIfFocused(viewId);
		await entry.view.webContents.loadURL("about:blank");
		entry.view.webContents.clearHistory();
		return pushNavState(options, entry);
	};

	const capture = async (viewId: string): Promise<string> => {
		const session = entries.get(viewId);
		if (!session) return "";
		const entry = activeEntry(session);
		try {
			const image = await entry.view.webContents.capturePage();
			if (image.isEmpty()) return "";
			return `data:image/jpeg;base64,${image.toJPEG(70).toString("base64")}`;
		} catch {
			return "";
		}
	};

	const destroy = (viewId: string): void => {
		const session = entries.get(viewId);
		if (!session) return;
		entries.delete(viewId);
		viewIdsBySessionId.delete(session.sessionId);
		rendererOwnersByViewId.delete(viewId);
		forgetIfFocused(viewId);
		// When the window is already gone (dispose fired from mainWindow "closed"),
		// Electron has torn down contentView and the child WebContentsViews. Touching
		// them throws "Object has been destroyed", so just drop our reference.
		if (options.mainWindow.isDestroyed?.()) {
			for (const entry of session.tabs.values()) {
				tabsByWebContentsId.delete(entry.view.webContents.id);
				disposeNetworkCapture(entry, "session-closed");
			}
			return;
		}
		for (const entry of session.tabs.values()) {
			tabsByWebContentsId.delete(entry.view.webContents.id);
			disposeNetworkCapture(entry, "session-closed");
			destroyTabView(entry);
		}
	};

	const destroyTabView = (entry: BrowserEntry): void => {
		applyBrowserViewBounds(entry.view, OFFSCREEN_BOUNDS, false);
		options.mainWindow.contentView.removeChildView?.(entry.view);
		if (entry.view.webContents.debugger?.isAttached()) {
			entry.view.webContents.debugger.detach();
		}
		entry.view.webContents.close?.();
	};

	const invokeNav = (
		viewId: string,
		action: (contents: BrowserWebContents) => void,
		cancelForNavigation = false,
	): BrowserNavState => {
		const session = entries.get(viewId);
		if (!session) return emptyNavState(viewId);
		const entry = activeEntry(session);
		if (cancelForNavigation) {
			cancelAnnotation(options, entry, "navigation");
			applySessionBounds(session, entry);
		}
		action(entry.view.webContents);
		return pushNavState(options, entry);
	};

	const setAnnotationMode = (event: IpcMainInvokeEvent, input: BrowserAnnotationModeInput): void => {
		if (!isRendererOwned(event, input.viewId)) return;
		const session = entries.get(input.viewId);
		if (!session) return;
		const entry = activeEntry(session);
		entry.annotationEnabled = input.enabled;
		entry.view.webContents.send("browser:annotation:setMode", { enabled: input.enabled });
	};

	const forwardAnnotationSubmit = (
		event: IpcMainEvent,
		payload: BrowserAnnotationPageSubmitPayload | undefined,
	): void => {
		const entry = tabsByWebContentsId.get(event.sender.id);
		const viewId = entry?.state.viewId;
		if (
			!viewId ||
			!entry ||
			!payload ||
			typeof payload.instruction !== "string" ||
			typeof payload.context !== "object" ||
			payload.context === null
		) {
			return;
		}
		entry.annotationEnabled = false;
		const forwarded: BrowserAnnotationSubmitPayload = {
			viewId,
			instruction: payload.instruction,
			context: payload.context,
		};
		options.mainWindow.webContents.send("browser:annotation:submitted", forwarded);
	};

	const forwardAnnotationCancel = (
		event: IpcMainEvent,
		payload: BrowserAnnotationPageCancelPayload | undefined,
	): void => {
		const entry = tabsByWebContentsId.get(event.sender.id);
		const viewId = entry?.state.viewId;
		if (!viewId || !entry) return;
		entry.annotationEnabled = false;
		const forwarded: BrowserAnnotationCancelPayload = {
			viewId,
			reason: payload?.reason ?? "cancel",
		};
		options.mainWindow.webContents.send("browser:annotation:canceled", forwarded);
	};

	const handle = <Args extends unknown[], Result>(
		channel: string,
		fn: (event: IpcMainInvokeEvent, ...args: Args) => Result,
	): void => {
		options.ipcMain.handle(channel, fn);
		ipcDisposers.push(() => options.ipcMain.removeHandler(channel));
	};
	const on = <Args extends unknown[]>(channel: string, fn: (event: IpcMainEvent, ...args: Args) => void): void => {
		options.ipcMain.on(channel, fn);
		ipcDisposers.push(() => options.ipcMain.off(channel, fn));
	};

	handle("browser:ensure", (event, sessionId: string) =>
		pushNavState(options, activeEntry(ensureSession(sessionId, event.sender.id))),
	);
	on("browser:setBounds", (event, input: BrowserBoundsInput) => {
		if (isRendererOwned(event, input.viewId)) setBounds(input, event.sender.getZoomFactor());
	});
	handle("browser:navigate", (event, input: BrowserNavigateInput) =>
		isRendererOwned(event, input.viewId) ? navigate(input) : emptyNavState(input.viewId),
	);
	handle("browser:clear", (event, viewId: string) =>
		isRendererOwned(event, viewId) ? clear(viewId) : emptyNavState(viewId),
	);
	handle("browser:capture", (event, viewId: string) => (isRendererOwned(event, viewId) ? capture(viewId) : ""));
	handle("browser:requestMirror", (event, viewId: string) => {
		if (!mirrorSupported || !isRendererOwned(event, viewId) || !entries.has(viewId)) return false;
		const frame = event.senderFrame;
		if (!frame) return false;
		pendingMirror = { viewId, expires: Date.now() + 5000, frame };
		return true;
	});
	handle("browser:goBack", (event, viewId: string) =>
		isRendererOwned(event, viewId) ? invokeNav(viewId, (contents) => contents.goBack(), true) : emptyNavState(viewId),
	);
	handle("browser:goForward", (event, viewId: string) =>
		isRendererOwned(event, viewId)
			? invokeNav(viewId, (contents) => contents.goForward(), true)
			: emptyNavState(viewId),
	);
	handle("browser:reload", (event, viewId: string) =>
		isRendererOwned(event, viewId) ? invokeNav(viewId, (contents) => contents.reload(), true) : emptyNavState(viewId),
	);
	handle("browser:stop", (event, viewId: string) =>
		isRendererOwned(event, viewId) ? invokeNav(viewId, (contents) => contents.stop()) : emptyNavState(viewId),
	);
	handle("browser:getTabs", (event, viewId: string) => {
		const session = entries.get(viewId);
		return session && isRendererOwned(event, viewId) ? listTabs(session) : emptyTabsState(viewId);
	});
	handle("browser:selectTab", (event, input: BrowserTabInput) => {
		const session = entries.get(input.viewId);
		if (!session || !isRendererOwned(event, input.viewId)) return emptyTabsState(input.viewId);
		activateTab(session, input.tabId);
		return listTabs(session);
	});
	handle("browser:closeTab", (event, input: BrowserTabInput) => {
		const session = entries.get(input.viewId);
		return session && isRendererOwned(event, input.viewId)
			? closeTab(session, input.tabId)
			: emptyTabsState(input.viewId);
	});
	handle("browser:annotation:setMode", (event, input: BrowserAnnotationModeInput) => setAnnotationMode(event, input));
	on("browser:destroy", (event, viewId: string) => {
		if (isRendererOwned(event, viewId)) destroy(viewId);
	});
	on("browser:annotation:submit", (event, payload: BrowserAnnotationPageSubmitPayload) =>
		forwardAnnotationSubmit(event, payload),
	);
	on("browser:annotation:cancel", (event, payload: BrowserAnnotationPageCancelPayload) =>
		forwardAnnotationCancel(event, payload),
	);

	return {
		execute: async (sessionId, action, args = {}, signal) => {
			throwIfAborted(signal);
			if (!sessionId.trim()) throw browserError("INVALID_ARGUMENT", "sessionId is required");
			if (action === "__destroy-session") {
				const viewId = viewIdsBySessionId.get(sessionId);
				if (viewId) destroy(viewId);
				return { destroyed: Boolean(viewId) };
			}
			const session = ensureSession(sessionId);
			const entry = commandEntry(session, args);
			if (action === "__status") return browserTargetStatus(entry);
			const commandId = randomUUID();
			setAgentBrowserActivity(session, action, true, commandId, "started");
			try {
				switch (action) {
				case "open": {
					const url = stringArg(args, "url", "URL_REQUIRED", "url is required");
					const state = await navigate({ viewId: entry.state.viewId, url: normalizeAgentBrowserURL(url) });
					if (state.error) throw browserError("NAVIGATION_FAILED", state.error);
					return state;
				}
				case "snapshot":
					return snapshotEntry(entry, Boolean(args.interactive), typeof args.frameId === "string" ? args.frameId : undefined);
				case "observe":
					return observeEntry(entry, {
						interactiveOnly: Boolean(args.interactiveOnly),
						includeScreenshot: Boolean(args.includeScreenshot),
						includeProblems: Boolean(args.includeProblems),
					});
				case "click":
					return runMutation(entry, args, signal, (target) => clickEntry(entry, target, "left", 1));
				case "double-click":
					return runMutation(entry, args, signal, (target) => clickEntry(entry, target, "left", 2));
				case "right-click":
					return runMutation(entry, args, signal, (target) => clickEntry(entry, target, "right", 1));
				case "upload":
					return runMutation(entry, args, signal, (target) => uploadEntry(entry, target, args));
				case "drag":
					return runMutation(entry, args, signal, () => dragEntry(entry, args));
				case "back":
					return runMutation(entry, args, signal, () => invokeNav(entry.state.viewId, (contents) => contents.goBack(), true));
				case "forward":
					return runMutation(entry, args, signal, () => invokeNav(entry.state.viewId, (contents) => contents.goForward(), true));
				case "reload":
					return runMutation(entry, args, signal, () => invokeNav(entry.state.viewId, (contents) => contents.reload(), true));
				case "fill":
					return runMutation(entry, args, signal, (target) =>
						fillEntry(entry, target, stringArg(args, "text", "INVALID_ARGUMENT", "text is required", true)),
					);
				case "type":
					return runMutation(entry, args, signal, (target) =>
						typeEntry(entry, target, stringArg(args, "text", "INVALID_ARGUMENT", "text is required", true)),
					);
				case "press":
					return runMutation(entry, args, signal, () =>
						pressEntry(entry, stringArg(args, "key", "INVALID_ARGUMENT", "key is required")),
					);
				case "hover":
					return hoverEntry(entry, await resolveTarget(entry, args));
				case "highlight":
					return highlightEntry(entry, await resolveTarget(entry, args));
				case "unhighlight":
					return unhighlightEntry(entry);
				case "tabs":
					return listTabs(session);
				case "tab-new": {
					const url =
						typeof args.url === "string" && args.url.trim() ? normalizeAgentBrowserURL(args.url) : undefined;
					const tab = await openTab(session, url, true);
					return tabResult(tab, true);
				}
				case "tab-select": {
					const tab = activateTab(
						session,
						stringArg(args, "tabId", "TAB_ID_REQUIRED", "tabId is required"),
					);
					return tabResult(tab, true);
				}
				case "tab-close": {
					const tabId =
						typeof args.tabId === "string" && args.tabId.trim() ? args.tabId.trim() : session.activeTabId;
					return { closedTabId: tabId, ...closeTab(session, tabId) };
				}
				case "scroll":
					return runMutation(entry, args, signal, () =>
						scrollEntry(
							entry,
							stringArg(args, "direction", "INVALID_ARGUMENT", "direction is required"),
							numberArg(args.amount, 1, 5_000) || 600,
						),
					);
				case "select":
					return runMutation(entry, args, signal, (target) =>
						selectEntry(entry, target, stringArg(args, "value", "INVALID_ARGUMENT", "value is required", true)),
					);
				case "check":
					return runMutation(entry, args, signal, (target) => checkEntry(entry, target, true));
				case "uncheck":
					return runMutation(entry, args, signal, (target) => checkEntry(entry, target, false));
				case "get":
					return getEntry(
						entry,
						stringArg(args, "property", "INVALID_ARGUMENT", "property is required"),
						typeof args.ref === "string" && args.ref.trim() ? args.ref : undefined,
					);
				case "wait":
					return waitForEntry(entry, args, signal);
				case "screenshot":
					return screenshotEntry(entry, args);
				case "frames":
					return framesEntry(entry);
				case "dialog":
					return { open: Boolean(entry.dialog), dialog: entry.dialog, untrustedExternalContent: true };
				case "dialog-accept":
				case "dialog-dismiss":
					return runMutation(entry, args, signal, () => handleDialogEntry(entry, action === "dialog-accept", args));
				case "viewport":
					return viewportEntry(entry);
				case "viewport-set":
					return runMutation(entry, args, signal, () => setViewportEntry(entry, args));
				case "network-start":
					return startNetworkCapture(
						session,
						entry,
						networkDurationArg(args.durationSeconds),
					);
				case "network-status":
					return networkCaptureStatus(networkEntryFor(session));
				case "network-list":
					return networkCaptureResult(networkEntryFor(session));
				case "network-stop":
					return stopNetworkCapture(networkEntryFor(session), "stopped");
				case "network-clear":
					return clearNetworkCapture(networkEntryFor(session));
				case "console":
					return logResult(entry.consoleMessages, args.since);
				case "errors":
					return logResult(entry.errors, args.since);
				case "console-clear":
					entry.consoleMessages.length = 0;
					return { cleared: true, cursor: 0 };
				case "errors-clear":
					entry.errors.length = 0;
					return { cleared: true, cursor: 0 };
				case "downloads":
					return { downloads: session.downloads, untrustedExternalContent: true };
				case "downloads-clear":
					session.downloads.length = 0;
					return { cleared: true };
				default:
					throw browserError("INVALID_ARGUMENT", `Unsupported browser action: ${action}`);
				}
			} finally {
				setAgentBrowserActivity(session, action, false, commandId, "finished");
			}
		},
		dispose: () => {
			ipcDisposers.splice(0).forEach((dispose) => dispose());
			for (const viewId of [...entries.keys()]) {
				destroy(viewId);
			}
		},
		destroy,
		destroyAll: () => {
			for (const viewId of [...entries.keys()]) {
				destroy(viewId);
			}
		},
		getLastFocusedPanelContents: () => {
			if (lastFocusedViewId === null) return null;
			const session = entries.get(lastFocusedViewId);
			if (!session) return null;
			const entry = activeEntry(session);
			// Stored narrowed as BrowserWebContents but is a full WebContents at runtime.
			const contents = entry.view.webContents as unknown as WebContents;
			return contents.isDestroyed() ? null : contents;
		},
		forgetLastFocusedPanel: () => {
			lastFocusedViewId = null;
		},
	};
}

function withDefaultScheme(raw: string): string {
	if (isWindowsAbsolutePath(raw) || isPosixAbsolutePath(raw)) return localPathToFileURL(raw);
	if (/^https?:\/\//i.test(raw)) return raw;
	if (isLocalhostLike(raw)) return `http://${raw}`;
	// A single token with no whitespace can be a destination: an explicit scheme
	// (file:, mailto:, ...) or a bare hostname we default to https. Anything else —
	// whitespace-containing text, or a lone word that is not a hostname — is a
	// search query, not a URL (Chrome-style omnibox behavior).
	if (!/\s/.test(raw)) {
		if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(raw)) return raw;
		if (looksLikeHost(raw)) return `https://${raw}`;
	}
	return searchURL(raw);
}

// Treat input as a navigable host when the authority (the part before any
// path/query/fragment) is an IPv6 literal, carries an explicit :port, or has a
// dot (a domain). Bare words like "hi" fail this and become a search instead.
function looksLikeHost(raw: string): boolean {
	const host = raw.split(/[/?#]/, 1)[0];
	if (host === "") return false;
	if (host.startsWith("[") && host.includes("]")) return true;
	if (/:\d+$/.test(host)) return true;
	return host.includes(".");
}

function searchURL(query: string): string {
	return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function isWindowsAbsolutePath(raw: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(raw);
}

function isPosixAbsolutePath(raw: string): boolean {
	return raw.startsWith("/");
}

function localPathToFileURL(raw: string): string {
	if (isWindowsAbsolutePath(raw)) {
		const normalized = raw.replace(/\\/g, "/");
		return `file:///${encodePathSegments(normalized).replace(/^([A-Za-z])%3A(?=\/)/, "$1:")}`;
	}
	return `file://${encodePathSegments(raw)}`;
}

function encodePathSegments(pathname: string): string {
	return pathname.split("/").map(encodeURIComponent).join("/");
}

function isLocalhostLike(raw: string): boolean {
	return /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(raw);
}

function emptyNavState(viewId: string): BrowserNavState {
	return {
		viewId,
		url: "",
		title: "",
		canGoBack: false,
		canGoForward: false,
		isLoading: false,
	};
}

function emptyTabsState(viewId: string): BrowserTabsState {
	return { viewId, activeTabId: "", tabs: [] };
}

function activeEntry(session: BrowserSessionEntry): BrowserEntry {
	const entry = session.tabs.get(session.activeTabId);
	if (!entry) throw browserError("BROWSER_TARGET_UNAVAILABLE", "Active browser tab is unavailable");
	return entry;
}

function commandEntry(session: BrowserSessionEntry, args: Record<string, unknown>): BrowserEntry {
	const expected = objectValue(args.expectedState);
	const explicitTab = typeof args.tabId === "string" ? args.tabId : "";
	const tabId = typeof expected.tabId === "string" ? expected.tabId.trim() : explicitTab.trim();
	if (!tabId) return activeEntry(session);
	const entry = session.tabs.get(tabId);
	if (!entry) throw browserError("TARGET_CHANGED", `Browser tab ${tabId} no longer exists`);
	return entry;
}

function expectedStateArg(args: Record<string, unknown>): BrowserExpectedState | undefined {
	const raw = objectValue(args.expectedState);
	if (Object.keys(raw).length === 0) return undefined;
	if (
		typeof raw.tabId !== "string" ||
		!raw.tabId.trim() ||
		typeof raw.expectedUrl !== "string" ||
		typeof raw.snapshotGeneration !== "number" ||
		!Number.isInteger(raw.snapshotGeneration)
	) {
		throw browserError(
			"INVALID_ARGUMENT",
			"expectedState requires tabId, expectedUrl, and an integer snapshotGeneration",
		);
	}
	return {
		tabId: raw.tabId.trim(),
		expectedUrl: raw.expectedUrl,
		snapshotGeneration: raw.snapshotGeneration,
	};
}

function assertExpectedState(entry: BrowserEntry, args: Record<string, unknown>): void {
	const expected = expectedStateArg(args);
	if (!expected) return;
	if (entry.tabId !== expected.tabId) {
		throw browserError("TARGET_CHANGED", `Expected browser tab ${expected.tabId}, found ${entry.tabId}`);
	}
	const currentURL = entry.view.webContents.getURL();
	if (currentURL !== expected.expectedUrl) {
		throw browserError("URL_CHANGED", "The browser URL changed after the last observation; observe again");
	}
	if (entry.refGeneration !== expected.snapshotGeneration) {
		if (args.allowStaleRemap === true && typeof args.ref === "string" && args.ref.trim()) return;
		throw browserError(
			"SNAPSHOT_CHANGED",
			"The page snapshot changed after the last observation; observe again",
		);
	}
}

function tabResult(entry: BrowserEntry, active: boolean): {
	id: string;
	url: string;
	title: string;
	active: boolean;
} {
	return {
		id: entry.tabId,
		url: entry.view.webContents.getURL(),
		title: entry.view.webContents.getTitle(),
		active,
	};
}

function listTabs(session: BrowserSessionEntry, change?: BrowserTabsState["change"]): BrowserTabsState {
	return {
		viewId: session.viewId,
		activeTabId: session.activeTabId,
		tabs: [...session.tabs.values()].map((entry) => tabResult(entry, entry.tabId === session.activeTabId)),
		...(change ? { change } : {}),
	};
}

function pushTabsState(
	options: BrowserViewHostOptions,
	session: BrowserSessionEntry,
	change?: BrowserTabsState["change"],
): BrowserTabsState {
	const state = listTabs(session, change);
	options.mainWindow.webContents.send("browser:tabsState", state);
	return state;
}

function hardenWebContents(
	contents: BrowserWebContents,
	options: BrowserViewHostOptions,
	entry: BrowserEntry,
	createPopup: () => BrowserWebContents,
	canCreatePopup: () => boolean,
): void {
	contents.setWindowOpenHandler(({ url }) => {
		if (!isAllowedBrowserURL(url, options.rendererOrigin) || !canCreatePopup()) {
			return { action: "deny" };
		}
		return {
			action: "allow",
			createWindow: () => createPopup() as WebContents,
		};
	});
	const blockUnsafeNavigation = (event: Electron.Event, url: string) => {
		if (!isAllowedBrowserURL(url, options.rendererOrigin)) {
			event.preventDefault();
			entry.state = { ...entry.state, error: "Unsupported browser URL" };
			options.mainWindow.webContents.send("browser:navState", entry.state);
		}
	};
	contents.on("will-navigate", blockUnsafeNavigation);
	contents.on("will-redirect", blockUnsafeNavigation);
}

function wireNavEvents(
	contents: BrowserWebContents,
	options: BrowserViewHostOptions,
	entry: BrowserEntry,
	isActive: () => boolean,
	syncActiveBounds: () => void,
	syncTabs: () => void,
): void {
	const update = () => {
		syncTabs();
		if (isActive()) pushNavState(options, entry);
	};
	contents.on("did-navigate", () => {
		if (isActive()) syncActiveBounds();
		update();
	});
	contents.on("did-navigate-in-page", update);
	contents.on("page-title-updated", update);
	contents.on("did-start-loading", () => {
		invalidateRefs(entry);
		cancelAnnotation(options, entry, "navigation");
		update();
	});
	contents.on("did-stop-loading", update);
	contents.on("did-fail-load", (_event, errorCode, errorDescription) => {
		if (errorCode === -3) return;
		pushBrowserLog(entry.errors, {
			level: "error",
			message: String(errorDescription || `Navigation failed (${errorCode})`),
			timestamp: new Date().toISOString(),
		});
		if (isActive()) entry.view.setVisible?.(false);
		entry.state = { ...readNavState(entry), error: String(errorDescription || "Unable to load page") };
		if (isActive()) options.mainWindow.webContents.send("browser:navState", entry.state);
	});
}

function cancelAnnotation(
	options: BrowserViewHostOptions,
	entry: BrowserEntry,
	reason: BrowserAnnotationCancelPayload["reason"],
): void {
	if (!entry.annotationEnabled) return;
	entry.annotationEnabled = false;
	entry.view.webContents.send("browser:annotation:setMode", { enabled: false });
	options.mainWindow.webContents.send("browser:annotation:canceled", { viewId: entry.state.viewId, reason });
}

function pushNavState(options: BrowserViewHostOptions, entry: BrowserEntry): BrowserNavState {
	entry.state = readNavState(entry);
	options.mainWindow.webContents.send("browser:navState", entry.state);
	return entry.state;
}

function readNavState(entry: BrowserEntry): BrowserNavState {
	const { webContents } = entry.view;
	const currentURL = webContents.getURL();
	return {
		viewId: entry.state.viewId,
		// about:blank is the cleared/blank state — surface it as an empty url so
		// the panel renders its "enter a URL" empty state and the address bar is
		// blank rather than showing "about:blank".
		url: currentURL === "about:blank" ? "" : currentURL,
		title: webContents.getTitle(),
		canGoBack: webContents.canGoBack(),
		canGoForward: webContents.canGoForward(),
		isLoading: webContents.isLoading(),
	};
}

type AXValue = { value?: unknown };
type AXNode = {
	nodeId: string;
	parentId?: string;
	ignored?: boolean;
	backendDOMNodeId?: number;
	role?: AXValue;
	name?: AXValue;
	value?: AXValue;
	properties?: Array<{ name: string; value?: AXValue }>;
};

const INTERACTIVE_ROLES = new Set([
	"button",
	"checkbox",
	"combobox",
	"link",
	"listbox",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
	"option",
	"radio",
	"scrollbar",
	"searchbox",
	"slider",
	"spinbutton",
	"switch",
	"tab",
	"textbox",
	"treeitem",
]);

function wireAutomationEvents(contents: BrowserWebContents, entry: BrowserEntry): void {
	contents.on("console-message", (...eventArgs: unknown[]) => {
		const details = eventArgs.find(
			(value) => value && typeof value === "object" && typeof (value as { message?: unknown }).message === "string",
		) as { level?: string; message: string; lineNumber?: number; sourceId?: string } | undefined;
		const legacyLevel = typeof eventArgs[1] === "number" ? eventArgs[1] : 1;
		const legacyMessage = typeof eventArgs[2] === "string" ? eventArgs[2] : "";
		const level = details?.level ?? ["debug", "info", "warning", "error"][legacyLevel] ?? "info";
		const log: BrowserLogEntry = {
			level,
			message: details?.message ?? legacyMessage,
			source: details?.sourceId ?? (typeof eventArgs[4] === "string" ? eventArgs[4] : undefined),
			line: details?.lineNumber ?? (typeof eventArgs[3] === "number" ? eventArgs[3] : undefined),
			timestamp: new Date().toISOString(),
		};
		pushBrowserLog(entry.consoleMessages, log);
		if (level === "error") pushBrowserLog(entry.errors, log);
	});
	contents.on("render-process-gone", (_event, details) => {
		pushBrowserLog(entry.errors, {
			level: "error",
			message: `Browser renderer exited: ${details.reason}`,
			timestamp: new Date().toISOString(),
		});
	});
	const targetDebugger = contents.debugger;
	if (!targetDebugger) return;
	targetDebugger.on("message", (_event, method, params) => {
		handleNetworkDebuggerEvent(entry, method, params as Record<string, unknown>);
		if (method === "Page.javascriptDialogOpening") {
			const dialog = params as { type?: string; message?: string; defaultPrompt?: string };
			entry.dialog = {
				type: dialog.type ?? "alert",
				message: externalText(dialog.message ?? ""),
				...(dialog.defaultPrompt ? { defaultPrompt: externalText(dialog.defaultPrompt) } : {}),
			};
			return;
		}
		if (method === "Page.javascriptDialogClosed") {
			entry.dialog = undefined;
			return;
		}
		if (method === "DOM.documentUpdated") {
			invalidateRefs(entry);
			return;
		}
		if (method === "Runtime.exceptionThrown") {
			const detail = params as { exceptionDetails?: { text?: string; url?: string; lineNumber?: number } };
			const exception = detail.exceptionDetails;
			pushBrowserLog(entry.errors, {
				level: "error",
				message: exception?.text ?? "Uncaught browser exception",
				source: exception?.url,
				line: exception?.lineNumber,
				timestamp: new Date().toISOString(),
			});
		}
	});
}

function pushBrowserLog(target: BrowserLogEntry[], entry: BrowserLogEntry): void {
	target.push({
		...entry,
		message: entry.message.slice(0, MAX_LOG_MESSAGE_CHARS),
		source: entry.source?.slice(0, 2_048),
	});
	if (target.length > 200) target.splice(0, target.length - 200);
}

function configureSessionDownloads(
	browserSession: BrowserWebContents["session"],
	session: BrowserSessionEntry,
): void {
	if (!browserSession?.on) return;
	browserSession.on("will-download", (_event, item: DownloadItem) => {
		const id = randomUUID();
		const directory = path.join(
			process.env.AO_DATA_DIR ?? path.join(os.homedir(), ".ao"),
			"browser-downloads",
			session.sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_"),
		);
		mkdirSync(directory, { recursive: true });
		const filename = path.basename(item.getFilename()).replace(/[^a-zA-Z0-9_.() -]/g, "_") || "download";
		const targetPath = path.join(directory, `${id.slice(0, 8)}-${filename}`);
		const record = { id, filename, path: targetPath, url: item.getURL(), state: "progressing" };
		session.downloads.push(record);
		if (session.downloads.length > 100) session.downloads.splice(0, session.downloads.length - 100);
		item.setSavePath(targetPath);
		item.once("done", (_doneEvent, state) => {
			record.state = state;
		});
	});
}

function invalidateRefs(entry: BrowserEntry): void {
	entry.refGeneration += 1;
}

async function ensureDebugger(entry: BrowserEntry): Promise<void> {
	const debug = entry.view.webContents.debugger;
	if (!debug) throw browserError("BROWSER_TARGET_UNAVAILABLE", "Browser debugger is unavailable");
	if (!debug.isAttached()) {
		try {
			debug.attach("1.3");
		} catch (error) {
			throw browserError(
				"BROWSER_TARGET_UNAVAILABLE",
				error instanceof Error ? error.message : "Unable to attach to browser target",
			);
		}
	}
	await debug.sendCommand("Runtime.enable");
	await debug.sendCommand("DOM.enable");
	await debug.sendCommand("Page.enable");
}

function networkEntryFor(session: BrowserSessionEntry): BrowserEntry {
	if (session.networkTabId) {
		const captured = session.tabs.get(session.networkTabId);
		if (captured) return captured;
		session.networkTabId = undefined;
	}
	return activeEntry(session);
}

async function startNetworkCapture(
	session: BrowserSessionEntry,
	entry: BrowserEntry,
	durationSeconds: number,
): Promise<unknown> {
	const existing = networkEntryFor(session);
	if (existing.networkCapture?.active) {
		return { ...networkCaptureStatus(existing), alreadyActive: true };
	}
	if (existing !== entry) disposeNetworkCapture(existing, "restarted");
	disposeNetworkCapture(entry, "restarted");
	await ensureDebugger(entry);
	await entry.view.webContents.debugger.sendCommand("Network.enable");
	const started = Date.now();
	const capture: BrowserNetworkCapture = {
		active: true,
		tabId: entry.tabId,
		startedAt: new Date(started).toISOString(),
		expiresAt: new Date(started + durationSeconds * 1_000).toISOString(),
		maxEntries: MAX_NETWORK_REQUESTS,
		nextSequence: 1,
		requests: [],
		byRequestId: new Map(),
	};
	capture.timer = setTimeout(() => {
		void stopNetworkCapture(entry, "expired");
	}, durationSeconds * 1_000);
	entry.networkCapture = capture;
	session.networkTabId = entry.tabId;
	return networkCaptureStatus(entry);
}

function networkCaptureStatus(entry: BrowserEntry): Record<string, unknown> {
	const capture = entry.networkCapture;
	if (!capture) {
		return {
			active: false,
			metadataOnly: true,
			tabId: entry.tabId,
			requestCount: 0,
			maxEntries: MAX_NETWORK_REQUESTS,
		};
	}
	return {
		active: capture.active,
		metadataOnly: true,
		tabId: capture.tabId,
		requestCount: capture.requests.length,
		maxEntries: capture.maxEntries,
		startedAt: capture.startedAt,
		expiresAt: capture.expiresAt,
		...(capture.stoppedAt ? { stoppedAt: capture.stoppedAt } : {}),
		...(capture.stopReason ? { stopReason: capture.stopReason } : {}),
	};
}

function networkCaptureResult(entry: BrowserEntry): Record<string, unknown> {
	return {
		...networkCaptureStatus(entry),
		requests: (entry.networkCapture?.requests ?? []).map(publicNetworkRequest),
		untrustedExternalContent: true,
	};
}

async function stopNetworkCapture(entry: BrowserEntry, reason: string): Promise<Record<string, unknown>> {
	const capture = entry.networkCapture;
	if (!capture?.active) return networkCaptureResult(entry);
	if (capture.timer) {
		clearTimeout(capture.timer);
		capture.timer = undefined;
	}
	capture.active = false;
	capture.stoppedAt = new Date().toISOString();
	capture.stopReason = reason;
	try {
		await entry.view.webContents.debugger.sendCommand("Network.disable");
	} catch {
		// The target may have closed while an expiry timer was firing. The in-memory
		// capture is still safely stopped and can be discarded with the tab.
	}
	return networkCaptureResult(entry);
}

function clearNetworkCapture(entry: BrowserEntry): Record<string, unknown> {
	const capture = entry.networkCapture;
	if (capture) {
		capture.requests = [];
		capture.byRequestId.clear();
	}
	return networkCaptureStatus(entry);
}

function disposeNetworkCapture(entry: BrowserEntry, reason: string): void {
	const capture = entry.networkCapture;
	if (!capture) return;
	const wasActive = capture.active;
	if (capture.timer) clearTimeout(capture.timer);
	capture.timer = undefined;
	capture.active = false;
	capture.stoppedAt = new Date().toISOString();
	capture.stopReason = reason;
	try {
		if (wasActive && entry.view.webContents.debugger?.isAttached()) {
			void entry.view.webContents.debugger.sendCommand("Network.disable").catch(() => undefined);
		}
	} catch {
		// Electron may already have destroyed the target during window shutdown.
	}
}

function handleNetworkDebuggerEvent(entry: BrowserEntry, method: string, params: Record<string, unknown>): void {
	const capture = entry.networkCapture;
	if (!capture?.active || !method.startsWith("Network.")) return;

	const requestID = typeof params.requestId === "string" ? params.requestId : "";
	if (!requestID) return;
	const timestamp = finiteNumber(params.timestamp);

	if (method === "Network.requestWillBeSent") {
		const request = objectValue(params.request);
		const url = typeof request.url === "string" ? request.url : "";
		const previous = capture.byRequestId.get(requestID);
		const redirect = objectValue(params.redirectResponse);
		if (previous && Object.keys(redirect).length > 0) {
			applyNetworkResponse(previous, redirect);
			finishNetworkRequest(previous, timestamp);
			previous.redirectedTo = sanitizeNetworkURL(url);
		}
		const wallTime = finiteNumber(params.wallTime);
		const item: InternalBrowserNetworkRequest = {
			id: `n${capture.nextSequence++}`,
			protocolRequestId: requestID,
			method: typeof request.method === "string" ? request.method : "GET",
			url: sanitizeNetworkURL(url),
			resourceType: typeof params.type === "string" ? params.type.toLowerCase() : undefined,
			startedAt: wallTime ? new Date(wallTime * 1_000).toISOString() : new Date().toISOString(),
			startedMonotonic: timestamp,
			requestHeaders: selectedNetworkHeaders(request.headers, "request"),
		};
		appendNetworkRequest(capture, item);
		capture.byRequestId.set(requestID, item);
		return;
	}

	const item = capture.byRequestId.get(requestID);
	if (!item) return;
	switch (method) {
		case "Network.responseReceived":
			applyNetworkResponse(item, objectValue(params.response));
			break;
		case "Network.loadingFinished":
			finishNetworkRequest(item, timestamp);
			break;
		case "Network.loadingFailed":
			item.failed = true;
			item.canceled = params.canceled === true;
			item.errorText = typeof params.errorText === "string" ? params.errorText : "Request failed";
			finishNetworkRequest(item, timestamp);
			break;
		case "Network.requestServedFromCache":
			item.fromCache = true;
			break;
	}
}

function applyNetworkResponse(item: InternalBrowserNetworkRequest, response: Record<string, unknown>): void {
	const status = finiteNumber(response.status);
	if (status !== undefined) item.status = status;
	if (typeof response.statusText === "string" && response.statusText) item.statusText = response.statusText;
	if (typeof response.mimeType === "string" && response.mimeType) item.mimeType = response.mimeType;
	item.fromCache =
		item.fromCache === true ||
		response.fromDiskCache === true ||
		response.fromPrefetchCache === true;
	item.fromServiceWorker = response.fromServiceWorker === true;
	item.responseHeaders = selectedNetworkHeaders(response.headers, "response");
}

function finishNetworkRequest(item: InternalBrowserNetworkRequest, timestamp: number | undefined): void {
	if (timestamp !== undefined && item.startedMonotonic !== undefined) {
		item.durationMs = Math.max(0, Math.round((timestamp - item.startedMonotonic) * 1_000));
	}
}

function appendNetworkRequest(capture: BrowserNetworkCapture, item: InternalBrowserNetworkRequest): void {
	capture.requests.push(item);
	if (capture.requests.length <= capture.maxEntries) return;
	const removed = capture.requests.shift();
	if (removed && capture.byRequestId.get(removed.protocolRequestId) === removed) {
		capture.byRequestId.delete(removed.protocolRequestId);
	}
}

function publicNetworkRequest(item: InternalBrowserNetworkRequest): BrowserNetworkRequest {
	const { protocolRequestId: _protocolRequestId, startedMonotonic: _startedMonotonic, ...result } = item;
	return result;
}

const SAFE_REQUEST_HEADERS = new Set([
	"accept",
	"content-type",
	"origin",
	"referer",
	"sec-fetch-mode",
	"sec-fetch-site",
]);
const SAFE_RESPONSE_HEADERS = new Set([
	"access-control-allow-headers",
	"access-control-allow-methods",
	"access-control-allow-origin",
	"cache-control",
	"content-length",
	"content-type",
	"location",
	"vary",
]);

function selectedNetworkHeaders(value: unknown, kind: "request" | "response"): Record<string, string> | undefined {
	const headers = objectValue(value);
	const allowed = kind === "request" ? SAFE_REQUEST_HEADERS : SAFE_RESPONSE_HEADERS;
	const selected: Record<string, string> = {};
	for (const [rawName, rawValue] of Object.entries(headers)) {
		const name = rawName.toLowerCase();
		if (!allowed.has(name)) continue;
		let headerValue = typeof rawValue === "string" ? rawValue : String(rawValue);
		if (name === "referer" || name === "location") headerValue = sanitizeNetworkURL(headerValue);
		selected[name] = headerValue.slice(0, 1_000);
	}
	return Object.keys(selected).length > 0 ? selected : undefined;
}

function sanitizeNetworkURL(raw: string): string {
	try {
		const url = new URL(raw);
		if (!["http:", "https:", "file:"].includes(url.protocol)) {
			return `${url.protocol}[redacted]`;
		}
		url.username = "";
		url.password = "";
		url.hash = "";
		for (const name of [...url.searchParams.keys()]) {
			url.searchParams.set(name, "[redacted]");
		}
		return url.href;
	} catch {
		const withoutFragment = raw.split("#", 1)[0] ?? "";
		return (withoutFragment.split("?", 1)[0] ?? "").slice(0, 2_000);
	}
}

function objectValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function browserTargetStatus(entry: BrowserEntry): Record<string, unknown> {
	const loading = entry.view.webContents.isLoading();
	return {
		state: loading ? "page_loading" : "ready",
		provider: "electron",
		target: {
			tabId: entry.tabId,
			url: entry.view.webContents.getURL(),
			title: entry.view.webContents.getTitle(),
			loading,
			snapshotGeneration: entry.refGeneration,
		},
		...(loading ? { recommendedAction: "Wait for the page to finish loading, then observe again." } : {}),
	};
}

type ObserveEntryOptions = {
	interactiveOnly: boolean;
	includeScreenshot: boolean;
	includeProblems: boolean;
};

async function observeEntry(entry: BrowserEntry, options: ObserveEntryOptions): Promise<Record<string, unknown>> {
	const snapshot = await snapshotEntry(entry, options.interactiveOnly);
	const status = browserTargetStatus(entry);
	const screenshot = options.includeScreenshot ? await screenshotEntry(entry) : undefined;
	const problems = options.includeProblems
		? {
				console: markLogMessages(entry.consoleMessages),
				errors: markLogMessages(entry.errors),
			}
		: undefined;
	return {
		...status,
		snapshot,
		...(screenshot ? { screenshot } : {}),
		...(problems ? { problems } : {}),
		untrustedExternalContent: true,
	};
}

async function snapshotEntry(entry: BrowserEntry, interactiveOnly: boolean, frameId?: string): Promise<Record<string, unknown>> {
	await ensureDebugger(entry);
	await entry.view.webContents.debugger.sendCommand("Accessibility.enable");
	const response = (await entry.view.webContents.debugger.sendCommand("Accessibility.getFullAXTree", frameId ? { frameId } : undefined)) as {
		nodes?: AXNode[];
	};
	const nodes = response.nodes ?? [];
	entry.refGeneration += 1;
	entry.refs.clear();
	const generation = entry.refGeneration;
	const depths = new Map<string, number>();
	const lines: string[] = [];
	const elements: Array<{ ref: string; role: string; name: string; fingerprint: BrowserLocator }> = [];
	let refIndex = 0;
	let truncated = false;
	for (const node of nodes) {
		if (node.ignored) continue;
		const role = stringValue(node.role) || "generic";
		const name = stringValue(node.name);
		const value = stringValue(node.value);
		const interactive =
			INTERACTIVE_ROLES.has(role) || node.properties?.some((property) => property.name === "focusable");
		if (interactiveOnly && !interactive) continue;
		if (!interactive && !name && !value) continue;
		if (lines.length >= MAX_SNAPSHOT_LINES) {
			truncated = true;
			continue;
		}
		let ref = "";
		if (interactive && node.backendDOMNodeId) {
			ref = `e${++refIndex}`;
			const fingerprint: BrowserLocator = { role, ...(name ? { name, exact: true } : {}) };
			entry.refs.set(ref, {
				backendNodeId: node.backendDOMNodeId,
				generation,
				fingerprint,
			});
			elements.push({ ref, role, name, fingerprint });
		}
		const parentDepth = node.parentId ? (depths.get(node.parentId) ?? -1) : -1;
		const depth = Math.max(0, parentDepth + 1);
		depths.set(node.nodeId, depth);
		const label = name ? ` \"${compactText(name)}\"` : "";
		const currentValue = value && value !== name ? ` value=\"${compactText(value)}\"` : "";
		const reference = ref ? ` [ref=${ref}]` : "";
		lines.push(`${"  ".repeat(Math.min(depth, 8))}${role}${label}${currentValue}${reference}`);
	}
	const snapshotText = lines.join("\n") || "(empty accessibility snapshot)";
	const truncationNotice = truncated
		? `\n[Snapshot truncated: showing ${lines.length} lines from ${nodes.length} accessibility nodes]`
		: "";
	return {
		url: entry.view.webContents.getURL(),
		title: entry.view.webContents.getTitle(),
		generation,
		text: markUntrusted(snapshotText + truncationNotice),
		elements,
		totalNodes: nodes.length,
		truncated,
		untrustedExternalContent: true,
	};
}

type ResolvedBrowserTarget = {
	objectId: string;
	label: string;
	locator?: BrowserLocator;
	remapped?: boolean;
};

function locatorArg(value: unknown): BrowserLocator | undefined {
	const raw = objectValue(value);
	const locator: BrowserLocator = {};
	for (const key of ["role", "name", "label", "placeholder", "text", "testId", "css"] as const) {
		if (typeof raw[key] === "string" && raw[key].trim()) locator[key] = raw[key].trim();
	}
	if (raw.exact === true) locator.exact = true;
	return Object.keys(locator).some((key) => key !== "exact") ? locator : undefined;
}

async function resolveTarget(entry: BrowserEntry, args: Record<string, unknown>): Promise<ResolvedBrowserTarget> {
	const locator = locatorArg(args.target);
	if (locator) return resolveLocator(entry, locator);
	const refName = stringArg(args, "ref", "REFERENCE_REQUIRED", "ref or semantic target is required");
	try {
		return { objectId: await resolveRef(entry, refName), label: refName };
	} catch (error) {
		const stale = entry.refs.get(refName);
		if (
			!(error instanceof Error) ||
			(error as Error & { code?: string }).code !== "STALE_REFERENCE" ||
			args.allowStaleRemap !== true ||
			!stale?.fingerprint
		) {
			throw error;
		}
		const remapped = await resolveLocator(entry, stale.fingerprint);
		return { ...remapped, label: refName, remapped: true };
	}
}

async function resolveLocator(entry: BrowserEntry, locator: BrowserLocator): Promise<ResolvedBrowserTarget> {
	await ensureDebugger(entry);
	const encoded = JSON.stringify(locator);
	const response = (await entry.view.webContents.debugger.sendCommand("Runtime.evaluate", {
		expression: `(() => {
			const query = ${encoded};
			const normalized = value => String(value || '').replace(/\\s+/g, ' ').trim();
			const same = (actual, wanted) => query.exact ? normalized(actual) === wanted : normalized(actual).toLowerCase().includes(wanted.toLowerCase());
			const inferredRole = element => element.getAttribute('role') || ({BUTTON:'button',A:'link',SELECT:'combobox',TEXTAREA:'textbox'}[element.tagName] || (element.tagName === 'INPUT' ? ({checkbox:'checkbox',radio:'radio',submit:'button',button:'button'}[element.type] || 'textbox') : 'generic'));
			const labelledBy = element => normalized((element.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || '').join(' '));
			const label = element => normalized(element.getAttribute('aria-label') || labelledBy(element) || (element.labels && Array.from(element.labels).map(item => item.textContent).join(' ')) || '');
			const name = element => normalized(element.getAttribute('aria-label') || labelledBy(element) || element.getAttribute('alt') || element.innerText || element.textContent || element.getAttribute('title') || element.getAttribute('placeholder') || '');
			const selector = element => {
				if (element.id) return '#' + CSS.escape(element.id);
				const testId = element.getAttribute('data-testid');
				if (testId) return '[data-testid="' + CSS.escape(testId) + '"]';
				const parts = [];
				for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
					let part = node.tagName.toLowerCase();
					const siblings = node.parentElement ? Array.from(node.parentElement.children).filter(item => item.tagName === node.tagName) : [];
					if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
					parts.unshift(part);
					if (node === document.body) break;
				}
				return parts.join(' > ');
			};
			let elements;
			try { elements = query.css ? Array.from(document.querySelectorAll(query.css)) : Array.from(document.querySelectorAll('body *')); }
			catch { return {error: 'Invalid CSS selector'}; }
			const matches = elements.filter(element =>
				(!query.role || same(inferredRole(element), query.role)) &&
				(!query.name || same(name(element), query.name)) &&
				(!query.label || same(label(element), query.label)) &&
				(!query.placeholder || same(element.getAttribute('placeholder'), query.placeholder)) &&
				(!query.text || same(element.innerText || element.textContent, query.text)) &&
				(!query.testId || same(element.getAttribute('data-testid'), query.testId))
			).slice(0, 21).map(element => ({selector: selector(element), role: inferredRole(element), name: name(element).slice(0, 120)}));
			return {matches};
		})()`,
		returnByValue: true,
	})) as { result?: { value?: { error?: string; matches?: Array<{ selector: string; role: string; name: string }> } } };
	const value = response.result?.value;
	if (value?.error) throw browserError("INVALID_ARGUMENT", value.error);
	const matches = value?.matches ?? [];
	if (matches.length === 0) throw browserError("LOCATOR_NOT_FOUND", "No element matched the semantic locator");
	if (matches.length !== 1) {
		const candidates = matches.slice(0, 5).map((item) => `${item.role} ${JSON.stringify(item.name)}`).join(", ");
		throw browserError(
			"LOCATOR_AMBIGUOUS",
			`Semantic locator matched ${matches.length}${matches.length > 20 ? "+" : ""} elements. Candidates: ${markUntrusted(candidates)}`,
		);
	}
	const match = matches[0];
	const resolved = (await entry.view.webContents.debugger.sendCommand("Runtime.evaluate", {
		expression: `document.querySelector(${JSON.stringify(match.selector)})`,
	})) as { result?: { objectId?: string } };
	if (!resolved.result?.objectId) throw browserError("STALE_REFERENCE", "Matched element disappeared; observe again");
	return { objectId: resolved.result.objectId, label: "semantic target", locator };
}

async function runMutation(
	entry: BrowserEntry,
	args: Record<string, unknown>,
	signal: AbortSignal | undefined,
	action: (target?: ResolvedBrowserTarget) => Promise<unknown>,
): Promise<Record<string, unknown>> {
	assertExpectedState(entry, args);
	const mutationCountBefore = await readMutationCount(entry);
	const before = {
		tabId: entry.tabId,
		url: entry.view.webContents.getURL(),
		snapshotGeneration: entry.refGeneration,
		loading: entry.view.webContents.isLoading(),
		errorCount: entry.errors.length,
	};
	const hasTarget = typeof args.ref === "string" || locatorArg(args.target) !== undefined;
	const target = hasTarget ? await resolveTarget(entry, args) : undefined;
	const waitAfter = objectValue(args.waitAfter);
	if (waitAfter.load === true && typeof waitAfter.stableMs === "number" && waitAfter.stableMs > 0) {
		throw browserError("INVALID_ARGUMENT", "waitAfter must choose load or stableMs, not both");
	}
	const raw = await action(target);
	if (waitAfter.load === true) await waitForEntry(entry, { load: true, timeoutMs: waitAfter.timeoutMs }, signal);
	if (typeof waitAfter.stableMs === "number" && waitAfter.stableMs > 0) {
		await waitForEntry(entry, { stableMs: waitAfter.stableMs, timeoutMs: waitAfter.timeoutMs }, signal);
	}
	const after = {
		tabId: entry.tabId,
		url: entry.view.webContents.getURL(),
		snapshotGeneration: entry.refGeneration,
		loading: entry.view.webContents.isLoading(),
		errorCount: entry.errors.length,
	};
	const mutationCountAfter = await readMutationCount(entry);
	return {
		...(raw && typeof raw === "object" ? (raw as Record<string, unknown>) : { value: raw }),
		evidence: {
			before,
			after,
			effects: {
				navigated: before.url !== after.url,
				documentChanged:
					before.snapshotGeneration !== after.snapshotGeneration || mutationCountBefore !== mutationCountAfter,
				newErrorCount: Math.max(0, after.errorCount - before.errorCount),
			},
			...(target ? { target: { label: target.label, locator: target.locator, remapped: target.remapped === true } } : {}),
			recommendedAction: "Observe the target again and verify the intended postcondition.",
		},
	};
}

async function readMutationCount(entry: BrowserEntry): Promise<number> {
	await ensureDebugger(entry);
	try {
		const response = (await entry.view.webContents.debugger.sendCommand("Runtime.evaluate", {
			expression: `(() => {
				const key = "__ao_browser_action_evidence__";
				let state = globalThis[key];
				if (!state || state.document !== document) {
					state = {document, count: 0};
					state.observer = new MutationObserver(() => { state.count += 1; });
					state.observer.observe(document, {subtree:true, childList:true, attributes:true, characterData:true});
					globalThis[key] = state;
				}
				return state.count;
			})()`,
			returnByValue: true,
		})) as { result?: { value?: unknown } };
		return typeof response.result?.value === "number" ? response.result.value : 0;
	} catch {
		// Navigation can replace the execution context between the action and the
		// evidence read. URL/generation evidence still records that transition.
		return 0;
	}
}

async function clickEntry(
	entry: BrowserEntry,
	target: ResolvedBrowserTarget | undefined,
	button: "left" | "right",
	clickCount: number,
): Promise<unknown> {
	if (!target) throw browserError("REFERENCE_REQUIRED", "ref or semantic target is required");
	const point = await pointerPoint(entry, target.objectId, target.label);
	await entry.view.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
		type: "mousePressed",
		x: point.x,
		y: point.y,
		button,
		clickCount,
	});
	await entry.view.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
		type: "mouseReleased",
		x: point.x,
		y: point.y,
		button,
		clickCount,
	});
	return { target: target.label, x: point.x, y: point.y, button, clickCount, url: entry.view.webContents.getURL() };
}

async function uploadEntry(
	entry: BrowserEntry,
	target: ResolvedBrowserTarget | undefined,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	if (!target) throw browserError("REFERENCE_REQUIRED", "ref or semantic target is required");
	const files = Array.isArray(args.files) && args.files.every((file) => typeof file === "string")
		? args.files as string[]
		: [];
	if (files.length === 0) throw browserError("INVALID_ARGUMENT", "files are required");
	await ensureDebugger(entry);
	await entry.view.webContents.debugger.sendCommand("DOM.setFileInputFiles", { files, objectId: target.objectId });
	return { target: target.label, fileCount: files.length, url: entry.view.webContents.getURL() };
}

async function dragEntry(entry: BrowserEntry, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	const sourceRef = stringArg(args, "sourceRef", "INVALID_ARGUMENT", "sourceRef is required");
	const targetRef = stringArg(args, "targetRef", "INVALID_ARGUMENT", "targetRef is required");
	const source = await resolveTarget(entry, { ref: sourceRef, allowStaleRemap: args.allowStaleRemap });
	const target = await resolveTarget(entry, { ref: targetRef, allowStaleRemap: args.allowStaleRemap });
	if (!source || !target) throw browserError("REFERENCE_REQUIRED", "sourceRef and targetRef are required");
	const from = await pointerPoint(entry, source.objectId, source.label);
	const to = await pointerPoint(entry, target.objectId, target.label);
	const debuggerAPI = entry.view.webContents.debugger;
	await debuggerAPI.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
	await debuggerAPI.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: to.x, y: to.y, button: "left", buttons: 1 });
	await debuggerAPI.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });
	return { source: source.label, target: target.label, from, to, url: entry.view.webContents.getURL() };
}

async function fillEntry(entry: BrowserEntry, target: ResolvedBrowserTarget | undefined, text: string): Promise<unknown> {
	if (!target) throw browserError("REFERENCE_REQUIRED", "ref or semantic target is required");
	await entry.view.webContents.debugger.sendCommand("Runtime.callFunctionOn", {
		objectId: target.objectId,
		functionDeclaration: `function(next){
			this.scrollIntoView({block:'center',inline:'center'});
			this.focus();
			const proto = Object.getPrototypeOf(this);
			const descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
			if (descriptor && descriptor.set) descriptor.set.call(this, next); else this.value = next;
			this.dispatchEvent(new Event('input', {bubbles:true, composed:true}));
			this.dispatchEvent(new Event('change', {bubbles:true, composed:true}));
		}`,
		arguments: [{ value: text }],
		awaitPromise: true,
	});
	return { target: target.label, value: text, url: entry.view.webContents.getURL() };
}

async function typeEntry(entry: BrowserEntry, target: ResolvedBrowserTarget | undefined, text: string): Promise<unknown> {
	if (!target) throw browserError("REFERENCE_REQUIRED", "ref or semantic target is required");
	await entry.view.webContents.debugger.sendCommand("Runtime.callFunctionOn", {
		objectId: target.objectId,
		functionDeclaration:
			"function(){ this.scrollIntoView({block:'center',inline:'center'}); this.focus(); }",
	});
	await entry.view.webContents.debugger.sendCommand("Input.insertText", { text });
	return { target: target.label, text, url: entry.view.webContents.getURL() };
}

type BrowserKey = {
	key: string;
	code: string;
	keyCode: number;
	text?: string;
	modifiers: number;
};

const NAMED_KEYS: Record<string, Omit<BrowserKey, "modifiers">> = {
	enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
	tab: { key: "Tab", code: "Tab", keyCode: 9, text: "\t" },
	escape: { key: "Escape", code: "Escape", keyCode: 27 },
	esc: { key: "Escape", code: "Escape", keyCode: 27 },
	backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
	delete: { key: "Delete", code: "Delete", keyCode: 46 },
	home: { key: "Home", code: "Home", keyCode: 36 },
	end: { key: "End", code: "End", keyCode: 35 },
	pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
	pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
	arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
	arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
	arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
	arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
	space: { key: " ", code: "Space", keyCode: 32, text: " " },
};

function parseBrowserKey(input: string): BrowserKey {
	const parts = input
		.split("+")
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length === 0) throw browserError("INVALID_ARGUMENT", "key is required");
	let modifiers = 0;
	for (const modifier of parts.slice(0, -1)) {
		switch (modifier.toLowerCase()) {
			case "alt":
				modifiers |= 1;
				break;
			case "control":
			case "ctrl":
				modifiers |= 2;
				break;
			case "meta":
			case "command":
			case "cmd":
				modifiers |= 4;
				break;
			case "shift":
				modifiers |= 8;
				break;
			default:
				throw browserError("INVALID_ARGUMENT", `Unsupported key modifier: ${modifier}`);
		}
	}
	const rawKey = parts.at(-1)!;
	const named = NAMED_KEYS[rawKey.toLowerCase()];
	if (named) {
		return {
			...named,
			text: modifiers & (1 | 2 | 4) ? undefined : named.text,
			modifiers,
		};
	}
	if ([...rawKey].length !== 1) {
		throw browserError("INVALID_ARGUMENT", `Unsupported key: ${rawKey}`);
	}
	const rawIsLetter = /^[a-zA-Z]$/.test(rawKey);
	const key = rawIsLetter ? (modifiers & 8 ? rawKey.toUpperCase() : rawKey.toLowerCase()) : rawKey;
	const upper = key.toUpperCase();
	const isLetter = /^[A-Z]$/.test(upper);
	const isDigit = /^\d$/.test(key);
	return {
		key,
		code: isLetter ? `Key${upper}` : isDigit ? `Digit${key}` : "",
		keyCode: upper.charCodeAt(0),
		text: modifiers & (1 | 2 | 4) ? undefined : key,
		modifiers,
	};
}

async function pressEntry(entry: BrowserEntry, input: string): Promise<unknown> {
	await ensureDebugger(entry);
	const key = parseBrowserKey(input);
	const params = {
		key: key.key,
		code: key.code,
		windowsVirtualKeyCode: key.keyCode,
		nativeVirtualKeyCode: key.keyCode,
		modifiers: key.modifiers,
		...(key.text === undefined ? {} : { text: key.text, unmodifiedText: key.text }),
	};
	await entry.view.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
		type: key.text === undefined ? "rawKeyDown" : "keyDown",
		...params,
	});
	await entry.view.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
		type: "keyUp",
		...params,
		text: undefined,
		unmodifiedText: undefined,
	});
	return { key: input, url: entry.view.webContents.getURL() };
}

async function hoverEntry(entry: BrowserEntry, target: ResolvedBrowserTarget): Promise<unknown> {
	const point = await pointerPoint(entry, target.objectId, target.label);
	await entry.view.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
		type: "mouseMoved",
		x: point.x,
		y: point.y,
	});
	return { target: target.label, x: point.x, y: point.y, url: entry.view.webContents.getURL() };
}

async function highlightEntry(entry: BrowserEntry, target: ResolvedBrowserTarget): Promise<unknown> {
	await entry.view.webContents.debugger.sendCommand("Overlay.enable");
	await entry.view.webContents.debugger.sendCommand("Overlay.highlightNode", {
		objectId: target.objectId,
		highlightConfig: {
			showInfo: false,
			showStyles: false,
			showRulers: false,
			contentColor: { r: 59, g: 130, b: 246, a: 0.18 },
			borderColor: { r: 37, g: 99, b: 235, a: 1 },
			paddingColor: { r: 96, g: 165, b: 250, a: 0.12 },
			marginColor: { r: 147, g: 197, b: 253, a: 0.08 },
		},
	});
	return { target: target.label, url: entry.view.webContents.getURL() };
}

async function unhighlightEntry(entry: BrowserEntry): Promise<unknown> {
	await ensureDebugger(entry);
	await entry.view.webContents.debugger.sendCommand("Overlay.enable");
	await entry.view.webContents.debugger.sendCommand("Overlay.hideHighlight");
	return { url: entry.view.webContents.getURL() };
}

function quadCenter(quad: number[] | undefined): { x: number; y: number } | undefined {
	if (!quad || quad.length < 8) return undefined;
	const xs = [quad[0], quad[2], quad[4], quad[6]];
	const ys = [quad[1], quad[3], quad[5], quad[7]];
	return {
		x: xs.reduce((sum, value) => sum + value, 0) / xs.length,
		y: ys.reduce((sum, value) => sum + value, 0) / ys.length,
	};
}

async function scrollEntry(entry: BrowserEntry, rawDirection: string, amount: number): Promise<unknown> {
	await ensureDebugger(entry);
	const direction = rawDirection.toLowerCase();
	const deltas: Record<string, { deltaX: number; deltaY: number }> = {
		up: { deltaX: 0, deltaY: -amount },
		down: { deltaX: 0, deltaY: amount },
		left: { deltaX: -amount, deltaY: 0 },
		right: { deltaX: amount, deltaY: 0 },
	};
	const delta = deltas[direction];
	if (!delta) {
		throw browserError("INVALID_ARGUMENT", "direction must be up, down, left, or right");
	}
	const viewport = (await entry.view.webContents.debugger.sendCommand("Runtime.evaluate", {
		expression: "({x: Math.max(0, innerWidth / 2), y: Math.max(0, innerHeight / 2)})",
		returnByValue: true,
	})) as { result?: { value?: { x?: number; y?: number } } };
	await entry.view.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
		type: "mouseWheel",
		x: viewport.result?.value?.x ?? 0,
		y: viewport.result?.value?.y ?? 0,
		...delta,
	});
	return { direction, amount, url: entry.view.webContents.getURL() };
}

async function selectEntry(entry: BrowserEntry, target: ResolvedBrowserTarget | undefined, value: string): Promise<unknown> {
	if (!target) throw browserError("REFERENCE_REQUIRED", "ref or semantic target is required");
	const response = (await entry.view.webContents.debugger.sendCommand("Runtime.callFunctionOn", {
		objectId: target.objectId,
		functionDeclaration: `function(next){
			if (!(this instanceof HTMLSelectElement)) return {supported:false};
			const values = Array.isArray(next) ? next : [next];
			const matched = Array.from(this.options).some((option) => values.includes(option.value));
			if (!matched) return {supported:true, matched:false, value:this.value};
			for (const option of this.options) option.selected = values.includes(option.value);
			this.dispatchEvent(new Event('input', {bubbles:true, composed:true}));
			this.dispatchEvent(new Event('change', {bubbles:true, composed:true}));
			return {supported:true, matched:true, value:this.value};
		}`,
		arguments: [{ value }],
		returnByValue: true,
	})) as { result?: { value?: { supported?: boolean; matched?: boolean; value?: string } } };
	if (!response.result?.value?.supported) {
		throw browserError("INVALID_ELEMENT_STATE", `Element ${target.label} is not a select control`);
	}
	if (!response.result.value.matched) {
		throw browserError("INVALID_ARGUMENT", `Select option ${JSON.stringify(value)} does not exist`);
	}
	return { target: target.label, value: response.result.value.value, url: entry.view.webContents.getURL() };
}

async function checkEntry(entry: BrowserEntry, target: ResolvedBrowserTarget | undefined, checked: boolean): Promise<unknown> {
	if (!target) throw browserError("REFERENCE_REQUIRED", "ref or semantic target is required");
	const response = (await entry.view.webContents.debugger.sendCommand("Runtime.callFunctionOn", {
		objectId: target.objectId,
		functionDeclaration: `function(next){
			if (!('checked' in this)) return {supported:false};
			if (Boolean(this.checked) !== Boolean(next)) this.click();
			return {supported:true, checked:Boolean(this.checked)};
		}`,
		arguments: [{ value: checked }],
		returnByValue: true,
	})) as { result?: { value?: { supported?: boolean; checked?: boolean } } };
	if (!response.result?.value?.supported) {
		throw browserError("INVALID_ELEMENT_STATE", `Element ${target.label} is not checkable`);
	}
	if (response.result.value.checked !== checked) {
		throw browserError("ELEMENT_NOT_INTERACTABLE", `Element ${target.label} did not change checked state`);
	}
	return { target: target.label, checked: response.result.value.checked, url: entry.view.webContents.getURL() };
}

async function getEntry(entry: BrowserEntry, property: string, refName?: string): Promise<unknown> {
	const normalized = property.toLowerCase();
	if (!refName) {
		if (normalized === "url") return { property: normalized, value: entry.view.webContents.getURL() };
		if (normalized === "title") return { property: normalized, value: entry.view.webContents.getTitle() };
		if (normalized !== "text") {
			throw browserError("INVALID_ARGUMENT", "page property must be url, title, or text");
		}
		await ensureDebugger(entry);
		const response = (await entry.view.webContents.debugger.sendCommand("Runtime.evaluate", {
			expression: "document.body ? document.body.innerText : ''",
			returnByValue: true,
		})) as { result?: { value?: unknown } };
		return {
			property: normalized,
			value: markUntrusted(externalText(response.result?.value)),
			untrustedExternalContent: true,
		};
	}
	if (!["text", "value", "checked"].includes(normalized)) {
		throw browserError("INVALID_ARGUMENT", "element property must be text, value, or checked");
	}
	const objectId = await resolveRef(entry, refName);
	const response = (await entry.view.webContents.debugger.sendCommand("Runtime.callFunctionOn", {
		objectId,
		functionDeclaration: `function(property){
			if (property === 'text') return this.innerText ?? this.textContent ?? '';
			if (property === 'value') return this.value ?? '';
			if (property === 'checked') return Boolean(this.checked);
		}`,
		arguments: [{ value: normalized }],
		returnByValue: true,
	})) as { result?: { value?: unknown } };
	const value =
		normalized === "text" ? markUntrusted(externalText(response.result?.value)) : response.result?.value;
	return {
		ref: refName,
		property: normalized,
		value,
		url: entry.view.webContents.getURL(),
		...(normalized === "text" ? { untrustedExternalContent: true } : {}),
	};
}

async function resolveRef(entry: BrowserEntry, refName: string): Promise<string> {
	await ensureDebugger(entry);
	const ref = entry.refs.get(refName);
	if (!ref || ref.generation !== entry.refGeneration) {
		throw browserError("STALE_REFERENCE", `Element reference ${refName} is stale; run ao browser snapshot again`);
	}
	try {
		const resolved = (await entry.view.webContents.debugger.sendCommand("DOM.resolveNode", {
			backendNodeId: ref.backendNodeId,
		})) as { object?: { objectId?: string } };
		if (!resolved.object?.objectId) throw new Error("node has no runtime object");
		return resolved.object.objectId;
	} catch {
		entry.refs.delete(refName);
		throw browserError("STALE_REFERENCE", `Element reference ${refName} is stale; run ao browser snapshot again`);
	}
}

async function waitForEntry(entry: BrowserEntry, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
	const fixedMS = numberArg(args.ms, 0, 60_000);
	if (fixedMS > 0) {
		await delay(fixedMS, signal);
		return { waitedMs: fixedMS, url: entry.view.webContents.getURL() };
	}
	const timeoutMS = numberArg(args.timeoutMs, 1, 55_000) || 10_000;
	const stableMS = numberArg(args.stableMs, 1, 10_000);
	let expression = "";
	let condition = "";
	let valueSatisfies = (value: unknown): boolean => value === true;
	if (typeof args.text === "string" && args.text) {
		expression = `Boolean(document.body && document.body.innerText.includes(${JSON.stringify(args.text)}))`;
		condition = `text ${JSON.stringify(args.text)}`;
	} else if (typeof args.textGone === "string" && args.textGone) {
		expression = `Boolean(!document.body || !document.body.innerText.includes(${JSON.stringify(args.textGone)}))`;
		condition = `text ${JSON.stringify(args.textGone)} to disappear`;
	} else if (typeof args.selector === "string" && args.selector) {
		expression = `Boolean(document.querySelector(${JSON.stringify(args.selector)}))`;
		condition = `selector ${JSON.stringify(args.selector)}`;
	} else if (typeof args.selectorGone === "string" && args.selectorGone) {
		expression = `Boolean(!document.querySelector(${JSON.stringify(args.selectorGone)}))`;
		condition = `selector ${JSON.stringify(args.selectorGone)} to disappear`;
	} else if (typeof args.url === "string" && args.url) {
		expression = `location.href.includes(${JSON.stringify(args.url)})`;
		condition = `URL ${JSON.stringify(args.url)}`;
	} else if (args.load === true) {
		expression = "document.readyState === 'complete'";
		condition = "page load completion";
	} else if (stableMS > 0) {
		expression = `(() => {
			const key = "__ao_browser_dom_stability__";
			let state = globalThis[key];
			if (!state || state.document !== document) {
				state = {document, lastMutation: performance.now()};
				state.observer = new MutationObserver(() => { state.lastMutation = performance.now(); });
				state.observer.observe(document, {
					subtree: true,
					childList: true,
					attributes: true,
					characterData: true,
				});
				globalThis[key] = state;
			}
			return performance.now() - state.lastMutation;
		})()`;
		condition = `DOM stability for ${stableMS}ms`;
		valueSatisfies = (value) => typeof value === "number" && value >= stableMS;
	} else {
		throw browserError(
			"INVALID_ARGUMENT",
			"wait requires text, textGone, selector, selectorGone, url, load, stableMs, or ms",
		);
	}
	await ensureDebugger(entry);
	const deadline = Date.now() + timeoutMS;
	try {
		while (Date.now() <= deadline) {
			throwIfAborted(signal);
			if (args.load === true && entry.view.webContents.isLoading()) {
				await delay(100, signal);
				continue;
			}
			let evaluated: {
				result?: { value?: unknown };
				exceptionDetails?: { text?: string };
			};
			try {
				evaluated = (await entry.view.webContents.debugger.sendCommand("Runtime.evaluate", {
					expression,
					returnByValue: true,
				})) as typeof evaluated;
			} catch {
				// Navigations and HMR can briefly replace the execution context. Retry
				// until the requested condition or timeout rather than failing early.
				await delay(100, signal);
				continue;
			}
			if (evaluated.exceptionDetails) {
				throw browserError(
					"INVALID_ARGUMENT",
					evaluated.exceptionDetails.text ?? `Unable to evaluate wait condition ${condition}`,
				);
			}
			if (valueSatisfies(evaluated.result?.value)) {
				return { condition, url: entry.view.webContents.getURL() };
			}
			await delay(100, signal);
		}
		throw browserError("WAIT_TIMEOUT", `Timed out after ${timeoutMS}ms waiting for ${condition}`);
	} finally {
		if (stableMS > 0) {
			try {
				await entry.view.webContents.debugger.sendCommand("Runtime.evaluate", {
					expression: `(() => {
						const key = "__ao_browser_dom_stability__";
						const state = globalThis[key];
						state?.observer?.disconnect();
						delete globalThis[key];
					})()`,
				});
			} catch {
				// Navigation may have already destroyed the observed document.
			}
		}
	}
}

async function screenshotEntry(entry: BrowserEntry, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	await ensureDebugger(entry);
	let image: NativeImage;
	const mode = typeof args.mode === "string" ? args.mode : "viewport";
	if (mode === "full-page") {
		const metrics = (await entry.view.webContents.debugger.sendCommand("Page.getLayoutMetrics")) as {
			cssContentSize?: { width?: number; height?: number };
			contentSize?: { width?: number; height?: number };
		};
		const response = (await entry.view.webContents.debugger.sendCommand("Page.captureScreenshot", {
			format: "png",
			captureBeyondViewport: true,
			fromSurface: true,
		})) as { data?: string };
		if (!response.data) throw browserError("BROWSER_COMMAND_FAILED", "Browser screenshot is empty");
		const contentSize = metrics.cssContentSize ?? metrics.contentSize ?? {};
		return {
			mimeType: "image/png",
			data: response.data,
			width: Math.round(contentSize.width ?? 0),
			height: Math.round(contentSize.height ?? 0),
			url: entry.view.webContents.getURL(),
			mode,
			untrustedExternalContent: true,
		};
	}
	if (mode === "element") {
		const target = await resolveTarget(entry, args);
		if (!target) throw browserError("REFERENCE_REQUIRED", "ref or semantic target is required");
		const box = (await entry.view.webContents.debugger.sendCommand("DOM.getBoxModel", { objectId: target.objectId })) as {
			model?: { border?: number[]; content?: number[] };
		};
		const quad = box.model?.border ?? box.model?.content;
		if (!quad || quad.length < 8) throw browserError("ELEMENT_NOT_VISIBLE", "Element has no visible box");
		const xs = [quad[0], quad[2], quad[4], quad[6]];
		const ys = [quad[1], quad[3], quad[5], quad[7]];
		const rect = {
			x: Math.floor(Math.min(...xs)), y: Math.floor(Math.min(...ys)),
			width: Math.max(1, Math.ceil(Math.max(...xs) - Math.min(...xs))),
			height: Math.max(1, Math.ceil(Math.max(...ys) - Math.min(...ys))),
		};
		image = await entry.view.webContents.capturePage(rect);
	} else if (mode === "viewport") {
		image = await entry.view.webContents.capturePage();
	} else {
		throw browserError("INVALID_ARGUMENT", "screenshot mode must be viewport, full-page, or element");
	}
	if (image.isEmpty()) throw browserError("BROWSER_COMMAND_FAILED", "Browser screenshot is empty");
	const size = image.getSize();
	return {
		mimeType: "image/png",
		data: image.toPNG().toString("base64"),
		width: size.width,
		height: size.height,
		url: entry.view.webContents.getURL(),
		mode,
		untrustedExternalContent: true,
	};
}

async function framesEntry(entry: BrowserEntry): Promise<Record<string, unknown>> {
	await ensureDebugger(entry);
	const response = (await entry.view.webContents.debugger.sendCommand("Page.getFrameTree")) as {
		frameTree?: { frame: { id: string; parentId?: string; url?: string; name?: string }; childFrames?: unknown[] };
	};
	const frames: Array<Record<string, unknown>> = [];
	const visit = (tree: typeof response.frameTree, depth: number) => {
		if (!tree) return;
		frames.push({ frameId: tree.frame.id, parentFrameId: tree.frame.parentId, url: tree.frame.url ?? "", name: tree.frame.name ?? "", depth });
		for (const child of tree.childFrames ?? []) visit(child as typeof response.frameTree, depth + 1);
	};
	visit(response.frameTree, 0);
	return { frames, untrustedExternalContent: true };
}

async function handleDialogEntry(entry: BrowserEntry, accept: boolean, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	await ensureDebugger(entry);
	if (!entry.dialog) throw browserError("DIALOG_NOT_OPEN", "No JavaScript dialog is open");
	const handled = entry.dialog;
	await entry.view.webContents.debugger.sendCommand("Page.handleJavaScriptDialog", {
		accept,
		...(accept && typeof args.promptText === "string" ? { promptText: args.promptText } : {}),
	});
	entry.dialog = undefined;
	return { handled: true, accepted: accept, type: handled.type };
}

async function viewportEntry(entry: BrowserEntry): Promise<Record<string, unknown>> {
	await ensureDebugger(entry);
	const response = (await entry.view.webContents.debugger.sendCommand("Page.getLayoutMetrics")) as {
		cssVisualViewport?: { clientWidth?: number; clientHeight?: number; scale?: number };
	};
	return { width: response.cssVisualViewport?.clientWidth ?? 0, height: response.cssVisualViewport?.clientHeight ?? 0, scale: response.cssVisualViewport?.scale ?? 1 };
}

async function setViewportEntry(entry: BrowserEntry, args: Record<string, unknown>): Promise<Record<string, unknown>> {
	await ensureDebugger(entry);
	const width = numberArg(args.width, 320, 3840);
	const height = numberArg(args.height, 240, 2160);
	if (!width || !height) throw browserError("INVALID_ARGUMENT", "viewport width and height are required");
	const deviceScaleFactor = typeof args.deviceScaleFactor === "number" ? Math.max(0.5, Math.min(4, args.deviceScaleFactor)) : 1;
	await entry.view.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
		width, height, deviceScaleFactor, mobile: args.mobile === true,
	});
	invalidateRefs(entry);
	return { width, height, deviceScaleFactor, mobile: args.mobile === true };
}

function stringArg(
	args: Record<string, unknown>,
	name: string,
	code: string,
	message: string,
	allowEmpty = false,
): string {
	const value = args[name];
	if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw browserError(code, message);
	return value;
}

function numberArg(value: unknown, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(min, Math.min(max, Math.round(value)));
}

function networkDurationArg(value: unknown): number {
	if (value === undefined) return DEFAULT_NETWORK_CAPTURE_SECONDS;
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > MAX_NETWORK_CAPTURE_SECONDS
	) {
		throw browserError(
			"INVALID_ARGUMENT",
			`network capture duration must be an integer from 1 to ${MAX_NETWORK_CAPTURE_SECONDS} seconds`,
		);
	}
	return value;
}

function stringValue(value: AXValue | undefined): string {
	return typeof value?.value === "string" ? value.value : value?.value == null ? "" : String(value.value);
}

function compactText(value: string): string {
	return value.replace(/\s+/g, " ").replace(/\"/g, '\\"').trim().slice(0, 240);
}

function normalizeAgentBrowserURL(input: string): string {
	const raw = input.trim();
	if (!raw) throw browserError("URL_REQUIRED", "url is required");
	if (isWindowsAbsolutePath(raw) || isPosixAbsolutePath(raw) || /^file:/i.test(raw)) {
		throw browserError("BROWSER_URL_FORBIDDEN", "Agent browser commands cannot open local files");
	}
	if (!/^https?:\/\//i.test(raw) && !isLocalhostLike(raw) && !looksLikeHost(raw)) {
		throw browserError("INVALID_URL", "ao browser open requires an explicit http(s) URL or hostname");
	}
	const normalized = normalizeBrowserURL(raw);
	if (normalized.protocol !== "http:" && normalized.protocol !== "https:") {
		throw browserError("BROWSER_URL_FORBIDDEN", "Agent browser commands support only http(s) URLs");
	}
	return normalized.href;
}

async function pointerPoint(
	entry: BrowserEntry,
	objectId: string,
	refName: string,
): Promise<{ x: number; y: number }> {
	await entry.view.webContents.debugger.sendCommand("Runtime.callFunctionOn", {
		objectId,
		functionDeclaration: "function(){ this.scrollIntoView({block:'center',inline:'center'}); this.focus(); }",
	});
	const response = (await entry.view.webContents.debugger.sendCommand("DOM.getBoxModel", { objectId })) as {
		model?: { border?: number[]; content?: number[] };
	};
	const pagePoint = quadCenter(response.model?.border ?? response.model?.content);
	if (!pagePoint) throw browserError("ELEMENT_NOT_VISIBLE", `Element ${refName} has no visible box`);
	const metrics = (await entry.view.webContents.debugger.sendCommand("Page.getLayoutMetrics")) as {
		cssVisualViewport?: { pageX?: number; pageY?: number };
		visualViewport?: { pageX?: number; pageY?: number };
	};
	const viewport = metrics.cssVisualViewport ?? metrics.visualViewport ?? {};
	const point = {
		x: pagePoint.x - (viewport.pageX ?? 0),
		y: pagePoint.y - (viewport.pageY ?? 0),
	};
	const hit = (await entry.view.webContents.debugger.sendCommand("Runtime.callFunctionOn", {
		objectId,
		functionDeclaration:
			"function(x,y){ const hit=document.elementFromPoint(x,y); return Boolean(hit && (hit===this || this.contains(hit))); }",
		arguments: [{ value: point.x }, { value: point.y }],
		returnByValue: true,
	})) as { result?: { value?: boolean } };
	if (!hit.result?.value) {
		throw browserError("ELEMENT_NOT_INTERACTABLE", `Element ${refName} is covered or not pointer-interactable`);
	}
	return point;
}

function externalText(value: unknown): string {
	const raw = value == null ? "" : String(value);
	const bytes = Buffer.from(raw, "utf8");
	if (bytes.length <= MAX_EXTERNAL_TEXT_BYTES) return raw;
	return `${bytes.subarray(0, MAX_EXTERNAL_TEXT_BYTES).toString("utf8")}\n[Content truncated at ${MAX_EXTERNAL_TEXT_BYTES} bytes]`;
}

function markUntrusted(value: string): string {
	return `${UNTRUSTED_BEGIN}\n${value}\n${UNTRUSTED_END}`;
}

function markLogMessages(messages: BrowserLogEntry[]): BrowserLogEntry[] {
	return messages.map((message) => ({ ...message, message: markUntrusted(externalText(message.message)) }));
}

function logResult(messages: BrowserLogEntry[], since: unknown): Record<string, unknown> {
	const cursor = typeof since === "number" && Number.isInteger(since) ? Math.max(0, since) : 0;
	return {
		messages: markLogMessages(messages.slice(cursor)),
		cursor: messages.length,
		untrustedExternalContent: true,
	};
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(browserError("BROWSER_COMMAND_CANCELED", "Browser command was canceled"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw browserError("BROWSER_COMMAND_CANCELED", "Browser command was canceled");
}

function browserError(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}
