import type { AoBridge } from "../../preload";
import { coerceUiSettings, DEFAULT_UI_SETTINGS } from "../../shared/ui-locale";
export type { FeatureBuild } from "../../main/feature-builds";

const previewCloudAccount = {
	authProvider: "google" as const,
	user: { id: "preview-user", email: "preview@ao.dev", displayName: "Preview User" },
	organizations: [{ id: "preview-org", slug: "preview", displayName: "Preview Organization", role: "owner" }],
	storedAt: new Date(0).toISOString(),
};

let previewCloudProject: { id: string; name: string; path: string; kind: "single_repo"; sessionPrefix: string } | null = null;
let previewCloudOperation: {
	operationId: string;
	orgId: string;
	state: "pending" | "ready";
	defaultBranch: string;
	projectId?: string;
	createdAt: string;
	updatedAt: string;
} | null = null;

export const aoBridge: AoBridge =
	window.ao ??
	({
		app: {
			getVersion: async () => "0.0.0-preview",
			chooseDirectory: async () => null,
			openExternal: async (url: string) => {
				window.open(url, "_blank", "noopener,noreferrer");
			},
			scanImportFolder: async ({ path }) => ({ path, repos: [] }),
			checkAncestorRepo: async () => undefined,
			getPathForFile: () => "",
			onOpenFolderPath: () => () => undefined,
			onNewSessionShortcut: () => () => undefined,
			onKeyboardShortcutsHelp: () => () => undefined,
			onNewShellTerminalShortcut: () => () => undefined,
			onCloseShellTerminalShortcut: () => () => undefined,
			setCloseShellTerminalShortcutEnabled: () => undefined,
			onOpenSettingsShortcut: () => () => undefined,
			onPreviousSessionShortcut: () => () => undefined,
			onNextSessionShortcut: () => () => undefined,
			onPreviousTabShortcut: () => () => undefined,
			onNextTabShortcut: () => () => undefined,
			onFocusTerminalShortcut: () => () => undefined,
		},
		terminal: {
			saveDroppedFile: async () => "",
			setFocused: () => undefined,
			onFontSizeShortcut: () => () => undefined,
		},
		window: {
			isMaximized: async () => false,
			onMaximized: () => () => undefined,
			isFullScreen: async () => false,
			onFullScreen: () => () => undefined,
		},
		theme: {
			set: async () => undefined,
		},
		menu: {
			action: async () => undefined,
			notifyShellFocus: () => undefined,
		},
		clipboard: {
			writeText: async (text: string) => {
				if (navigator.clipboard?.writeText) {
					await navigator.clipboard.writeText(text);
				}
			},
			readText: async () => (navigator.clipboard?.readText ? navigator.clipboard.readText() : ""),
		},
		daemon: {
			getStatus: async () => ({
				state: "stopped",
				message: "Electron preload is not available in browser preview.",
			}),
			start: async () => ({ state: "starting" }),
			stop: async () => ({ state: "stopped" }),
			restart: async () => ({ state: "starting" }),
			onStatus: () => () => undefined,
		},
		editorHandoff: {
			getState: async () => ({
				targets: [],
				preferredEditorId: "cursor",
				workspaceAvailable: false,
				unavailableReason: "Desktop app is required to open a workspace.",
			}),
			open: async () => {
				throw new Error("Desktop app is required to open a workspace.");
			},
		},
		telemetry: {
			getBootstrap: async () => null,
		},
		browser: {
			nativeCompositionEnabled: false,
			ensure: async (sessionId: string) => ({
				viewId: `preview:${sessionId}`,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			setBounds: () => undefined,
			setOverlayOpen: () => undefined,
			navigate: async ({ viewId, url }) => ({
				viewId,
				url,
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			clear: async (viewId: string) => ({
				viewId,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			goBack: async (viewId: string) => ({
				viewId,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			goForward: async (viewId: string) => ({
				viewId,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			reload: async (viewId: string) => ({
				viewId,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			stop: async (viewId: string) => ({
				viewId,
				url: "",
				title: "",
				canGoBack: false,
				canGoForward: false,
				isLoading: false,
			}),
			getTabs: async (viewId: string) => ({ viewId, activeTabId: "t1", tabs: [] }),
			selectTab: async ({ viewId, tabId }) => ({ viewId, activeTabId: tabId, tabs: [] }),
			closeTab: async ({ viewId }) => ({ viewId, activeTabId: "", tabs: [] }),
			openTab: async ({ viewId }) => ({ viewId, activeTabId: "", tabs: [] }),
			devtools: async ({ viewId, operation }) => ({
				viewId,
				open: operation !== "close",
				activeTabId: "",
			}),
			destroy: () => undefined,
			setAnnotationMode: async () => undefined,
			onNavState: () => () => undefined,
			onTabsState: () => () => undefined,
			onAgentActivity: () => () => undefined,
			onDevToolsState: () => () => undefined,
			onAnnotationSubmit: () => () => undefined,
			onAnnotationCancel: () => () => undefined,
		},
		notifications: {
			show: async () => undefined,
			setBadge: async () => undefined,
			devBounce: async () => undefined,
			onClick: () => () => undefined,
		},
		tray: {
			setAttentionState: () => undefined,
			onOpenSession: () => () => undefined,
		},
		appState: {
			getMigration: async () => ({ status: "pending" }),
			setMigration: async () => undefined,
		},
		updateSettings: {
			get: async () => ({ enabled: false, channel: "latest", nightlyAck: false, feature: null }),
			set: async () => undefined,
		},
		uiSettings: {
			get: async () => ({ ...DEFAULT_UI_SETTINGS }),
			set: async (settings) => coerceUiSettings({ ...DEFAULT_UI_SETTINGS, ...settings }),
		},
		keybindings: {
			get: async () => ({}),
			set: async (overrides) => overrides,
			setRecording: async () => undefined,
		},
		updates: {
			getStatus: async () => ({ state: "idle" }),
			check: async () => undefined,
			returnHome: async () => undefined,
			download: async () => undefined,
			install: async () => undefined,
			onStatus: () => () => undefined,
			onTelemetry: () => () => undefined,
		},
		featureBuilds: {
			list: async () => [],
			getActive: async () => null,
		},
		cloud: {
			getAvailability: async () => ({ available: true, enabled: true }),
			getSession: async () => previewCloudAccount,
			listProjects: async () => ({
				groups: [{ organization: previewCloudAccount.organizations[0], projects: previewCloudProject ? [previewCloudProject] : [] }],
			}),
			createProject: async (input) => {
				const now = new Date().toISOString();
				previewCloudProject = {
					id: "preview-project",
					name: input.displayName,
					path: "/sandbox/preview-project",
					kind: "single_repo",
					sessionPrefix: "preview",
				};
				previewCloudOperation = {
					operationId: "preview-operation",
					orgId: input.organizationId,
					state: "pending",
					defaultBranch: input.defaultBranch,
					createdAt: now,
					updatedAt: now,
				};
				return previewCloudOperation;
			},
			getProjectOperation: async () => {
				if (!previewCloudOperation || !previewCloudProject) throw new Error("Cloud project operation not found.");
				previewCloudOperation = {
					...previewCloudOperation,
					state: "ready",
					projectId: previewCloudProject.id,
					updatedAt: new Date().toISOString(),
				};
				return previewCloudOperation;
			},
			startProjectSession: async (input) => ({
				session: {
					id: "preview-session",
					projectId: input.projectId,
					kind: "orchestrator",
					harness: input.harness ?? "codex",
					displayName: "Cloud orchestrator",
					activity: { state: "active", lastActivityAt: new Date().toISOString() },
					isTerminated: false,
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
					status: "working",
					autoInjectCI: false,
					autoInjectReview: false,
					autoReviewEnabled: false,
					pinned: false,
					prs: [],
				},
			}),
			signIn: async () => previewCloudAccount,
			signOut: async () => undefined,
			onSessionChanged: () => () => undefined,
		},
	} satisfies AoBridge);
