// Connecting the supervisor to a remote workspace's daemon.
//
// The whole feature rests on one fact: the renderer addresses the daemon
// through a single mutable base URL that the supervisor hands it
// (`daemon:status` → renderer/lib/daemon-status.ts), and the terminal-mux
// WebSocket derives its URL from that same base. So if the supervisor points
// that base at a loopback port which SSH forwards to the remote daemon, every
// existing renderer feature — REST, SSE, terminals — works unmodified, and the
// remote daemon keeps its 127.0.0.1-only bind. AO gains no network listener,
// and `AGENTS.md`'s bind rule is respected on both machines.
//
// Connect sequence, in order, because each step's failure has a different
// remedy and must not be reported as the next step's:
//
//   1. preflight  — is `ssh` here, is the host reachable, is `ao` there
//   2. tunnel     — `ssh -N -L <local>:127.0.0.1:<remote>`
//   3. attach     — probe the forwarded port; a daemon may already be running
//   4. start      — only if nothing answered, launch `ao daemon` detached
//   5. wait       — poll until /healthz and /readyz agree
//
// Process plumbing lives here; the argv builders and the failure taxonomy are
// pure modules under shared/ so they can be tested without opening a socket.

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
	CONNECT_TIMEOUT_SECONDS,
	controlPath,
	controlPathFits,
	remoteCommandArgv,
	shellQuote,
	tunnelArgv,
} from "../shared/ssh-command";
import {
	aoNotInstalledFailure,
	classifySshFailure,
	sshClientMissingFailure,
	type SshFailure,
} from "../shared/ssh-failure";
import type { DaemonProber } from "../shared/daemon-attach";
import { DEFAULT_DAEMON_PORT } from "../shared/daemon-attach";
import type { RemoteWorkspace } from "../shared/workspaces";

/** Bound on a single preflight/start command, including the ssh handshake. */
const REMOTE_COMMAND_TIMEOUT_MS = (CONNECT_TIMEOUT_SECONDS + 10) * 1000;
/** How long to wait for an already-running remote daemon to answer. */
const ATTACH_PROBE_TIMEOUT_MS = 3_000;
/** How long to wait for a freshly started remote daemon to become ready. */
const START_READY_TIMEOUT_MS = 30_000;
const READY_POLL_INTERVAL_MS = 250;

export type RemoteConnection = {
	/** Loopback port on this machine that reaches the remote daemon. */
	localPort: number;
	/** The port the daemon binds on the remote side. */
	remotePort: number;
	/** True when this connect started the remote daemon rather than attaching. */
	started: boolean;
	/**
	 * True once the tunnel process is gone, whether disposed or dropped on its
	 * own (laptop sleep, wifi loss, VM reboot). A dropped tunnel says nothing
	 * about the remote daemon, which keeps running — so this is a signal to
	 * re-dial, never to conclude the session died.
	 */
	closed: () => boolean;
	/** Tear the tunnel down. Idempotent. */
	dispose: () => void;
};

export class RemoteWorkspaceError extends Error {
	readonly failure: SshFailure;
	constructor(failure: SshFailure) {
		super(failure.message);
		this.name = "RemoteWorkspaceError";
		this.failure = failure;
	}
}

type SpawnFn = (command: string, args: string[]) => ChildProcess;

export type RemoteWorkspaceDeps = {
	/** Directory for ControlMaster sockets; must already exist, mode 0700. */
	controlDir: string;
	/** Reuses the supervisor's existing /healthz|/readyz prober. */
	probe: DaemonProber;
	spawn?: SpawnFn;
	/** Allocates a free loopback port; injectable so tests never bind. */
	allocatePort?: () => Promise<number>;
	/** Injectable clock and sleep, so readiness budgets are testable without waiting. */
	delay?: (ms: number) => Promise<void>;
	now?: () => number;
};

type RunResult = { exitCode: number | null; stdout: string; stderr: string };

const defaultDelay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Ask the OS for a free loopback port by binding zero and releasing it.
 *
 * This is inherently a TOCTOU: the port can be taken between release and ssh's
 * bind. That is acceptable and not worth a lock — the loss is a failed connect
 * the user can retry, and the alternative (holding the socket while ssh binds)
 * is impossible. Binding 127.0.0.1 rather than 0.0.0.0 also guarantees the
 * forward we later create is never externally reachable.
 */
