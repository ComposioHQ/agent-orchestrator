import { describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRemotesIpc } from "./remotes-main";
import { RemoteRegistry } from "./remote-registry";

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

// ipcMain stand-in: records what was registered and lets a test invoke it.
function fakeIpc() {
	const handlers = new Map<string, Handler>();
	return {
		ipcMain: { handle: (channel: string, handler: Handler) => void handlers.set(channel, handler) },
		invoke: (channel: string, ...args: unknown[]) => {
			const handler = handlers.get(channel);
			if (!handler) throw new Error(`no handler for ${channel}`);
			return handler({}, ...args);
		},
		channels: () => [...handlers.keys()].sort(),
	};
}

async function tempFile(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "ao-remotes-main-"));
	const path = join(dir, "remotes.json");
	await writeFile(path, '{"remotes":[{"label":"workbox","url":"http://192.0.2.1:1","password":"old"}]}', "utf8");
	await chmod(path, 0o600);
	return path;
}


function registryOf(closed: string[] = []) {
	return new RemoteRegistry(async (entry) => ({
		base: "http://127.0.0.1:9999/tok",
		url: entry.url,
		close: async () => {
			closed.push(entry.url);
		},
	}));
}

describe("registerRemotesIpc", () => {
	it("registers the saved-host and connection surface", async () => {
		const ipc = fakeIpc();
		registerRemotesIpc(ipc.ipcMain, { file: await tempFile(), registry: registryOf() });
		expect(ipc.channels()).toEqual([
			"remotes:add",
			"remotes:connect",
			"remotes:connected",
			"remotes:disconnect",
			"remotes:list",
			"remotes:probe",
			"remotes:remove",
			"remotes:request",
			"remotes:update",
		]);
	});

	it("lists hosts without their passwords", async () => {
		const ipc = fakeIpc();
		registerRemotesIpc(ipc.ipcMain, { file: await tempFile(), registry: registryOf() });
		await expect(ipc.invoke("remotes:list")).resolves.toEqual([{ label: "workbox", url: "http://192.0.2.1:1" }]);
	});

	it("saves a new host only after it answers as a daemon", async () => {
		const ipc = fakeIpc();
		const file = await tempFile();
		const probe = vi.fn().mockResolvedValueOnce("offline" as const).mockResolvedValueOnce("online" as const);
		registerRemotesIpc(ipc.ipcMain, { file, registry: registryOf(), probe });
		const mini = { label: "mini", url: "http://192.0.2.9:9", password: "m" };

		await expect(ipc.invoke("remotes:add", mini)).resolves.toBe("offline");
		expect(JSON.parse(await readFile(file, "utf8")).remotes).toHaveLength(1);

		await expect(ipc.invoke("remotes:add", mini)).resolves.toBe("online");
		expect(JSON.parse(await readFile(file, "utf8")).remotes).toHaveLength(2);
	});

	it("connects a saved host only after it answers as a daemon, and hands back a password-free view", async () => {
		const ipc = fakeIpc();
		const probe = vi.fn().mockResolvedValueOnce("offline" as const).mockResolvedValueOnce("online" as const);
		registerRemotesIpc(ipc.ipcMain, { file: await tempFile(), registry: registryOf(), probe });

		await expect(ipc.invoke("remotes:connect", "http://192.0.2.1:1")).rejects.toThrow(/is offline/);
		await expect(ipc.invoke("remotes:connected")).resolves.toEqual([]);

		const view = await ipc.invoke("remotes:connect", "http://192.0.2.1:1");
		expect(view).toEqual({ label: "workbox", url: "http://192.0.2.1:1", base: "http://127.0.0.1:9999/tok" });
		expect(JSON.stringify(await ipc.invoke("remotes:connected"))).not.toContain("old");
	});

	it("removing a connected host closes its proxy", async () => {
		const ipc = fakeIpc();
		const closed: string[] = [];
		registerRemotesIpc(ipc.ipcMain, { file: await tempFile(), registry: registryOf(closed), probe: async () => "online" });
		await ipc.invoke("remotes:connect", "http://192.0.2.1:1");
		await ipc.invoke("remotes:remove", "http://192.0.2.1:1");
		expect(closed).toEqual(["http://192.0.2.1:1"]);
		await expect(ipc.invoke("remotes:connected")).resolves.toEqual([]);
	});

	it("disconnect closes the proxy and forgets the view", async () => {
		const ipc = fakeIpc();
		const closed: string[] = [];
		registerRemotesIpc(ipc.ipcMain, { file: await tempFile(), registry: registryOf(closed), probe: async () => "online" });
		await ipc.invoke("remotes:connect", "http://192.0.2.1:1");
		await ipc.invoke("remotes:disconnect", "http://192.0.2.1:1");
		expect(closed).toEqual(["http://192.0.2.1:1"]);
		await expect(ipc.invoke("remotes:connected")).resolves.toEqual([]);
	});
});
