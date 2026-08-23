import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE_SHELL_TERMINAL_SHORTCUT_CHANNEL, FOCUS_TERMINAL_SHORTCUT_CHANNEL, KEYBOARD_SHORTCUTS_HELP_CHANNEL, NEXT_SESSION_SHORTCUT_CHANNEL, NEXT_TAB_SHORTCUT_CHANNEL, NEW_SESSION_SHORTCUT_CHANNEL, NEW_SHELL_TERMINAL_SHORTCUT_CHANNEL, OPEN_SETTINGS_SHORTCUT_CHANNEL, PREVIOUS_SESSION_SHORTCUT_CHANNEL, PREVIOUS_TAB_SHORTCUT_CHANNEL, SET_CLOSE_SHELL_TERMINAL_SHORTCUT_ENABLED_CHANNEL } from "./shared/shortcuts";
import type { AoBridge } from "./preload";

const electronMocks = vi.hoisted(() => {
	const listeners = new Map<string, (...args: unknown[]) => void>();
	return {
		exposeInMainWorld: vi.fn(),
		invoke: vi.fn(),
		listeners,
		off: vi.fn(),
		on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
			listeners.set(channel, listener);
		}),
		send: vi.fn(),
	};
});

vi.mock("electron", () => ({
	contextBridge: { exposeInMainWorld: electronMocks.exposeInMainWorld },
	ipcRenderer: {
		invoke: electronMocks.invoke,
		off: electronMocks.off,
		on: electronMocks.on,
		send: electronMocks.send,
	},
}));

await import("./preload");

function exposedBridge(): AoBridge {
	const call = electronMocks.exposeInMainWorld.mock.calls.find(([key]) => key === "ao");
	if (!call) throw new Error("preload bridge was not exposed");
	return call[1] as AoBridge;
}

beforeEach(() => {
	electronMocks.listeners.clear();
	electronMocks.invoke.mockClear();
	electronMocks.off.mockClear();
	electronMocks.on.mockClear();
	electronMocks.send.mockClear();
});

describe("preload new-session shortcut bridge", () => {
	it("delivers the IPC event and removes the exact wrapped listener", () => {
		const listener = vi.fn();
		const dispose = exposedBridge().app.onNewSessionShortcut(listener);
		const wrapped = electronMocks.listeners.get(NEW_SESSION_SHORTCUT_CHANNEL);
		expect(wrapped).toBeTypeOf("function");

		wrapped?.({});
		expect(listener).toHaveBeenCalledTimes(1);

		dispose();
		expect(electronMocks.off).toHaveBeenCalledWith(NEW_SESSION_SHORTCUT_CHANNEL, wrapped);
	});
});

describe("preload keyboard-shortcuts help bridge", () => {
	it("delivers the IPC event and removes the exact wrapped listener", () => {
		const listener = vi.fn();
		const dispose = exposedBridge().app.onKeyboardShortcutsHelp(listener);
		const wrapped = electronMocks.listeners.get(KEYBOARD_SHORTCUTS_HELP_CHANNEL);
		expect(wrapped).toBeTypeOf("function");

		wrapped?.({});
		expect(listener).toHaveBeenCalledTimes(1);

		dispose();
		expect(electronMocks.off).toHaveBeenCalledWith(KEYBOARD_SHORTCUTS_HELP_CHANNEL, wrapped);
	});
});

describe("preload application shortcut bridges", () => {
	it("reports whether the active view has a closeable shell terminal", () => {
		exposedBridge().app.setCloseShellTerminalShortcutEnabled(true);

		expect(electronMocks.send).toHaveBeenCalledWith(SET_CLOSE_SHELL_TERMINAL_SHORTCUT_ENABLED_CHANNEL, true);
	});

	it.each([
		[NEW_SHELL_TERMINAL_SHORTCUT_CHANNEL, (listener: () => void) => exposedBridge().app.onNewShellTerminalShortcut(listener)],
		[CLOSE_SHELL_TERMINAL_SHORTCUT_CHANNEL, (listener: () => void) => exposedBridge().app.onCloseShellTerminalShortcut(listener)],
		[OPEN_SETTINGS_SHORTCUT_CHANNEL, (listener: () => void) => exposedBridge().app.onOpenSettingsShortcut(listener)],
		[
			PREVIOUS_SESSION_SHORTCUT_CHANNEL,
			(listener: () => void) => exposedBridge().app.onPreviousSessionShortcut(listener),
		],
		[NEXT_SESSION_SHORTCUT_CHANNEL, (listener: () => void) => exposedBridge().app.onNextSessionShortcut(listener)],
		[PREVIOUS_TAB_SHORTCUT_CHANNEL, (listener: () => void) => exposedBridge().app.onPreviousTabShortcut(listener)],
		[NEXT_TAB_SHORTCUT_CHANNEL, (listener: () => void) => exposedBridge().app.onNextTabShortcut(listener)],
		[FOCUS_TERMINAL_SHORTCUT_CHANNEL, (listener: () => void) => exposedBridge().app.onFocusTerminalShortcut(listener)],
	] as const)("delivers and disposes %s", (channel, subscribe) => {
		const listener = vi.fn();
		const dispose = subscribe(listener);
		const wrapped = electronMocks.listeners.get(channel);

		wrapped?.({});
		expect(listener).toHaveBeenCalledTimes(1);

		dispose();
		expect(electronMocks.off).toHaveBeenCalledWith(channel, wrapped);
	});
});

