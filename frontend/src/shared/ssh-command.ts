// Pure argv builders for every `ssh` invocation AO makes.
//
// Kept separate from the process plumbing (main/ssh-tunnel.ts) and free of
// node:*/electron so the flag block can be asserted verbatim in unit tests. The
// flags are load-bearing, not hygiene — each one is justified below, in the
// house style of the tmux adapter's flag rationale.
//
// AO shells out to the user's own ssh client and never embeds an SSH library:
// no key material, no passphrase prompts it cannot answer, no known_hosts
// policy of its own, and ~/.ssh/config (ProxyJump, Match, Include,
// IdentityAgent) keeps working for free. This is the same call docs/stack.md
// makes for git over go-git.
//
// No node:* imports here, deliberately: the vite-plugin-electron-renderer
// polyfill breaks them under vitest (see daemon-attach.ts), and these builders
// are exercised directly by the renderer's tests.

/** Seconds ssh keeps a multiplexed master alive after the last client exits. */
const CONTROL_PERSIST_SECONDS = 60;
/** Seconds ssh waits for the TCP connect before giving up. */
export const CONNECT_TIMEOUT_SECONDS = 5;
/**
 * Protocol keepalives: 15s × 3 surfaces a genuinely dead peer (laptop sleep,
 * wifi drop, VM reboot) as a connection error in ~45s instead of an indefinite
 * stall, and they run regardless of data so an idle tunnel stays up.
 */
const SERVER_ALIVE_INTERVAL_SECONDS = 15;
const SERVER_ALIVE_COUNT_MAX = 3;

/**
 * A Unix socket path is capped at 104 bytes on Darwin and 108 on Linux, and
 * OpenSSH fails the whole connection when ControlPath exceeds it. Hashing the
 * target keeps the basename fixed-width; the caller degrades to a shorter
 * directory past this budget rather than hard-failing.
 */
export const CONTROL_PATH_MAX_BYTES = 100;

/**
 * FNV-1a, 32-bit, rendered as 8 hex chars. This is a *uniqueness* hash for a
 * socket filename, not a security boundary — the ControlPath is already inside
 * a 0700 directory — so a non-cryptographic hash with no node:crypto dependency
 * is the right tool. Two targets colliding would share a master connection;
 * with 2^32 buckets over a handful of registered hosts that is not a real risk.
 */
function shortHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i += 1) {
		hash ^= value.charCodeAt(i);
		// FNV prime 16777619, via shifts so the intermediate stays in int32.
		hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

/**
 * The ControlMaster socket for a target. Note this is a persistent, always-warm,
 * authenticated remote-shell credential that AO creates and keeps alive: `0700`
 * on the containing directory is the entire access control, and ControlPersist
 * is the exposure window after the last use.
 *
 * OpenSSH's own `%C` token is deliberately unused — it expands inside ssh,
 * after we would have built the path, which defeats the length check.
 */
export function controlPath(controlDir: string, sshTarget: string): string {
	return `${controlDir.replace(/\/+$/, "")}/m-${shortHash(sshTarget)}`;
}

/**
 * True when `controlPath` fits in the platform's sockaddr_un budget. Measured in
 * UTF-8 bytes, not characters: a non-ASCII home directory costs more than its
 * length suggests, and the kernel counts bytes.
 */
export function controlPathFits(candidate: string): boolean {
	return new TextEncoder().encode(candidate).length <= CONTROL_PATH_MAX_BYTES;
}

/**
 * The shared flag block, in fixed order so tests can assert it verbatim.
 *
 * - **ControlMaster/Path/Persist** — one authenticated TCP connection per host,
 *   reused by the tunnel, the readiness probes and the daemon-start command.
 *   Without it every probe pays a full TCP + auth handshake.
 * - **ConnectTimeout** — bounds the connect, not the command; callers still
 *   impose their own deadline, because a *multiplexed* client connects to a
 *   local Unix socket and never consults this value.
 * - **BatchMode=yes** — load-bearing. The supervisor has no controlling tty, so
 *   it can answer neither a passphrase prompt nor the interactive
 *   "Are you sure you want to continue connecting?" for an unknown host key.
 *   BatchMode turns both into an immediate, classifiable failure instead of a
 *   process that hangs forever.
 * - **LogLevel=ERROR** — keeps "Warning: Permanently added …" out of surfaced
 *   error strings.
 *
 * `StrictHostKeyChecking` is deliberately not set at all: BatchMode already
 * makes an unknown key fail closed, and setting it to `no`/`accept-new` is
 * exactly the bypass this design refuses. `IdentityFile`, `User`, `Port` and
 * `ProxyJump` are likewise not passed — the bare target goes to the user's own
 * client so their ~/.ssh/config governs.
 */
export function sshControlFlags(control: { path: string } | null): string[] {
	const flags: string[] = [];
	if (control) {
		flags.push(
			"-o",
			"ControlMaster=auto",
			"-o",
			`ControlPath=${control.path}`,
			"-o",
			`ControlPersist=${CONTROL_PERSIST_SECONDS}`,
		);
	}
	flags.push(
		"-o",
		`ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`,
		"-o",
		"BatchMode=yes",
		"-o",
		`ServerAliveInterval=${SERVER_ALIVE_INTERVAL_SECONDS}`,
		"-o",
		`ServerAliveCountMax=${SERVER_ALIVE_COUNT_MAX}`,
		"-o",
		"LogLevel=ERROR",
	);
	return flags;
}

export type SshTargetOptions = {
	sshTarget: string;
	/** ControlMaster socket, or null to run unmultiplexed. */
	control: { path: string } | null;
};

/**
 * `ssh -N -L <localPort>:127.0.0.1:<remotePort> <target>` — the forward that
 * lets the client reach a remote daemon which is still bound to loopback only.
 *
 * The remote side of the forward is `127.0.0.1` and never `localhost`: the
 * remote resolver may map `localhost` to `::1` first, and a daemon bound to
 * 127.0.0.1 would refuse it.
 *
 * `-N` runs no remote command, so sshd never allocates a shell — the forward is
 * the entire purpose of the connection.
 */
export function tunnelArgv(options: SshTargetOptions & { localPort: number; remotePort: number }): string[] {
	return [
		...sshControlFlags(options.control),
		"-N",
		"-L",
		`${options.localPort}:127.0.0.1:${options.remotePort}`,
		options.sshTarget,
	];
}

/**
 * A remote command invocation.
 *
 * The command is always interposed with `/bin/sh -c`. sshd executes a remote
 * command with the *account's login shell*, which AO does not control: `fish`,
 * `csh` and `tcsh` do not parse POSIX `$?`, `&&` chains or `>/dev/null 2>&1` the
 * same way, so a script written for `sh` and handed to sshd silently misbehaves
 * on those accounts. Pinning `/bin/sh` removes the variable entirely.
 *
 * `script` is passed as a single argv element, so the local shell is never
 * involved and nothing here needs local quoting. Any value interpolated *into*
 * `script` still needs POSIX single-quoting — use {@link shellQuote}.
 */
export function remoteCommandArgv(options: SshTargetOptions & { script: string }): string[] {
	return [...sshControlFlags(options.control), options.sshTarget, "/bin/sh", "-c", options.script];
}

/**
 * POSIX single-quote a value for interpolation into a remote script. Single
 * quotes suppress every expansion; an embedded `'` is closed, escaped and
 * reopened (`'\''`), which is the only escape a POSIX shell honours inside them.
 */
export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