async function allocateLoopbackPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") {
				server.close(() => reject(new Error("could not allocate a loopback port")));
				return;
			}
			const { port } = address;
			server.close(() => resolve(port));
		});
	});
}

/** Resolve the ControlMaster socket, degrading to no multiplexing if it will not fit. */
function resolveControl(controlDir: string, sshTarget: string): { path: string } | null {
	const candidate = controlPath(controlDir, sshTarget);
	// Over the sockaddr_un budget OpenSSH fails the entire connection, so a path
	// too long must degrade to an unmultiplexed connection rather than hard-fail.
	// Slower (a handshake per command), but it works.
	return controlPathFits(candidate) ? { path: candidate } : null;
}

/** Run one ssh command to completion, capturing both streams separately. */
function runSsh(spawn: SpawnFn, args: string[], timeoutMs: number): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		let child: ChildProcess;
		try {
			child = spawn("ssh", args);
		} catch {
			reject(new RemoteWorkspaceError(sshClientMissingFailure()));
			return;
		}

		let stdout = "";
		let stderr = "";
		let settled = false;
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		// stdout and stderr are deliberately NOT merged: the local ssh client
		// writes its own diagnostics to stderr, and interleaving them into the
		// remote command's stdout would corrupt anything we parse from it.
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		// ConnectTimeout bounds only the TCP connect, and is not consulted at all
		// by a multiplexed client (which connects to a local Unix socket), so the
		// caller's own deadline is the real bound.
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			resolve({ exitCode: null, stdout, stderr: `${stderr}\nssh timed out after ${timeoutMs}ms` });
		}, timeoutMs);

		child.on("error", (error: NodeJS.ErrnoException) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			// ENOENT here means no ssh binary, which is a different remedy from
			// every transport failure and must not be classified as one.
			reject(new RemoteWorkspaceError(error.code === "ENOENT" ? sshClientMissingFailure() : classifySshFailure(null, String(error), "")));
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode: code, stdout, stderr });
		});
	});
}

/**
 * Confirm the host answers and carries an `ao` binary, before a tunnel exists.
 *
 * `command -v ao` runs through the interposed /bin/sh, and its failure is
 * reported as "install ao there", never as an install AO performs itself.
 */
async function preflight(spawn: SpawnFn, workspace: RemoteWorkspace, control: { path: string } | null): Promise<void> {
	const argv = remoteCommandArgv({ sshTarget: workspace.sshTarget, control, script: "command -v ao" });
	const result = await runSsh(spawn, argv, REMOTE_COMMAND_TIMEOUT_MS);
	if (result.exitCode === 0) return;
	// A clean non-zero from the remote shell means ssh worked and `ao` is absent;
	// anything else is a transport problem and gets the transport's diagnosis.
	const failure = classifySshFailure(result.exitCode, result.stderr, workspace.sshTarget);
	throw new RemoteWorkspaceError(failure.kind === "remote_command_failed" ? aoNotInstalledFailure(workspace.sshTarget) : failure);
}

/**
 * Start the remote daemon, detached from this SSH session.
 *
 * `setsid` (with a `nohup` fallback for hosts without it) is what keeps the
 * daemon alive after the connection that launched it goes away — otherwise
 * sshd's SIGHUP on channel close takes the daemon with it, and closing the
 * laptop lid would kill every remote session.
 *
 * stdin is redirected from /dev/null and both output streams to the remote
 * ~/.ao log, so the command cannot block waiting to write into a closing pipe.
 * `ao daemon` already refuses to start when one is bound to the port, so a
 * racing second connect is harmless.
 */
async function startRemoteDaemon(
	spawn: SpawnFn,
	workspace: RemoteWorkspace,
	control: { path: string } | null,
	remotePort: number,
): Promise<void> {
	// The port is exported rather than used as a command prefix: `setsid FOO=1 ao`
	// would have setsid try to exec "FOO=1" as the program name.
	const launch = `ao daemon >> "$HOME/.ao/daemon.log" 2>&1 < /dev/null &`;
	const script = [
		'mkdir -p "$HOME/.ao"',
		`AO_PORT=${shellQuote(String(remotePort))}`,
		"export AO_PORT",
		`if command -v setsid > /dev/null 2>&1; then setsid ${launch} else nohup ${launch} fi`,
	].join("; ");

	const argv = remoteCommandArgv({ sshTarget: workspace.sshTarget, control, script });
	const result = await runSsh(spawn, argv, REMOTE_COMMAND_TIMEOUT_MS);
	if (result.exitCode !== 0) {
		throw new RemoteWorkspaceError(classifySshFailure(result.exitCode, result.stderr, workspace.sshTarget));
	}
}

