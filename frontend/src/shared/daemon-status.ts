// DaemonStatus is the supervisor → renderer handshake payload, shared by the
// Electron main process (which derives it) and the preload bridge (which types
// the IPC surface). The renderer picks it up through the preload's AoBridge type.
// Machine-readable failure classification for telemetry. `message` is
// human-facing and may contain local paths; `code` is what gets reported.
// Statuses without a code (normal ready, user-initiated stop) are not failures.
export type DaemonFailureCode =
	| "not_configured"
	| "daemon_unreachable"
	| "binary_missing"
	| "spawn_failed"
	| "exited"
	| "port_unconfirmed"
	| "not_ready"
	| "identity_mismatch"
	| "datadir_unwritable"
	// Remote-workspace failures. Each is a distinct remedy, and none of them is
	// evidence that the remote daemon is down — a broken tunnel must never be
	// reported as a dead daemon.
	| "ssh_missing"
	| "host_unreachable"
	| "host_key_changed"
	| "host_key_unverified"
	| "host_auth_failed"
	| "remote_ao_missing";

export type DaemonStatus = {
	state: "starting" | "ready" | "stopped" | "error";
	/**
	 * The workspace this status describes: `local`, or a registered remote id.
	 * `port` is always a loopback port on *this* machine — for a remote
	 * workspace it is the local end of an SSH forward, which is what lets the
	 * renderer address a remote daemon with no changes at all.
	 */
	workspaceId?: string;
	port?: number;
	pid?: number;
	executablePath?: string;
	workingDirectory?: string;
	message?: string;
	// Recent daemon stdout/stderr retained by the Electron supervisor for local
	// troubleshooting. It is never sent to telemetry.
	details?: string;
	code?: DaemonFailureCode;
	exitCode?: number | null;
	signal?: string | null;
};
