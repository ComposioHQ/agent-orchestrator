// The workspace registry: which machines this client can run agents on.
//
// A *workspace* is a machine that runs its own AO daemon. The laptop is always
// workspace `local` and is not stored. A remote workspace is an SSH target whose
// daemon the supervisor reaches through a loopback port-forward, so the daemon
// on the far side keeps its `127.0.0.1`-only bind (backend/internal/config:
// LoopbackHost) and AO gains no network-facing listener.
//
// This module is pure: no node:*, no electron. The Electron main process owns
// the fs reads/writes (see main/workspace-registry.ts), which is the same split
// ui-locale.ts / main/ui-settings.ts already uses. Keeping it pure also keeps it
// importable from the renderer for the workspace switcher's types.
//
// Semantics ported from `sess` (github.com/deepaksilaych/sess, MIT): a named
// remote registry, and the explicit > active > single-configured > local
// resolution order.

/** The reserved id for the machine the client itself runs on. Never stored. */
export const LOCAL_WORKSPACE_ID = "local";

/**
 * Workspace ids are lowercase kebab: they appear in error strings, in the
 * ControlPath hash input, and (eventually) in URLs, and a case-insensitive
 * filesystem must not be able to collide two of them.
 */
const WORKSPACE_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const WORKSPACE_ID_MAX_LENGTH = 32;

export type RemoteWorkspace = {
	/** Stable id, unique across the registry and never `local`. */
	id: string;
	/**
	 * Exactly what the user would type after `ssh`: a plain `user@host`, or
	 * (preferred) a `Host` alias from their own ~/.ssh/config, so ProxyJump,
	 * Match, IdentityAgent and friends keep working. AO reads no keys and writes
	 * no known_hosts — it shells out to the user's own ssh client, for the same
	 * reason docs/stack.md shells out to git rather than embedding go-git.
	 */
	sshTarget: string;
	/** Optional human label for the switcher; falls back to the id. */
	displayName?: string;
	/**
	 * The loopback port the remote daemon binds, when it is not the default. The
	 * remote reads AO_PORT the same way the local one does (backend/internal/
	 * config: DefaultPort), so a VM running a non-default daemon needs this to be
	 * reachable. Absent means the default.
	 */
	remotePort?: number;
};

export type WorkspaceRegistry = {
	/**
	 * The workspace the client is currently pointed at, or undefined when the
	 * user has never chosen one.
	 *
	 * The distinction matters: `undefined` lets the single-registered-remote rule
	 * in resolveWorkspace apply, while an explicit `"local"` pins the laptop and
	 * must never be overridden. Collapsing the two would silently move a user who
	 * clicked "Local" onto their VM the moment they registered one.
	 */
	activeId?: string;
	remotes: RemoteWorkspace[];
};

export const DEFAULT_WORKSPACE_REGISTRY: WorkspaceRegistry = {
	remotes: [],
};

/** Human label for a workspace, for the switcher and for error messages. */
export function workspaceLabel(workspace: RemoteWorkspace): string {
	return workspace.displayName?.trim() || workspace.id;
}

export type WorkspaceValidationError = { field: "id" | "sshTarget"; message: string };

/**
 * Validate a single remote entry. Returns null when it is usable. Callers
 * surface the message verbatim, so it is phrased for a user, not a log.
 */
export function validateRemoteWorkspace(
	input: Pick<RemoteWorkspace, "id" | "sshTarget">,
): WorkspaceValidationError | null {
	const id = input.id.trim();
	if (id === "") return { field: "id", message: "Workspace id is required." };
	if (id === LOCAL_WORKSPACE_ID) {
		return { field: "id", message: `"${LOCAL_WORKSPACE_ID}" is reserved for this machine.` };
	}
	if (id.length > WORKSPACE_ID_MAX_LENGTH) {
		return { field: "id", message: `Workspace id must be at most ${WORKSPACE_ID_MAX_LENGTH} characters.` };
	}
	if (!WORKSPACE_ID_PATTERN.test(id)) {
		return {
			field: "id",
			message: "Workspace id must be lowercase letters, digits and single dashes (e.g. build-vm).",
		};
	}

	const target = input.sshTarget.trim();
	if (target === "") return { field: "sshTarget", message: "SSH target is required." };
	// The target is passed to the user's ssh client as one argv element, never
	// through a shell, so shell metacharacters are not an injection vector here.
	// Whitespace is still rejected: it is always a typo (`ssh -p 22 host` pasted
	// whole), and accepting it would make the ControlPath hash input ambiguous.
	if (/\s/.test(target)) {
		return { field: "sshTarget", message: "SSH target must not contain spaces. Use a ~/.ssh/config Host alias." };
	}
	// A leading `-` would be parsed by ssh as a flag rather than a destination.
	if (target.startsWith("-")) {
		return { field: "sshTarget", message: "SSH target must not start with a dash." };
	}
	return null;
}

