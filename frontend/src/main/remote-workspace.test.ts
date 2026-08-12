import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { DaemonProbe, DaemonProber } from "../shared/daemon-attach";
import { connectRemoteWorkspace, RemoteWorkspaceError, type RemoteWorkspaceDeps } from "./remote-workspace";
import type { RemoteWorkspace } from "../shared/workspaces";

const workspace: RemoteWorkspace = { id: "build-vm", sshTarget: "build-vm" };

/** A spawned ssh the test drives by hand. */
class FakeSsh extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	killed: NodeJS.Signals | null = null;
	kill(signal: NodeJS.Signals) {
		this.killed = signal;
		this.emit("close", null);
		return true;
	}
	finish(exitCode: number, stderr = "", stdout = "") {
		if (stdout) this.stdout.emit("data", Buffer.from(stdout));
		if (stderr) this.stderr.emit("data", Buffer.from(stderr));
		this.emit("close", exitCode);
	}
}

type Invocation = { args: string[]; child: FakeSsh };

/** The remote port the fake daemon reports. Deliberately not 3001: the run-file
 * is the authority, and a test that used the default would not notice the
 * connect guessing instead of discovering. */
const REMOTE_PORT = 43215;

/**
 * Script the fake ssh by role, modelling the real connect sequence:
 * preflight (`command -v ao`) → run-file read → start → run-file poll → tunnel.
 *
 * `alreadyRunning` decides whether the first run-file read finds a live daemon,
 * which is the fork between attaching and starting. The tunnel (`-N`) stays open
 * until disposed, exactly as an unmultiplexed `ssh -N` does.
 */
function fakeSpawn(plan: {
	preflight?: number;
	start?: number;
	preflightStderr?: string;
	alreadyRunning?: boolean;
	neverPublishesPort?: boolean;
}) {
	const calls: Invocation[] = [];
	const state = { daemonStarted: plan.alreadyRunning ?? false };
	const runFile = () => JSON.stringify({ pid: 4242, port: REMOTE_PORT, startedAt: "2026-08-12T00:00:00Z" });

	const spawn = (_command: string, args: string[]) => {
		const child = new FakeSsh();
		calls.push({ args, child });
		if (args.includes("-N")) return child;

		const script = args.at(-1) ?? "";
		queueMicrotask(() => {
			if (script.includes("command -v ao")) {
				child.finish(plan.preflight ?? 0, plan.preflightStderr ?? "");
			} else if (script.includes("running.json")) {
				// Empty stdout is the normal "no live daemon" answer, not an error.
				const live = state.daemonStarted && !plan.neverPublishesPort;
				child.finish(0, "", live ? runFile() : "");
			} else {
				const code = plan.start ?? 0;
				if (code === 0) state.daemonStarted = true;
				child.finish(code);
			}
		});
		return child;
	};
	return { calls, state, spawn: spawn as unknown as (c: string, a: string[]) => ChildProcess };
}

const isTunnel = (call: Invocation) => call.args.includes("-N");
const isStart = (call: Invocation) => (call.args.at(-1) ?? "").includes("ao daemon");

const probeOk: DaemonProbe = { status: "ok", service: "agent-orchestrator-daemon", pid: 42 };

const answer: DaemonProber = async (_port, endpoint) => ({
	...probeOk,
	status: endpoint === "healthz" ? "ok" : "ready",
});

/**
 * A deterministic clock: every injected sleep advances it by exactly the
 * requested amount, so readiness budgets expire in zero real time and the
 * timeout paths are testable at all.
 */
function fakeClock() {
	let millis = 0;
	return { now: () => millis, delay: async (ms: number) => void (millis += ms) };
}

function deps(overrides: Partial<RemoteWorkspaceDeps> & Pick<RemoteWorkspaceDeps, "spawn" | "probe">): RemoteWorkspaceDeps {
	return {
		controlDir: "/tmp/ao-ssh",
		allocatePort: async () => 51234,
		...fakeClock(),
		...overrides,
	};
}

