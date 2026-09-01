import {
	test,
	expect,
	chromium,
	type Browser,
	type Page,
} from "@playwright/test";
import { createHash } from "node:crypto";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RUN_REAL_RESTART_E2E = process.env.AO_RESTART_CONTINUITY_E2E === "1";
const APP_BIN = process.env.AO_APP_BIN ?? "";

type RunFile = { pid: number; port: number; owner?: string };
type SessionView = {
	id: string;
	displayName?: string;
	mode: "chat" | "tui";
	status: string;
	activity: { state: string };
};
type SessionRow = {
	id: string;
	session_mode: string;
	activity_state: string;
	runtime_handle_id: string;
	runtime_launch_id: string;
	agent_session_id: string;
	agent_session_id_launch_id: string;
	provider_conversation_id: string;
	controller_generation: string;
	workspace_path: string;
};
type NativeApp = { process: ChildProcess; browser: Browser; window: Page };

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address() as net.AddressInfo;
			server.close(() => resolve(address.port));
		});
	});
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 45_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await read();
			if (value !== null) return value;
		} catch (error) {
			lastError = error;
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timed out waiting for condition${lastError ? `: ${String(lastError)}` : ""}`);
}

async function readRunFile(runFile: string): Promise<RunFile | null> {
	try {
		return JSON.parse(await fs.readFile(runFile, "utf8")) as RunFile;
	} catch {
		return null;
	}
}

async function waitReady(runFile: string, expectedPort: number): Promise<RunFile> {
	const info = await waitFor(async () => {
		const candidate = await readRunFile(runFile);
		return candidate?.port === expectedPort ? candidate : null;
	});
	await waitFor(async () => {
		try {
			const response = await fetch(`http://127.0.0.1:${expectedPort}/readyz`);
			if (response.status !== 200) return null;
			const payload = (await response.json()) as { status?: string; pid?: number };
			return payload.status === "ready" && payload.pid === info.pid ? true : null;
		} catch {
			return null;
		}
	});
	return info;
}

async function waitStopped(port: number): Promise<void> {
	await waitFor(async () => {
		try {
			await fetch(`http://127.0.0.1:${port}/healthz`);
			return null;
		} catch {
			return true;
		}
	}, 45_000);
}