/**
 * Poll the forwarded port until the daemon reports both healthy and ready.
 *
 * Both endpoints must agree on the pid, mirroring the local attach path: a
 * daemon that answers /healthz but not /readyz is still booting, and pointing
 * the renderer at it would surface as a wall of failed requests.
 */
async function waitForReady(
	probe: DaemonProber,
	localPort: number,
	budgetMs: number,
	delay: (ms: number) => Promise<void>,
	now: () => number,
): Promise<boolean> {
	const deadline = now() + budgetMs;
	for (;;) {
		const health = await probe(localPort, "healthz");
		if (health) {
			const ready = await probe(localPort, "readyz");
			if (ready && ready.pid === health.pid) return true;
		}
		if (now() >= deadline) return false;
		await delay(READY_POLL_INTERVAL_MS);
	}
}

/**
 * Establish a connection to a remote workspace's daemon, starting it if needed.
 *
 * On any failure the tunnel is torn down before throwing, so a failed connect
 * never leaves an orphaned `ssh -N` holding a port.
 */
export async function connectRemoteWorkspace(
	workspace: RemoteWorkspace,
	deps: RemoteWorkspaceDeps,
): Promise<RemoteConnection> {
	const spawn = deps.spawn ?? ((command, args) => nodeSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] }));
	const allocatePort = deps.allocatePort ?? allocateLoopbackPort;
	const delay = deps.delay ?? defaultDelay;
	const now = deps.now ?? Date.now;
	const remotePort = workspace.remotePort ?? DEFAULT_DAEMON_PORT;
	const control = resolveControl(deps.controlDir, workspace.sshTarget);

	await preflight(spawn, workspace, control);

	const localPort = await allocatePort();
	const tunnel = spawn("ssh", tunnelArgv({ sshTarget: workspace.sshTarget, control, localPort, remotePort }));

	// `ssh -N` normally stays silent and running; anything it prints is a
	// diagnosis for a connect that is about to fail its probes, so keep the tail.
	let tunnelStderr = "";
	tunnel.stderr?.on("data", (chunk: Buffer) => {
		tunnelStderr = `${tunnelStderr}${chunk.toString("utf8")}`.slice(-4000);
	});

	// One flag for both "we tore it down" and "it died on us": a later dispose
	// must not signal a recycled pid, and the supervisor needs to see a dropped
	// tunnel so it can re-dial.
	let gone = false;
	const closed = () => gone;
	const dispose = () => {
		if (gone) return;
		gone = true;
		tunnel.kill("SIGTERM");
	};
	tunnel.on("close", () => {
		gone = true;
	});

	try {
		if (await waitForReady(deps.probe, localPort, ATTACH_PROBE_TIMEOUT_MS, delay, now)) {
			return { localPort, remotePort, started: false, closed, dispose };
		}
		// Nothing answered. Distinguish "the tunnel itself failed" from "the tunnel
		// is fine, no daemon is listening yet" — starting a daemon over a dead
		// transport would only produce a second, more confusing failure.
		if (gone) {
			throw new RemoteWorkspaceError(classifySshFailure(null, tunnelStderr, workspace.sshTarget));
		}
		await startRemoteDaemon(spawn, workspace, control, remotePort);
		if (!(await waitForReady(deps.probe, localPort, START_READY_TIMEOUT_MS, delay, now))) {
			throw new RemoteWorkspaceError({
				kind: "remote_command_failed",
				message: `Started \`ao daemon\` on ${workspace.sshTarget}, but it never became ready.`,
				details: `${tunnelStderr}\nSee ~/.ao/daemon.log on ${workspace.sshTarget}.`.trim(),
			});
		}
		return { localPort, remotePort, started: true, closed, dispose };
	} catch (error) {
		dispose();
		throw error;
	}
}
