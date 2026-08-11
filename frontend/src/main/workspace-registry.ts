import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
	coerceWorkspaceRegistry,
	DEFAULT_WORKSPACE_REGISTRY,
	LOCAL_WORKSPACE_ID,
	validateRemoteWorkspace,
	type RemoteWorkspace,
	type WorkspaceRegistry,
} from "../shared/workspaces";

export { LOCAL_WORKSPACE_ID } from "../shared/workspaces";
export type { RemoteWorkspace, WorkspaceRegistry } from "../shared/workspaces";

/**
 * File holding the remote-workspace registry under the ~/.ao state dir.
 *
 * Supervisor state, not daemon state: it names which daemons this client can
 * connect to, so it cannot live in any one daemon's SQLite — reaching the
 * registry must not require the machine it points at to be up. The precedent is
 * the other supervisor-owned JSON under ~/.ao (running.json, mobile/config.json,
 * ui-settings.json), and it holds no credentials: an SSH target is a hostname,
 * and key material stays with the user's own ssh client.
 */
export const WORKSPACES_FILE_NAME = "workspaces.json";

let registryOperationQueue: Promise<void> = Promise.resolve();

function registryFile(stateDir: string): string {
	return path.join(stateDir, WORKSPACES_FILE_NAME);
}

async function readRegistryUnlocked(stateDir: string): Promise<WorkspaceRegistry> {
	let raw: string;
	try {
		raw = await readFile(registryFile(stateDir), "utf8");
	} catch {
		return { ...DEFAULT_WORKSPACE_REGISTRY };
	}
	try {
		return coerceWorkspaceRegistry(JSON.parse(raw));
	} catch {
		// A truncated or hand-mangled file must not stop the app from booting into
		// the local workspace, which is exactly the incumbent behaviour.
		return { ...DEFAULT_WORKSPACE_REGISTRY };
	}
}

async function writeRegistryUnlocked(stateDir: string, registry: WorkspaceRegistry): Promise<WorkspaceRegistry> {
	const next = coerceWorkspaceRegistry(registry);
	await mkdir(stateDir, { recursive: true, mode: 0o750 });
	const data = `${JSON.stringify(next, null, 2)}\n`;
	const tmp = path.join(stateDir, `.workspaces-${process.pid}-${Date.now()}.json`);
	await writeFile(tmp, data, { mode: 0o600 });
	await rename(tmp, registryFile(stateDir));
	return next;
}

function runRegistryOperation<T>(operation: () => Promise<T>): Promise<T> {
	const queued = registryOperationQueue.then(operation, operation);
	registryOperationQueue = queued.then(
		() => undefined,
		() => undefined,
	);
	return queued;
}

/** Read the registry, tolerating a missing or corrupt file (returns defaults). */
export async function readWorkspaceRegistry(stateDir: string): Promise<WorkspaceRegistry> {
	return readRegistryUnlocked(stateDir);
}

/**
 * Read-modify-write the registry under the serialising queue, so two IPC calls
 * arriving together cannot lose one another's edit through a read-then-write
 * race. The mutator may throw to abort without writing.
 */
async function updateWorkspaceRegistry(
	stateDir: string,
	mutate: (current: WorkspaceRegistry) => WorkspaceRegistry,
): Promise<WorkspaceRegistry> {
	return runRegistryOperation(async () => {
		const current = await readRegistryUnlocked(stateDir);
		return writeRegistryUnlocked(stateDir, mutate(current));
	});
}

/** Thrown for user-correctable registry edits; the message is surfaced verbatim. */
export class WorkspaceRegistryError extends Error {}

/** Register a remote workspace. Rejects a duplicate id rather than overwriting. */
export async function addRemoteWorkspace(stateDir: string, input: RemoteWorkspace): Promise<WorkspaceRegistry> {
	const invalid = validateRemoteWorkspace(input);
	if (invalid) throw new WorkspaceRegistryError(invalid.message);
	return updateWorkspaceRegistry(stateDir, (current) => {
		if (current.remotes.some((remote) => remote.id === input.id.trim())) {
			throw new WorkspaceRegistryError(`Workspace "${input.id.trim()}" already exists.`);
		}
		return { ...current, remotes: [...current.remotes, input] };
	});
}

/**
 * Remove a remote workspace. Removing the active one falls back to an explicit
 * `local` rather than to undefined: the user is mid-session on this client, and
 * silently re-triggering the single-remote auto-select would move them onto a
 * different VM.
 */
export async function removeRemoteWorkspace(stateDir: string, id: string): Promise<WorkspaceRegistry> {
	return updateWorkspaceRegistry(stateDir, (current) => {
		const remotes = current.remotes.filter((remote) => remote.id !== id);
		if (remotes.length === current.remotes.length) {
			throw new WorkspaceRegistryError(`Unknown workspace "${id}".`);
		}
		return current.activeId === id
			? { activeId: LOCAL_WORKSPACE_ID, remotes }
			: { ...current, remotes };
	});
}

/** Point the client at a workspace. `local` is a valid, persisted choice. */
export async function setActiveWorkspace(stateDir: string, id: string): Promise<WorkspaceRegistry> {
	return updateWorkspaceRegistry(stateDir, (current) => {
		if (id !== LOCAL_WORKSPACE_ID && !current.remotes.some((remote) => remote.id === id)) {
			throw new WorkspaceRegistryError(`Unknown workspace "${id}".`);
		}
		return { ...current, activeId: id };
	});
}
