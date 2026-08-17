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
	| "remote_unauthorized"
	| "remote_unreachable"
	| "remote_tls"
	| "remote_incompatible_api"
	| "remote_disconnected";

// DaemonConnectionMode distinguishes a daemon the app spawned/attached to on
// this machine ("local") from one it reaches through the loopback forwarding
// proxy to a remote host ("remote"). Undefined means local — older statuses
// and every local path leave it unset.
export type DaemonConnectionMode = "local" | "remote";

export type DaemonStatus = {
	state: "starting" | "ready" | "stopped" | "error";
	connection?: DaemonConnectionMode;
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
