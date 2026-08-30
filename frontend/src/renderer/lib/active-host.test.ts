import { beforeEach, describe, expect, it, vi } from "vitest";
import { aoBridge } from "./bridge";
import { setApiBaseUrl } from "./api-client";
import { initHosts } from "./active-host";
import { baseUrlFor, forgetHost } from "./host-clients";
import { useUiStore } from "../stores/ui-store";

const WORKBOX = "http://192.0.2.1:3011";
const MINI = "http://192.0.2.9:3011";

beforeEach(() => {
	localStorage.clear();
	forgetHost(WORKBOX);
	forgetHost(MINI);
	setApiBaseUrl(null);
	vi.restoreAllMocks();
	useUiStore.setState({ remoteHosts: true });
});

function savedHosts() {
	vi.spyOn(aoBridge.remotes, "list").mockResolvedValue([
		{ label: "workbox", url: WORKBOX },
		{ label: "mini", url: MINI },
	]);
	vi.spyOn(aoBridge.remotes, "connect").mockImplementation(async (url) => ({
		label: url === WORKBOX ? "workbox" : "mini",
		url,
		base: url === WORKBOX ? "http://127.0.0.1:9001/one" : "http://127.0.0.1:9002/two",
	}));
}

describe("remoteHosts flag", () => {
	it("never reads the saved hosts while the flag is off", async () => {
		useUiStore.setState({ remoteHosts: false });
		savedHosts();

		await initHosts();

		expect(aoBridge.remotes.list).not.toHaveBeenCalled();
		expect(aoBridge.remotes.connect).not.toHaveBeenCalled();
		expect(baseUrlFor(WORKBOX)).toBeNull();
	});

	it("connects the saved hosts when the flag is turned on", async () => {
		useUiStore.setState({ remoteHosts: false });
		savedHosts();
		await initHosts();
		expect(baseUrlFor(MINI)).toBeNull();

		useUiStore.getState().setRemoteHosts(true);

		await vi.waitFor(() => expect(baseUrlFor(MINI)).toBe("http://127.0.0.1:9002/two"));
		expect(baseUrlFor(WORKBOX)).toBe("http://127.0.0.1:9001/one");
	});

	it("disconnects every remote host when the flag is turned off", async () => {
		savedHosts();
		const disconnect = vi.spyOn(aoBridge.remotes, "disconnect").mockResolvedValue(undefined);
		await initHosts();
		expect(baseUrlFor(WORKBOX)).not.toBeNull();

		useUiStore.getState().setRemoteHosts(false);

		await vi.waitFor(() => expect(disconnect).toHaveBeenCalledTimes(2));
		expect(disconnect).toHaveBeenCalledWith(WORKBOX);
		expect(disconnect).toHaveBeenCalledWith(MINI);
		expect(baseUrlFor(WORKBOX)).toBeNull();
		expect(baseUrlFor(MINI)).toBeNull();
	});
});

describe("multi-host boot", () => {
	it("connects every saved host", async () => {
		savedHosts();

		await initHosts();

		expect(aoBridge.remotes.connect).toHaveBeenCalledTimes(2);
		expect(baseUrlFor(WORKBOX)).toBe("http://127.0.0.1:9001/one");
		expect(baseUrlFor(MINI)).toBe("http://127.0.0.1:9002/two");
	});

	it("keeps connecting other saved hosts when one is unavailable", async () => {
		vi.spyOn(aoBridge.remotes, "list").mockResolvedValue([
			{ label: "workbox", url: WORKBOX },
			{ label: "mini", url: MINI },
		]);
		vi.spyOn(aoBridge.remotes, "connect").mockImplementation(async (url) => {
			if (url === WORKBOX) throw new Error("offline");
			return { label: "mini", url, base: "http://127.0.0.1:9002/two" };
		});

		await initHosts();

		expect(baseUrlFor(WORKBOX)).toBeNull();
		expect(baseUrlFor(MINI)).toBe("http://127.0.0.1:9002/two");
	});

	it("treats an unreadable saved-host list as no remote hosts", async () => {
		vi.spyOn(aoBridge.remotes, "list").mockRejectedValue(new Error("chmod 600 required"));

		await expect(initHosts()).resolves.toBeUndefined();
		expect(baseUrlFor(WORKBOX)).toBeNull();
		expect(baseUrlFor(MINI)).toBeNull();
	});
});