async function api<T>(port: number, route: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`http://127.0.0.1:${port}${route}`, {
		...init,
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${route}: ${response.status} ${text}`);
	return text ? (JSON.parse(text) as T) : (undefined as T);
}

function sqliteRows(db: string): SessionRow[] {
	const sql = `
		SELECT id, session_mode, activity_state, runtime_handle_id, runtime_launch_id,
		       agent_session_id, agent_session_id_launch_id, provider_conversation_id,
		       controller_generation, workspace_path
		FROM sessions ORDER BY num;
	`;
	const output = execFileSync("sqlite3", [db, "-json", sql], { encoding: "utf8" }).trim();
	return output ? (JSON.parse(output) as SessionRow[]) : [];
}

function sqlQuote(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function historicalSocket(runFile: string): string {
	const digest = createHash("sha256").update(path.resolve(runFile)).digest().subarray(0, 16).toString("hex");
	return path.join(path.dirname(runFile), `tmux-${digest}.sock`);
}

async function launchApp(
	env: NodeJS.ProcessEnv,
	logs: string[],
): Promise<NativeApp> {
	const debugPort = await freePort();
	const child = spawn(APP_BIN, [
		`--remote-debugging-port=${debugPort}`,
		"--remote-allow-origins=*",
		"--use-mock-keychain",
		"--disable-gpu",
		"--no-sandbox",
	], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stdout?.on("data", (chunk) => logs.push(`[stdout] ${String(chunk)}`));
	child.stderr?.on("data", (chunk) => {
		const text = String(chunk);
		stderr += text;
		logs.push(`[stderr] ${text}`);
	});
	child.once("exit", (code, signal) => logs.push(`[app-exit] code=${String(code)} signal=${String(signal)}`));
	try {
		const devToolsURL = await waitFor(async () => {
			const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
			return match?.[1] ?? null;
		}, 30_000);
		const browser = await chromium.connectOverCDP(devToolsURL);
		const window = await waitFor(async () => {
			for (const context of browser.contexts()) {
				const page = context.pages().find((candidate) => candidate.url().startsWith("app://renderer"));
				if (page) return page;
			}
			return null;
		}, 30_000);
		return { process: child, browser, window };
	} catch (error) {
		if (child.exitCode === null) child.kill("SIGKILL");
		throw error;
	}
}

async function quitApp(app: NativeApp): Promise<void> {
	if (app.process.exitCode === null && app.process.signalCode === null) {
		const exited = new Promise<boolean>((resolve) => app.process.once("exit", () => resolve(true)));
		await app.window
			.evaluate(() => {
				const bridge = (window as Window & {
					ao?: { menu?: { action: (action: string) => Promise<unknown> } };
				}).ao;
				return bridge?.menu?.action("app.quit");
			})
			.catch(() => undefined);
		const graceful = await Promise.race([
			exited,
			new Promise<false>((resolve) => setTimeout(() => resolve(false), 20_000)),
		]);
		if (!graceful && app.process.exitCode === null && app.process.signalCode === null) {
			const forcedExit = new Promise<void>((resolve) => app.process.once("exit", () => resolve()));
			app.process.kill("SIGKILL");
			await forcedExit;
		}
	}
	await Promise.race([
		app.browser.close().catch(() => undefined),
		new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
	]);
}

async function observeExitedFrames(window: Page, stop: { value: boolean }): Promise<string[]> {
	const observations: string[] = [];
	while (!stop.value) {
		try {
			const text = await window.evaluate(() => document.body?.innerText ?? "");
			if (/(^|\n)Exited($|\n)/m.test(text)) observations.push(text);
		} catch {
			// The renderer can be between native-window creation and page attachment.
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return observations;
}

async function terminateOwnedProcessGroup(pid: number): Promise<void> {
	if (!Number.isInteger(pid) || pid <= 1) return;
	try {
		process.kill(-pid, "SIGTERM");
	} catch {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			return;
		}
	}
	try {
		await waitFor(async () => {
			try {
				process.kill(pid, 0);
				return null;
			} catch {
				return true;
			}
		}, 3_000);
	} catch {
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// The fixture process exited between the liveness check and signal.
			}
		}
	}
}

async function cleanupDetachedHosts(root: string, dataDir: string): Promise<void> {
	try {
		const registry = JSON.parse(await fs.readFile(path.join(root, "windows-pty-hosts.json"), "utf8")) as Array<{
			ptyHostPid?: number;
		}>;
		for (const entry of registry) await terminateOwnedProcessGroup(entry.ptyHostPid ?? 0);
	} catch {
		// No TUI host registry was published before the failure.
	}
	try {
		const chatRoot = path.join(dataDir, "chat-hosts");
		for (const entry of await fs.readdir(chatRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			try {
				const descriptor = JSON.parse(
					await fs.readFile(path.join(chatRoot, entry.name, "host.json"), "utf8"),
				) as { pid?: number };
				await terminateOwnedProcessGroup(descriptor.pid ?? 0);
			} catch {
				// A host can exit and remove its descriptor during cleanup.
			}
		}
	} catch {
		// No Chat host directory was published before the failure.
	}
}

test("packaged desktop restart preserves Chat and TUI continuity without an Exited frame @real", async ({}, testInfo) => {
	test.skip(!RUN_REAL_RESTART_E2E, "set AO_RESTART_CONTINUITY_E2E=1 for the destructive isolated native-app scenario");
	test.skip(process.platform !== "darwin", "the historical private-socket fixture in this scenario targets macOS");
	test.setTimeout(300_000);
	if (!APP_BIN) throw new Error("AO_APP_BIN must point to the packaged Electron executable");

	// Keep the historical tmux socket below macOS's sockaddr_un path limit.
	const root = await fs.mkdtemp(path.join("/tmp", "ao-r-"));
	const home = path.join(root, "home");
	const dataDir = path.join(root, "data");
	const runFile = path.join(root, "running.json");
	const tmuxTmp = path.join(root, "tmux-tmp");
	const repo = path.join(root, "repo");
	const remote = path.join(root, "remote.git");
	const db = path.join(dataDir, "ao.db");
	const port = await freePort();
	const originalHome = os.homedir();
	const logs: string[] = [];
	const apps: NativeApp[] = [];
	const resources = path.resolve(APP_BIN, "../../Resources");
	const daemon = path.join(resources, "daemon", "ao");
	const tmux = path.join(resources, "tmux", "bin", "tmux");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		CODEX_HOME: process.env.CODEX_HOME || path.join(originalHome, ".codex"),
		AO_DATA_DIR: dataDir,
		AO_RUN_FILE: runFile,
		AO_PORT: String(port),
		AO_APP_RUN_ID: `restart-e2e-${Date.now()}`,
		AO_DISABLE_GPU: "1",
		ELECTRON_DISABLE_SANDBOX: "1",
		TMUX_TMPDIR: tmuxTmp,
	};

	await fs.mkdir(home, { recursive: true });
	await fs.mkdir(tmuxTmp, { recursive: true });
	await fs.mkdir(repo, { recursive: true });
	execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "restart-e2e@example.invalid"], { cwd: repo });
	execFileSync("git", ["config", "user.name", "AO Restart E2E"], { cwd: repo });
	await fs.writeFile(path.join(repo, "README.md"), "restart continuity\n");
	execFileSync("git", ["add", "README.md"], { cwd: repo });
	execFileSync("git", ["commit", "-m", "init"], { cwd: repo, stdio: "ignore" });
	execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "ignore" });
	execFileSync("git", ["remote", "add", "origin", remote], { cwd: repo });
	execFileSync("git", ["push", "-u", "origin", "main"], { cwd: repo, stdio: "ignore" });
	execFileSync("git", ["remote", "set-head", "origin", "main"], { cwd: repo });

	let foreignCreated = false;
	try {
		const first = await launchApp(env, logs);
		apps.push(first);
		await waitReady(runFile, port);
		await expect(first.window.locator("body")).toContainText("Agent Orchestrator", { timeout: 30_000 });

		await api(port, "/api/v1/projects", {
			method: "POST",
			body: JSON.stringify({ path: repo, projectId: "restart-e2e", name: "Restart E2E" }),
		});
		const spawn = async (displayName: string, mode: "chat" | "tui") =>
			(
				await api<{ session: SessionView }>(port, "/api/v1/sessions", {
					method: "POST",
					body: JSON.stringify({
						projectId: "restart-e2e",
						kind: "worker",
						harness: "codex",
						mode,
						prompt: "",
						displayName,
					}),
				})
			).session;
		const chat = await spawn("Chat Restart", "chat");
		const modernTUI = await spawn("Native TUI", "tui");
		const legacyTUI = await spawn("Legacy TUI", "tui");
		const beforeQuit = sqliteRows(db);
		const chatBefore = beforeQuit.find((row) => row.id === chat.id)!;
		const modernBefore = beforeQuit.find((row) => row.id === modernTUI.id)!;
		const legacyBefore = beforeQuit.find((row) => row.id === legacyTUI.id)!;
		expect(chatBefore.session_mode).toBe("chat");
		expect(modernBefore.runtime_handle_id).toMatch(/^ptyhost-v1:/);

		await quitApp(first);
		await waitStopped(port);
		const afterGracefulQuit = sqliteRows(db);
		expect(afterGracefulQuit.find((row) => row.id === chat.id)!.activity_state).toBe(chatBefore.activity_state);
		expect(afterGracefulQuit.find((row) => row.id === modernTUI.id)!.activity_state).toBe(modernBefore.activity_state);

		// Replace only the third session's modern host with a faithful pre-upgrade
		// private-socket tmux pane and stale durable facts. The current/default
		// namespace gets a same-name foreign pane to prove ownership beats names.
		const registryPath = path.join(root, "windows-pty-hosts.json");
		const registry = JSON.parse(await fs.readFile(registryPath, "utf8")) as Array<{
			sessionId: string;
			ptyHostPid: number;
		}>;
		const legacyHost = registry.find((entry) => entry.sessionId === legacyTUI.id);
		if (legacyHost) {
			process.kill(legacyHost.ptyHostPid, "SIGTERM");
			await waitFor(async () => {
				try {
					process.kill(legacyHost.ptyHostPid, 0);
					return null;
				} catch {
					return true;
				}
			}, 10_000);
			await fs.writeFile(
				registryPath,
				JSON.stringify(registry.filter((entry) => entry.sessionId !== legacyTUI.id), null, 2),
			);
		}

		const legacyLaunch = `legacy-launch-${Date.now()}`;
		const activeAt = new Date(Date.now() - 2_000).toISOString();
		const exitedAt = new Date(Date.now() - 1_000).toISOString();
		execFileSync("sqlite3", [
			db,
			`UPDATE sessions SET activity_state='active', activity_last_at=${sqlQuote(activeAt)}, updated_at=${sqlQuote(activeAt)} WHERE id=${sqlQuote(legacyTUI.id)};`,
		]);
		execFileSync("sqlite3", [
			db,
			`UPDATE sessions SET activity_state='exited', activity_last_at=${sqlQuote(exitedAt)}, updated_at=${sqlQuote(exitedAt)}, runtime_handle_id=${sqlQuote(legacyTUI.id)}, runtime_launch_id=${sqlQuote(legacyLaunch)}, agent_session_id_launch_id=${sqlQuote(legacyLaunch)} WHERE id=${sqlQuote(legacyTUI.id)};`,
		]);

		const launchCommand = [
			`cd ${shellQuote(legacyBefore.workspace_path)} || exit;`,
			"unset NO_COLOR;",
			`export AO_RUN_FILE=${shellQuote(runFile)};`,
			`export AO_SESSION_ID=${shellQuote(legacyTUI.id)};`,
			"export AO_SUPERVISED_PROCESS='1';",
			"export COLORTERM='truecolor';",
			`export PATH=${shellQuote(env.PATH ?? "")};`,
			[
				daemon,
				"agent-process",
				"supervise",
				"--session",
				legacyTUI.id,
				"--launch",
				legacyLaunch,
				"--",
				"/bin/sleep",
				"3600",
			].map(shellQuote).join(" ") + ";",
			"exec cat >/dev/null",
		].join(" ");
		const socket = historicalSocket(runFile);
		await fs.mkdir(path.dirname(socket), { recursive: true });
		await execFileAsync(
			tmux,
			[
				"-S", socket, "new-session", "-d", "-s", legacyTUI.id,
				"-x", "220", "-y", "50", "-c", legacyBefore.workspace_path,
				"/bin/zsh", "-c", launchCommand,
			],
			{ env },
		);
		await execFileAsync(tmux, ["-L", "default", "new-session", "-d", "-s", legacyTUI.id, "/bin/sleep", "3600"], { env });
		foreignCreated = true;

		const second = await launchApp(env, logs);
		apps.push(second);
		const stopSecondObservation = { value: false };
		const secondExitedFrames = observeExitedFrames(second.window, stopSecondObservation);
		await waitReady(runFile, port);
		await expect(second.window.getByText("Restart E2E", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
		await second.window.getByText("Restart E2E", { exact: true }).first().click();
		for (const name of ["Chat Restart", "Native TUI", "Legacy TUI"]) {
			await expect(second.window.getByText(name, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
		}
		stopSecondObservation.value = true;
		expect(await secondExitedFrames).toEqual([]);
		await second.window.screenshot({ path: testInfo.outputPath("restart-two-ready.png") });

		const afterSecond = sqliteRows(db);
		const chatSecond = afterSecond.find((row) => row.id === chat.id)!;
		const modernSecond = afterSecond.find((row) => row.id === modernTUI.id)!;
		const legacySecond = afterSecond.find((row) => row.id === legacyTUI.id)!;
		expect(chatSecond.activity_state).not.toBe("exited");
		expect(chatSecond.agent_session_id).toBe(chatBefore.agent_session_id);
		expect(modernSecond.activity_state).not.toBe("exited");
		expect(modernSecond.runtime_handle_id).toBe(modernBefore.runtime_handle_id);
		expect(legacySecond.activity_state).toBe("active");
		expect(legacySecond.runtime_launch_id).toBe(legacyLaunch);
		expect(legacySecond.runtime_handle_id).toMatch(/^tmux-v1:/);
		await execFileAsync(tmux, ["-L", "default", "has-session", "-t", `=${legacyTUI.id}`], { env });

		await quitApp(second);
		await waitStopped(port);

		const third = await launchApp(env, logs);
		apps.push(third);
		const stopThirdObservation = { value: false };
		const thirdExitedFrames = observeExitedFrames(third.window, stopThirdObservation);
		await waitReady(runFile, port);
		await expect(third.window.getByText("Restart E2E", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
		await third.window.getByText("Restart E2E", { exact: true }).first().click();
		await expect(third.window.getByText("Legacy TUI", { exact: true }).first()).toBeVisible({ timeout: 30_000 });
		stopThirdObservation.value = true;
		expect(await thirdExitedFrames).toEqual([]);
		const afterThird = sqliteRows(db);
		expect(afterThird.find((row) => row.id === legacyTUI.id)!.runtime_handle_id).toBe(legacySecond.runtime_handle_id);
		expect(afterThird.find((row) => row.id === legacyTUI.id)!.activity_state).toBe("active");

		for (const session of [chat, modernTUI, legacyTUI]) {
			await api(port, `/api/v1/sessions/${encodeURIComponent(session.id)}/kill`, { method: "POST", body: "{}" });
		}
		await quitApp(third);
		await waitStopped(port);
	} finally {
		await testInfo.attach("native-app-logs", { body: logs.join("\n"), contentType: "text/plain" });
		for (const app of apps.reverse()) await quitApp(app).catch(() => undefined);
		await cleanupDetachedHosts(root, dataDir);
		if (foreignCreated) {
			await execFileAsync(tmux, ["-L", "default", "kill-session", "-t", "=restart-e2e-3"], { env }).catch(() => undefined);
		}
		await execFileAsync(tmux, ["-S", historicalSocket(runFile), "kill-server"], { env }).catch(() => undefined);
		await fs.rm(root, { recursive: true, force: true });
	}
});