describe("preload keybinding recording bridge", () => {
	it("tells the main process when shortcut capture starts and stops", async () => {
		await exposedBridge().keybindings.setRecording(true);
		await exposedBridge().keybindings.setRecording(false);

		expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, "keybindings:setRecording", true);
		expect(electronMocks.invoke).toHaveBeenNthCalledWith(2, "keybindings:setRecording", false);
	});
});

describe("preload uiSettings bridge", () => {
	it("invokes get and set over IPC", async () => {
		electronMocks.invoke.mockResolvedValueOnce({ locale: "en" });
		electronMocks.invoke.mockResolvedValueOnce({ locale: "zh-CN" });

		await expect(exposedBridge().uiSettings.get()).resolves.toEqual({ locale: "en" });
		await expect(exposedBridge().uiSettings.set({ locale: "zh-CN" })).resolves.toEqual({ locale: "zh-CN" });

		expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, "uiSettings:get");
		expect(electronMocks.invoke).toHaveBeenNthCalledWith(2, "uiSettings:set", { locale: "zh-CN" });
	});
});

describe("preload browser profile bridge", () => {
	it("routes profile state, native menu, and CRUD calls over IPC", async () => {
		const bridge = exposedBridge();
		await bridge.browser.getProfile("1:worker-1");
		await bridge.browser.showProfileMenu({
			viewId: "1:worker-1",
			bounds: { x: 1, y: 2, width: 3, height: 4 },
			labels: {
				temporary: "Temporary",
				manage: "Manage",
				switchTitle: "Switch",
				switchMessage: "Reload",
				switchDetail: "Unsaved",
				cancel: "No",
				confirm: "Yes",
			},
		});
		await bridge.browser.historySuggestions({ viewId: "1:worker-1", query: "git" });
		await bridge.browserProfiles.list();
		await bridge.browserProfiles.create("Work");
		await bridge.browserProfiles.rename({ id: "profile-id", name: "Personal" });
		await bridge.browserProfiles.clear("profile-id");
		await bridge.browserProfiles.delete("profile-id");
		await bridge.browserProfiles.discoverImportSources();
		await bridge.browserProfiles.import({
			requestId: "11111111-1111-4111-8111-111111111111",
			sourceId: "a".repeat(32),
			profileIds: ["b".repeat(32)],
			includeCookies: true,
			includeHistory: true,
			destination: { mode: "merge", name: "Work" },
		});

		expect(electronMocks.invoke).toHaveBeenNthCalledWith(1, "browser:profile:get", "1:worker-1");
		expect(electronMocks.invoke).toHaveBeenNthCalledWith(2, "browser:profile:menu", expect.objectContaining({ viewId: "1:worker-1" }));
		expect(electronMocks.invoke).toHaveBeenNthCalledWith(3, "browser:history:suggest", { viewId: "1:worker-1", query: "git" });
		expect(electronMocks.invoke).toHaveBeenNthCalledWith(4, "browserProfiles:list");
		expect(electronMocks.invoke).toHaveBeenNthCalledWith(5, "browserProfiles:create", { name: "Work" });
		expect(electronMocks.invoke).toHaveBeenNthCalledWith(6, "browserProfiles:rename", { id: "profile-id", name: "Personal" });
		expect(electronMocks.invoke).toHaveBeenNthCalledWith(7, "browserProfiles:clear", { id: "profile-id" });
		expect(electronMocks.invoke).toHaveBeenNthCalledWith(8, "browserProfiles:delete", { id: "profile-id" });
		expect(electronMocks.invoke).toHaveBeenNthCalledWith(9, "browserProfiles:import:discover");
		expect(electronMocks.invoke).toHaveBeenNthCalledWith(10, "browserProfiles:import:start", expect.objectContaining({ destination: { mode: "merge", name: "Work" } }));
	});

	it("validates profile-management event payloads and removes wrapped listeners", () => {
		const bridge = exposedBridge();
		const stateListener = vi.fn();
		const stateDispose = bridge.browser.onProfileState(stateListener);
		const stateWrapped = electronMocks.listeners.get("browser:profileState");
		stateWrapped?.({}, { viewId: "1:worker-1", profileId: null, temporary: true });
		expect(stateListener).toHaveBeenCalledWith({ viewId: "1:worker-1", profileId: null, temporary: true });
		stateDispose();
		expect(electronMocks.off).toHaveBeenCalledWith("browser:profileState", stateWrapped);

		const manageListener = vi.fn();
		const manageDispose = bridge.browser.onProfileManage(manageListener);
		const manageWrapped = electronMocks.listeners.get("browser:profileManage");
		manageWrapped?.({}, { viewId: "1:worker-1" });
		manageWrapped?.({}, { viewId: 42 });
		expect(manageListener).toHaveBeenCalledTimes(1);
		expect(manageListener).toHaveBeenCalledWith("1:worker-1");
		manageDispose();
		expect(electronMocks.off).toHaveBeenCalledWith("browser:profileManage", manageWrapped);

		const progressListener = vi.fn();
		const progressDispose = bridge.browserProfiles.onImportProgress(progressListener);
		const progressWrapped = electronMocks.listeners.get("browserProfiles:import:progress");
		progressWrapped?.({}, { requestId: "request", phase: "reading", completed: 1, total: 2 });
		expect(progressListener).toHaveBeenCalledWith({ requestId: "request", phase: "reading", completed: 1, total: 2 });
		progressDispose();
		expect(electronMocks.off).toHaveBeenCalledWith("browserProfiles:import:progress", progressWrapped);
	});
});
