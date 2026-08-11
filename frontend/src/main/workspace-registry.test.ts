import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
	addRemoteWorkspace,
	LOCAL_WORKSPACE_ID,
	readWorkspaceRegistry,
	removeRemoteWorkspace,
	setActiveWorkspace,
	WORKSPACES_FILE_NAME,
	WorkspaceRegistryError,
} from "./workspace-registry";

const vm = { id: "build-vm", sshTarget: "build-vm" };
const gpu = { id: "gpu", sshTarget: "deepak@10.0.0.5" };

let stateDir: string;

beforeEach(async () => {
	stateDir = await mkdtemp(path.join(tmpdir(), "ao-workspaces-"));
});

const registryFile = () => path.join(stateDir, WORKSPACES_FILE_NAME);

describe("readWorkspaceRegistry", () => {
	it("returns the default when the file is absent", async () => {
		expect(await readWorkspaceRegistry(stateDir)).toEqual({ remotes: [] });
	});

	// A hand-mangled or half-written file must never stop the app from booting
	// into the local workspace, which is the incumbent behaviour.
	it.each(["", "{", '{"remotes": "nope"}'])("falls back to the default for %j", async (contents) => {
		await writeFile(registryFile(), contents);
		expect(await readWorkspaceRegistry(stateDir)).toEqual({ remotes: [] });
	});
});

describe("addRemoteWorkspace", () => {
	it("persists a workspace atomically and reads it back", async () => {
		await addRemoteWorkspace(stateDir, vm);
		expect(await readWorkspaceRegistry(stateDir)).toEqual({ remotes: [vm] });
		expect(JSON.parse(await readFile(registryFile(), "utf8"))).toEqual({ remotes: [vm] });
	});

	it("rejects an invalid entry before touching the file", async () => {
		await expect(addRemoteWorkspace(stateDir, { id: "LOCAL", sshTarget: "h" })).rejects.toBeInstanceOf(
			WorkspaceRegistryError,
		);
		expect(await readWorkspaceRegistry(stateDir)).toEqual({ remotes: [] });
	});

	it("rejects a duplicate id rather than overwriting a working target", async () => {
		await addRemoteWorkspace(stateDir, vm);
		await expect(addRemoteWorkspace(stateDir, { ...vm, sshTarget: "impostor" })).rejects.toThrow(/already exists/);
		expect((await readWorkspaceRegistry(stateDir)).remotes).toEqual([vm]);
	});

	// Two IPC calls arriving together must not lose one another through a
	// read-then-write race; every mutation runs on the serialising queue.
	it("serialises concurrent adds", async () => {
		await Promise.all([addRemoteWorkspace(stateDir, vm), addRemoteWorkspace(stateDir, gpu)]);
		const registry = await readWorkspaceRegistry(stateDir);
		expect(registry.remotes.map((remote) => remote.id).sort()).toEqual(["build-vm", "gpu"]);
	});
});

describe("setActiveWorkspace", () => {
	it("persists a remote and an explicit local alike", async () => {
		await addRemoteWorkspace(stateDir, vm);
		expect((await setActiveWorkspace(stateDir, "build-vm")).activeId).toBe("build-vm");
		expect((await setActiveWorkspace(stateDir, LOCAL_WORKSPACE_ID)).activeId).toBe(LOCAL_WORKSPACE_ID);
	});

	it("refuses an unknown id", async () => {
		await expect(setActiveWorkspace(stateDir, "ghost")).rejects.toThrow(/Unknown workspace/);
	});
});

describe("removeRemoteWorkspace", () => {
	it("removes an inactive workspace and leaves the active one alone", async () => {
		await addRemoteWorkspace(stateDir, vm);
		await addRemoteWorkspace(stateDir, gpu);
		await setActiveWorkspace(stateDir, "build-vm");

		const registry = await removeRemoteWorkspace(stateDir, "gpu");
		expect(registry).toEqual({ activeId: "build-vm", remotes: [vm] });
	});

	// Falling back to an explicit local, not to undefined: undefined would
	// re-arm the single-remote auto-select and move the user onto whatever VM
	// happens to be left.
	it("pins local when the active workspace is the one removed", async () => {
		await addRemoteWorkspace(stateDir, vm);
		await addRemoteWorkspace(stateDir, gpu);
		await setActiveWorkspace(stateDir, "gpu");

		const registry = await removeRemoteWorkspace(stateDir, "gpu");
		expect(registry).toEqual({ activeId: LOCAL_WORKSPACE_ID, remotes: [vm] });
	});

	it("refuses an unknown id", async () => {
		await expect(removeRemoteWorkspace(stateDir, "ghost")).rejects.toThrow(/Unknown workspace/);
	});
});
