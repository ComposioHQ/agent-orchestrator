import { beforeEach, describe, expect, it, vi } from "vitest";

// emulatorEnabled initializes from localStorage at module load, so each case
// resets modules and re-imports to exercise the real initialization path.
describe("ui-store emulatorEnabled persistence", () => {
	beforeEach(() => {
		window.localStorage.clear();
		vi.resetModules();
	});

	it("defaults to off when nothing is stored", async () => {
		const { useUiStore } = await import("./ui-store");
		expect(useUiStore.getState().emulatorEnabled).toBe(false);
	});

	it("restores an enabled flag from stored ao.emulatorEnabled=true", async () => {
		window.localStorage.setItem("ao.emulatorEnabled", "true");
		const { useUiStore } = await import("./ui-store");
		expect(useUiStore.getState().emulatorEnabled).toBe(true);
	});

	it('treats any non-"true" stored value as off', async () => {
		window.localStorage.setItem("ao.emulatorEnabled", "1");
		const { useUiStore } = await import("./ui-store");
		expect(useUiStore.getState().emulatorEnabled).toBe(false);
	});

	it("setEmulatorEnabled writes localStorage and updates state", async () => {
		const { useUiStore } = await import("./ui-store");
		useUiStore.getState().setEmulatorEnabled(true);
		expect(useUiStore.getState().emulatorEnabled).toBe(true);
		expect(window.localStorage.getItem("ao.emulatorEnabled")).toBe("true");
		useUiStore.getState().setEmulatorEnabled(false);
		expect(useUiStore.getState().emulatorEnabled).toBe(false);
		expect(window.localStorage.getItem("ao.emulatorEnabled")).toBe("false");
	});
});