function coerceRemote(value: unknown): RemoteWorkspace | null {
	if (typeof value !== "object" || value === null) return null;
	const candidate = value as Partial<RemoteWorkspace>;
	if (typeof candidate.id !== "string" || typeof candidate.sshTarget !== "string") return null;
	const id = candidate.id.trim();
	const sshTarget = candidate.sshTarget.trim();
	if (validateRemoteWorkspace({ id, sshTarget })) return null;

	const remote: RemoteWorkspace = { id, sshTarget };
	const displayName = typeof candidate.displayName === "string" ? candidate.displayName.trim() : "";
	if (displayName !== "") remote.displayName = displayName;
	// An out-of-range port is dropped to the default rather than rejecting the
	// whole entry: the workspace is still usable, just on the standard port.
	if (isValidPort(candidate.remotePort)) remote.remotePort = candidate.remotePort;
	return remote;
}

function isValidPort(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/**
 * Coerce parsed JSON into a registry, dropping anything unusable rather than
 * throwing: a hand-edited or partially-written workspaces.json must never stop
 * the app from booting into the local workspace. Duplicate ids keep the first
 * occurrence, so the file stays deterministic.
 */
export function coerceWorkspaceRegistry(value: unknown): WorkspaceRegistry {
	if (typeof value !== "object" || value === null) return { ...DEFAULT_WORKSPACE_REGISTRY };
	const candidate = value as Partial<WorkspaceRegistry>;

	const remotes: RemoteWorkspace[] = [];
	const seen = new Set<string>();
	if (Array.isArray(candidate.remotes)) {
		for (const entry of candidate.remotes) {
			const remote = coerceRemote(entry);
			if (!remote || seen.has(remote.id)) continue;
			seen.add(remote.id);
			remotes.push(remote);
		}
	}

	// An activeId naming a remote that did not survive coercion is dropped to
	// undefined rather than leaving the client pointed at nothing. `local` is
	// preserved verbatim: it is a real choice, not a missing one.
	const rawActive = typeof candidate.activeId === "string" ? candidate.activeId.trim() : "";
	const activeId = rawActive === LOCAL_WORKSPACE_ID || seen.has(rawActive) ? rawActive : undefined;

	return activeId === undefined ? { remotes } : { activeId, remotes };
}

/**
 * The workspace to connect to, in `sess`'s resolution order:
 *
 *   1. an explicit id (a `--workspace` flag or a switcher click),
 *   2. the persisted active id — including an explicit `local`,
 *   3. the single configured remote, when exactly one is registered and the
 *      user has never chosen,
 *   4. local.
 *
 * Rule 3 makes the single-VM case (the motivating one) zero-ceremony on first
 * run, and rule 2 is what stops it from overriding a deliberate "Local" — which
 * is why LOCAL_WORKSPACE_ID is a nameable value rather than just an absence.
 *
 * Returns null for the local workspace, or the remote to dial. An explicit id
 * that resolves to nothing is an error, never a silent fallthrough to local:
 * running an agent on the wrong machine is not a recoverable mistake.
 */
export function resolveWorkspace(
	registry: WorkspaceRegistry,
	explicitId?: string,
): { workspace: RemoteWorkspace | null } | { error: string } {
	const byId = (id: string) => registry.remotes.find((remote) => remote.id === id) ?? null;

	if (explicitId !== undefined && explicitId !== "") {
		if (explicitId === LOCAL_WORKSPACE_ID) return { workspace: null };
		const explicit = byId(explicitId);
		return explicit ? { workspace: explicit } : { error: `Unknown workspace "${explicitId}".` };
	}

	if (registry.activeId === LOCAL_WORKSPACE_ID) return { workspace: null };
	if (registry.activeId !== undefined) {
		const active = byId(registry.activeId);
		// coerceWorkspaceRegistry already guarantees this resolves for a file-backed
		// registry, but one may also be built in memory. Fall through rather than
		// error: no caller asked for this id in this call.
		if (active) return { workspace: active };
	}

	if (registry.remotes.length === 1) return { workspace: registry.remotes[0] };

	return { workspace: null };
}
