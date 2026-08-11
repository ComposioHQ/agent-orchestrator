// Classifying why an `ssh` invocation failed.
//
// OpenSSH exits **255 for its own failures** and otherwise forwards the remote
// command's status, so a bare non-zero exit cannot be attributed to a side. The
// distinction is not cosmetic: a transport failure must never be reported as
// "the remote daemon is down", because the supervisor would then offer to start
// a daemon that is already running fine behind a broken tunnel — and the
// repository's hard rule is that a failed probe is not proof of death.
//
// Pure and node:*-free so the stderr matching can be table-tested.

/** Why a remote workspace could not be reached. Each maps to a distinct remedy. */
export type SshFailureKind =
	/** The host key changed — a real security event, never auto-accepted. */
	| "host_key_changed"
	/** The host is unknown and BatchMode cannot answer the prompt. */
	| "host_key_unverified"
	/** Reached the host; it refused our credentials. */
	| "auth_failed"
	/** Never reached the host: DNS, routing, refused, or timed out. */
	| "unreachable"
	/** No `ssh` binary on this machine. */
	| "ssh_missing"
	/** ssh worked; the remote command itself exited non-zero. */
	| "remote_command_failed";

export type SshFailure = { kind: SshFailureKind; message: string; details: string };

/** The exit status OpenSSH uses for its own failures, as opposed to forwarding. */
export const SSH_TRANSPORT_EXIT_CODE = 255;

// Matched against the local ssh client's stderr. These strings are stable across
// OpenSSH releases; anything unmatched degrades to "unreachable" with the raw
// stderr attached rather than being guessed at.
const HOST_KEY_CHANGED = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i;
const HOST_KEY_UNKNOWN = /No (?:ECDSA |ED25519 |RSA )?host key is known|Host key for .* has changed|not known by any other names/i;
const AUTH_FAILED = /Permission denied|Too many authentication failures|no such identity|Authentication failed/i;

/**
 * Classify a completed ssh invocation. `exitCode` is null when the process died
 * on a signal, which is treated as a transport failure — the same conservative
 * side as an ssh-attributed exit.
 */
export function classifySshFailure(exitCode: number | null, stderr: string, sshTarget: string): SshFailure {
	const details = stderr.trim();

	if (exitCode !== SSH_TRANSPORT_EXIT_CODE && exitCode !== null) {
		return {
			kind: "remote_command_failed",
			message: `The command on ${sshTarget} exited with status ${exitCode}.`,
			details,
		};
	}

	// Order matters: a changed key also prints "Host key verification failed",
	// so the louder, security-relevant case is tested first.
	if (HOST_KEY_CHANGED.test(details) && /IDENTIFICATION HAS CHANGED/i.test(details)) {
		return {
			kind: "host_key_changed",
			message:
				`The host key for ${sshTarget} has changed. This can mean the machine was rebuilt — ` +
				`or that the connection is being intercepted. Verify the new key, then remove the old ` +
				`entry from ~/.ssh/known_hosts yourself.`,
			details,
		};
	}
	if (HOST_KEY_UNKNOWN.test(details) || HOST_KEY_CHANGED.test(details)) {
		return {
			kind: "host_key_unverified",
			message:
				`${sshTarget} is not in your known_hosts. Connect once yourself with ` +
				`\`ssh ${sshTarget}\` and accept the key, so you see the fingerprint before trusting it.`,
			details,
		};
	}
	if (AUTH_FAILED.test(details)) {
		return {
			kind: "auth_failed",
			message: `${sshTarget} refused your credentials. Check that your key is loaded (\`ssh-add -l\`).`,
			details,
		};
	}
	return {
		kind: "unreachable",
		message: `Could not reach ${sshTarget} over SSH.`,
		details,
	};
}

/** The failure for a spawn that never produced a process because ssh is absent. */
export function sshClientMissingFailure(): SshFailure {
	return {
		kind: "ssh_missing",
		message: "No `ssh` client was found on this machine. Remote workspaces need OpenSSH.",
		details: "",
	};
}

/**
 * The failure for a remote host with no `ao` binary. Detect and report the exact
 * command; never run an installer. AO does not become a configuration-management
 * tool for machines its users' maintainers do not own — the same answer AO gives
 * for a missing local tmux.
 */
export function aoNotInstalledFailure(sshTarget: string): SshFailure {
	return {
		kind: "remote_command_failed",
		message:
			`No \`ao\` binary on ${sshTarget}. Install Agent Orchestrator there and make sure ` +
			`\`ao\` is on the PATH of a non-interactive SSH login (~/.profile, not ~/.bashrc).`,
		details: "",
	};
}
