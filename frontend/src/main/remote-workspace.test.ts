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
	finish(exitCode: number, stderr = "") {
		if (stderr) this.stderr.emit("data", Buffer.from(stderr));
		this.emit("close", exitCode);
	}
}

type Invocation = { args: string[]; child: FakeSsh };

/**
 * Script the fake ssh by role. Preflight (`command -v ao`) and the start command
 * complete immediately with the given exit code; the tunnel (`-N`) stays open
 * until disposed, exactly as `ssh -N` does.
 *
 * `daemonStarted` flips when the start command runs, so a probe can model the
 * only sequence that matters: nothing answers until the daemon is launched.
 */
function fakeSpawn(plan: { preflight?: number; start?: number; preflightStderr?: string }) {
	const calls: Invocation[] = [];
	const state = { daemonStarted: false };
	const spawn = (_command: string, args: string[]) => {
		const child = new FakeSsh();
		calls.push({ args, child });
		if (args.includes("-N")) return child;

		const isPreflight = args.at(-1) === "command -v ao";
		const code = isPreflight ? (plan.preflight ?? 0) : (plan.start ?? 0);
		if (!isPreflight && code === 0) state.daemonStarted = true;
		queueMicrotask(() => child.finish(code, isPreflight ? (plan.preflightStderr ?? "") : ""));
		return child;
	};
	return { calls, state, spawn: spawn as unknown as (c: string, a: string[]) => ChildProcess };
}

const probeOk: DaemonProbe = { status: "ok", service: "agent-orchestrator-daemon", pid: 42 };

const answer: DaemonProber = async (_port, endpoint) => ({
	...probeOk,
	status: endpoint === "healthz" ? "ok" : "ready",
});

/** A prober that stays silent until the fake ssh has actually started a daemon. */
function probeAfterStart(state: { daemonStarted: boolean }): DaemonProber {
	return async (port, endpoint) => (state.daemonStarted ? answer(port, endpoint) : null);
}

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
		const { calls, spawn } = fakeSpawn({});
		const connection = await connectRemoteWorkspace(workspace, deps({ spawn, probe: answer }));

		expect(connection).toMatchObject({ localPort: 51234, remotePort: 3001, started: false });
		// Exactly two invocations: the preflight and the tunnel. No start command.
		expect(calls).toHaveLength(2);
		expect(calls[1].args).toContain("51234:127.0.0.1:3001");
		connection.dispose();
		expect(calls[1].child.killed).toBe("SIGTERM");
	});

	it("starts the daemon when nothing answers, then reports started", async () => {
		const { calls, state, spawn } = fakeSpawn({});
		const connection = await connectRemoteWorkspace(workspace, deps({ spawn, probe: probeAfterStart(state) }));

		expect(connection.started).toBe(true);
		const start = calls.at(-1)?.args.at(-1) ?? "";
		expect(start).toContain("ao daemon");
		expect(start).toContain("setsid");
		expect(start).toContain("nohup");
		connection.dispose();
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
	it("tears the tunnel down when the daemon never becomes ready", async () => {
		const { calls, spawn } = fakeSpawn({});
		const error = await connectRemoteWorkspace(
			workspace,
			deps({ spawn, probe: async () => null }),
		).catch((e) => e);

		expect(error).toBeInstanceOf(RemoteWorkspaceError);
		expect(error.message).toContain("never became ready");
		const tunnel = calls.find((call) => call.args.includes("-N"));
		expect(tunnel?.child.killed).toBe("SIGTERM");
	});

	it("honours a per-workspace remote port on both the forward and the start command", async () => {
		const { calls, state, spawn } = fakeSpawn({});
		const connection = await connectRemoteWorkspace(
			{ ...workspace, remotePort: 4100 },
			deps({ spawn, probe: probeAfterStart(state) }),
		);

		expect(connection.remotePort).toBe(4100);
		expect(calls.find((call) => call.args.includes("-N"))?.args).toContain("51234:127.0.0.1:4100");
		expect(calls.at(-1)?.args.at(-1)).toContain("AO_PORT='4100'");
		connection.dispose();
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
