// Validation for the remote daemon root URL used by the desktop's remote
// mode. Shared by the Electron main process (which refuses to start the
// loopback proxy for an invalid URL) and the renderer's settings form.
//
// The URL must be a plain HTTPS origin: Tailscale Serve terminates TLS for
// the authenticated daemon listener, and anything else (plaintext http,
// embedded credentials, query/fragment, a sub-path) is either unsafe or
// meaningless for API rooting.

/** The daemon API compatibility version this build of the desktop supports. */
export const SUPPORTED_DAEMON_API_VERSION = 1;

/** Outcome of a "Test and connect" attempt. code is a machine-readable class
 * (a DaemonFailureCode for probe failures, "invalid_input" for URL/password
 * validation); message is human-facing and carries no credentials. */
export type RemoteConnectResult = { ok: true } | { ok: false; code: string; message: string };

/** What the renderer is allowed to know about the saved remote connection.
 * The password is never included — only whether one is stored. */
export type RemoteDaemonConfigView = {
	mode: import("./daemon-status").DaemonConnectionMode;
	url?: string;
	hasPassword: boolean;
	/** false when the OS keychain is unavailable and the password must be
	 * re-entered after every app launch. */
	passwordPersistent: boolean;
};

export type RemoteUrlResult =
	| { ok: true; url: string } // normalized: no trailing slash
	| { ok: false; reason: string };

/**
 * Validate and normalize a remote daemon root URL. Returns the normalized
 * origin (scheme + host + port, no trailing slash) on success, or a
 * human-readable rejection reason.
 */
export function validateRemoteUrl(raw: string): RemoteUrlResult {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return { ok: false, reason: "Enter the remote daemon URL." };
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return { ok: false, reason: "That is not a valid URL." };
	}
	if (parsed.protocol !== "https:") {
		return { ok: false, reason: "Remote daemon URLs must use HTTPS (Tailscale Serve)." };
	}
	if (parsed.username !== "" || parsed.password !== "") {
		return { ok: false, reason: "Do not embed credentials in the URL — enter the password separately." };
	}
	if (parsed.search !== "") {
		return { ok: false, reason: "The URL must not contain a query string." };
	}
	if (parsed.hash !== "") {
		return { ok: false, reason: "The URL must not contain a fragment." };
	}
	if (parsed.pathname !== "" && parsed.pathname !== "/") {
		return { ok: false, reason: "Enter the daemon root URL only — no path." };
	}
	return { ok: true, url: parsed.origin };
}
