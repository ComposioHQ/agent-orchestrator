import { describe, expect, it } from "vitest";
import {
	coerceWorkspaceRegistry,
	LOCAL_WORKSPACE_ID,
	resolveWorkspace,
	validateRemoteWorkspace,
	workspaceLabel,
	type WorkspaceRegistry,
} from "./workspaces";

const vm = { id: "build-vm", sshTarget: "build-vm" };
const other = { id: "gpu", sshTarget: "deepak@10.0.0.5" };

describe("validateRemoteWorkspace", () => {
	it("accepts a kebab id and a bare ssh alias", () => {
		expect(validateRemoteWorkspace(vm)).toBeNull();
		expect(validateRemoteWorkspace(other)).toBeNull();
	});

	it.each([
		["", "id"],
		[LOCAL_WORKSPACE_ID, "id"],
		["Build-VM", "id"],
		["build--vm", "id"],
		["-build", "id"],
		["build-", "id"],
		["b".repeat(33), "id"],
	])("rejects id %j", (id, field) => {
		expect(validateRemoteWorkspace({ id, sshTarget: "host" })?.field).toBe(field);
	});

	it.each(["", "  ", "-p 22 host", "host with space"])("rejects ssh target %j", (sshTarget) => {
		expect(validateRemoteWorkspace({ id: "vm", sshTarget })?.field).toBe("sshTarget");
	});

	it("rejects a target that ssh would parse as a flag", () => {
		expect(validateRemoteWorkspace({ id: "vm", sshTarget: "-oProxyCommand=touch/pwn" })?.field).toBe("sshTarget");
	});
});

describe("workspaceLabel", () => {
	it("falls back to the id when the display name is absent or blank", () => {
		expect(workspaceLabel(vm)).toBe("build-vm");
		expect(workspaceLabel({ ...vm, displayName: "  " })).toBe("build-vm");
		expect(workspaceLabel({ ...vm, displayName: "Build VM" })).toBe("Build VM");
	});
});

describe("coerceWorkspaceRegistry", () => {
	it("returns the default for anything that is not an object", () => {
		for (const value of [null, undefined, 42, "x", []]) {
			expect(coerceWorkspaceRegistry(value)).toEqual({ remotes: [] });
		}
	});

	it("drops unusable entries instead of throwing, so the app still boots", () => {
		const registry = coerceWorkspaceRegistry({
			remotes: [vm, { id: "LOCAL" }, { id: "ok", sshTarget: "" }, null, other],
		});
		expect(registry.remotes).toEqual([vm, other]);
	});

	it("keeps the first of duplicate ids", () => {
		const registry = coerceWorkspaceRegistry({
			remotes: [vm, { id: "build-vm", sshTarget: "impostor" }],
		});
		expect(registry.remotes).toEqual([vm]);
	});

	it("preserves an explicit local activeId", () => {
		expect(coerceWorkspaceRegistry({ activeId: LOCAL_WORKSPACE_ID, remotes: [vm] }).activeId).toBe(LOCAL_WORKSPACE_ID);
	});

	it("drops an activeId whose remote did not survive coercion", () => {
		const registry = coerceWorkspaceRegistry({ activeId: "gone", remotes: [vm] });
		expect(registry.activeId).toBeUndefined();
	});

	it("round-trips a serialized registry", () => {
		const registry: WorkspaceRegistry = { activeId: "gpu", remotes: [vm, other] };
		expect(coerceWorkspaceRegistry(JSON.parse(JSON.stringify(registry)))).toEqual(registry);
	});
});

describe("resolveWorkspace", () => {
	it("prefers an explicit id over the persisted active one", () => {
		const registry: WorkspaceRegistry = { activeId: "gpu", remotes: [vm, other] };
		expect(resolveWorkspace(registry, "build-vm")).toEqual({ workspace: vm });
	});

	it("treats an explicit local as the laptop", () => {
		const registry: WorkspaceRegistry = { activeId: "gpu", remotes: [other] };
		expect(resolveWorkspace(registry, LOCAL_WORKSPACE_ID)).toEqual({ workspace: null });
	});

	it("errors rather than falling back when an explicit id is unknown", () => {
		expect(resolveWorkspace({ remotes: [vm] }, "typo")).toEqual({ error: 'Unknown workspace "typo".' });
	});

	it("uses the persisted active id", () => {
		expect(resolveWorkspace({ activeId: "gpu", remotes: [vm, other] })).toEqual({ workspace: other });
	});

	it("auto-selects the single registered remote when the user has never chosen", () => {
		expect(resolveWorkspace({ remotes: [vm] })).toEqual({ workspace: vm });
	});

	// The regression this file exists for: auto-select must not override a
	// deliberate "Local", or registering one VM silently moves every session.
	it("never overrides an explicit local with the single-remote rule", () => {
		expect(resolveWorkspace({ activeId: LOCAL_WORKSPACE_ID, remotes: [vm] })).toEqual({ workspace: null });
	});

	it("stays local when several remotes are registered and none is active", () => {
		expect(resolveWorkspace({ remotes: [vm, other] })).toEqual({ workspace: null });
	});

	it("stays local for an empty registry", () => {
		expect(resolveWorkspace({ remotes: [] })).toEqual({ workspace: null });
	});
});
