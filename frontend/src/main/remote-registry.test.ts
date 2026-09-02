import { describe, expect, it, vi } from "vitest";
import { RemoteRegistry } from "./remote-registry";

const WORKBOX = { label: "workbox", url: "http://192.0.2.1:3011", password: "pw-one" };
const MINI = { label: "mini", url: "http://192.0.2.9:3011", password: "pw-two" };

function fakeProxies() {
	const closed: string[] = [];
	const start = vi.fn(async (entry: { url: string }) => ({
		base: `http://127.0.0.1:9999/${entry.url.replace(/\W/g, "")}`,
		url: entry.url,
		close: async () => {
			closed.push(entry.url);
		},
	}));
	return { start, closed };
}

describe("RemoteRegistry", () => {
	it("keeps several hosts connected at once", async () => {
		const { start } = fakeProxies();
		const registry = new RemoteRegistry(start);
		await registry.connect(WORKBOX);
		await registry.connect(MINI);
		expect(registry.views().map((view) => view.url)).toEqual([WORKBOX.url, MINI.url]);
		expect(start).toHaveBeenCalledTimes(2);
	});

	it("connecting the same url twice reuses the live proxy", async () => {
		const { start } = fakeProxies();
		const registry = new RemoteRegistry(start);
		const first = await registry.connect(WORKBOX);
		const second = await registry.connect(WORKBOX);
		expect(second).toEqual(first);
		expect(start).toHaveBeenCalledTimes(1);
	});

	it("disconnect closes only that host's proxy", async () => {
		const { start, closed } = fakeProxies();
		const registry = new RemoteRegistry(start);
		await registry.connect(WORKBOX);
		await registry.connect(MINI);
		await registry.disconnect(WORKBOX.url);
		expect(closed).toEqual([WORKBOX.url]);
		expect(registry.views().map((view) => view.url)).toEqual([MINI.url]);
	});

	it("disconnecting a host that was never connected is a no-op", async () => {
		const { start, closed } = fakeProxies();
		const registry = new RemoteRegistry(start);
		await expect(registry.disconnect(WORKBOX.url)).resolves.toBeUndefined();
		expect(closed).toEqual([]);
		expect(start).not.toHaveBeenCalled();
	});

	it("never exposes the password", async () => {
		const registry = new RemoteRegistry(fakeProxies().start);
		const view = await registry.connect(WORKBOX);
		expect(JSON.stringify(view)).not.toContain("pw-one");
		expect(JSON.stringify(registry.views())).not.toContain("pw-one");
	});

	it("a host that fails to start does not join the registry", async () => {
		const registry = new RemoteRegistry(async () => {
			throw new Error("EADDRNOTAVAIL");
		});
		await expect(registry.connect(WORKBOX)).rejects.toThrow("EADDRNOTAVAIL");
		expect(registry.views()).toEqual([]);
	});

	it("closeAll tears every proxy down", async () => {
		const { start, closed } = fakeProxies();
		const registry = new RemoteRegistry(start);
		await registry.connect(WORKBOX);
		await registry.connect(MINI);
		await registry.closeAll();
		expect(closed.sort()).toEqual([WORKBOX.url, MINI.url].sort());
		expect(registry.views()).toEqual([]);
	});
});
