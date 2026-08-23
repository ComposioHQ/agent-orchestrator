import { describe, expect, it } from "vitest";
import { createWebBridge } from "./bridge";

describe("createWebBridge", () => {
	it("exposes live terminals without native Electron capabilities", () => {
		const bridge = createWebBridge();

		expect(bridge.capabilities).toEqual({
			terminals: true,
			nativeBrowserPanel: false,
			windowChrome: false,
			daemonControl: false,
			nativeFileDialogs: false,
			osNotifications: false,
			filePathDrop: false,
		});
		expect(Object.isFrozen(bridge.capabilities)).toBe(true);
	});
});