describe("connectRemoteWorkspace", () => {
	it("attaches to an already-running remote daemon without starting one", async () => {
		const { calls, spawn } = fakeSpawn({ alreadyRunning: true });
		const connection = await connectRemoteWorkspace(workspace, deps({ spawn, probe: answer }));

		expect(connection).toMatchObject({ localPort: 51234, remotePort: REMOTE_PORT, started: false });
		expect(calls.some(isStart)).toBe(false);
		connection.dispose();
		expect(calls.find(isTunnel)?.child.killed).toBe("SIGTERM");
	});

	// The bug this pins, found on a real host: AO_PORT is only a request. With
	// 3001 taken the daemon binds an ephemeral port and records it, so forwarding
	// to a guessed 3001 reaches whatever *else* is listening there.
	it("forwards to the port the run-file reports, not the default", async () => {
		const { calls, spawn } = fakeSpawn({ alreadyRunning: true });
		const connection = await connectRemoteWorkspace(workspace, deps({ spawn, probe: answer }));

		expect(connection.remotePort).toBe(REMOTE_PORT);
		expect(calls.find(isTunnel)?.args).toContain(`51234:127.0.0.1:${REMOTE_PORT}`);
		connection.dispose();
	});

	it("starts the daemon when none is running, then reports started", async () => {
		const { calls, spawn } = fakeSpawn({});
		const connection = await connectRemoteWorkspace(workspace, deps({ spawn, probe: answer }));

		expect(connection.started).toBe(true);
		const start = calls.find(isStart)?.args.at(-1) ?? "";
		expect(start).toContain("ao daemon");
		// setsid (with a nohup fallback) is what keeps the daemon alive after the
		// SSH session that launched it goes away.
		expect(start).toContain("setsid");
		expect(start).toContain("nohup");
		// Nothing pins the port when the user expressed no preference.
		expect(start).not.toContain("AO_PORT");
		connection.dispose();
	});

	it("gives up when a started daemon never publishes a port", async () => {
		const { spawn } = fakeSpawn({ neverPublishesPort: true });
		const error = await connectRemoteWorkspace(workspace, deps({ spawn, probe: answer })).catch((e) => e);

		expect(error).toBeInstanceOf(RemoteWorkspaceError);
		expect(error.message).toContain("never reported a listening port");
	});

	// Detect and report; never install. AO does not become a config-management
	// tool for machines its maintainers do not own.
	it("reports a missing remote ao binary as an install instruction, not a transport error", async () => {
		const { spawn } = fakeSpawn({ preflight: 127 });
		const error = await connectRemoteWorkspace(workspace, deps({ spawn, probe: answer })).catch((e) => e);

		expect(error).toBeInstanceOf(RemoteWorkspaceError);
		expect(error.failure.kind).toBe("remote_command_failed");
		expect(error.message).toContain("No `ao` binary on build-vm");
		expect(error.message).not.toContain("install it for you");
	});

	it("classifies an unverified host key rather than blaming the daemon", async () => {
		const { spawn } = fakeSpawn({
			preflight: 255,
			preflightStderr: "No ED25519 host key is known for build-vm and you have requested strict checking.",
		});
		const error = await connectRemoteWorkspace(workspace, deps({ spawn, probe: answer })).catch((e) => e);

		expect(error.failure.kind).toBe("host_key_unverified");
		// The remedy must put the fingerprint in front of the user, not bypass it.
		expect(error.message).toContain("ssh build-vm");
	});

	// A failed connect must not leave an orphaned `ssh -N` holding a local port.
	// The daemon was confirmed listening before the tunnel opened, so a failure
	// here is the forward's fault and must not be blamed on the daemon.
	it("tears the tunnel down when the forward never carries the daemon", async () => {
		const { calls, spawn } = fakeSpawn({ alreadyRunning: true });
		const error = await connectRemoteWorkspace(workspace, deps({ spawn, probe: async () => null })).catch((e) => e);

		expect(error).toBeInstanceOf(RemoteWorkspaceError);
		expect(error.message).toContain("did not answer");
		expect(calls.find(isTunnel)?.child.killed).toBe("SIGTERM");
	});

	it("passes a configured remote port to the daemon it starts, as a preference", async () => {
		const { calls, spawn } = fakeSpawn({});
		const connection = await connectRemoteWorkspace(
			{ ...workspace, remotePort: 4100 },
			deps({ spawn, probe: answer }),
		);

		// Assert on what the remote /bin/sh actually receives, i.e. after the
		// remote login shell strips the outer layer of quoting.
		const sent = calls.find(isStart)?.args.at(-1) ?? "";
		expect(sent.slice(1, -1).replaceAll(`'\\''`, "'")).toContain("AO_PORT='4100'");
		// ...but the run-file still decides where the tunnel actually points.
		expect(connection.remotePort).toBe(REMOTE_PORT);
		connection.dispose();
	});

	// A dropped tunnel is a transport fact, and the supervisor re-dials on it.
	// If `closed()` stayed false after the process died, a wifi blink would
	// strand the client on a dead forward forever.
	it("reports a tunnel that died on its own as closed", async () => {
		const { calls, spawn } = fakeSpawn({ alreadyRunning: true });
		const connection = await connectRemoteWorkspace(workspace, deps({ spawn, probe: answer }));
		expect(connection.closed()).toBe(false);

		const tunnel = calls.find(isTunnel);
		tunnel?.child.emit("close", 255);
		expect(connection.closed()).toBe(true);
	});

	it("reports a disposed tunnel as closed and ignores a second dispose", async () => {
		const { calls, spawn } = fakeSpawn({ alreadyRunning: true });
		const connection = await connectRemoteWorkspace(workspace, deps({ spawn, probe: answer }));
		const tunnel = calls.find(isTunnel);

		connection.dispose();
		expect(connection.closed()).toBe(true);
		tunnel!.child.killed = null;
		connection.dispose();
		// A second dispose must not signal again — the pid may have been recycled.
		expect(tunnel?.child.killed).toBeNull();
	});

	it("surfaces a missing ssh client distinctly from an unreachable host", async () => {
		const spawn = (() => {
			const child = new FakeSsh();
			queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn ssh ENOENT"), { code: "ENOENT" })));
			return child;
		}) as unknown as (c: string, a: string[]) => ChildProcess;

		const error = await connectRemoteWorkspace(workspace, deps({ spawn, probe: answer })).catch((e) => e);
		expect(error.failure.kind).toBe("ssh_missing");
	});
});
