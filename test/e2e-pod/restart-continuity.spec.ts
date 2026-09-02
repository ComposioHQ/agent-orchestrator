import {
	test,
	expect,
	_electron as electron,
	type ElectronApplication,
	type Page,
	type WebSocket,
} from "@playwright/test";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { execFile, execFileSync, spawn as spawnProcess, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const RUN_REAL_RESTART_E2E = process.env.AO_RESTART_CONTINUITY_E2E === "1";
const APP_BIN = process.env.AO_APP_BIN ?? "";

type RunFile = { pid: number; port: number; owner?: string; appRunId?: string };
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
type NativeApp = {
	process: ChildProcess;
	application: ElectronApplication;
	renderer: NativeRenderer;
	observerId: string;
	appRunId: string;
};

type PtyHostRegistryEntry = {
	sessionId: string;
	ptyHostPid: number;
	pipePath: string;
	launchId?: string;
	hostToken?: string;
	registeredAt?: string;
};

type PtyHostStatus = {
	alive: boolean;
	pid: number;
	protocolVersion: number;
	sessionId?: string;
	launchId?: string;
	hostPid?: number;
	hostToken?: string;
};

type ChatHostDescriptor = {
	version: number;
	sessionId: string;
	address: string;
	token: string;
	pid: number;
};

type ShellTarget = { id: number; url: string };

const visibleElementSource = `
	(element) => {
		if (!(element instanceof HTMLElement)) return false;
		const style = getComputedStyle(element);
		const rect = element.getBoundingClientRect();
		return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
	}
`;

/**
 * Drives AO's real shell WebContentsView through Electron's main process.
 *
 * Playwright's Electron `windows()` API is centered on BrowserWindow. AO uses a
 * BaseWindow with an explicit WebContentsView, so waiting for a Playwright Page
 * is an unnecessary (and occasionally missed) transport event. The WebContents
 * itself is the durable identity and exposes the exact production renderer.
 */
class NativeRenderer {
	constructor(
		private readonly application: ElectronApplication,
		private readonly target: ShellTarget,
		readonly page?: Page,
	) {}

	private async execute<R>(expression: string): Promise<R> {
		return this.application.evaluate(
			async ({ webContents }, input) => {
				const target = webContents.fromId(input.id);
				if (
					!target ||
					target.isDestroyed() ||
					!target.getURL().startsWith("app://renderer")
				) {
					throw new Error("AO shell WebContents was replaced or destroyed");
				}
				return target.executeJavaScript(input.expression, true);
			},
			{ id: this.target.id, expression },
		) as Promise<R>;
	}

	async bodyContains(text: string): Promise<boolean> {
		return this.execute(`(document.body?.innerText ?? "").includes(${JSON.stringify(text)})`);
	}

	async hasVisibleExactText(text: string): Promise<boolean> {
		return this.execute(`(() => {
			const visible = ${visibleElementSource};
			const needle = ${JSON.stringify(text)};
			const normalize = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
			return Array.from(document.querySelectorAll("body *")).some(
				(element) => visible(element) && normalize(element.textContent) === needle,
			);
		})()`);
	}

	async clickExactText(text: string): Promise<void> {
		const clicked = await this.execute<boolean>(`(() => {
			const visible = ${visibleElementSource};
			const needle = ${JSON.stringify(text)};
			const normalize = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
			const candidates = Array.from(document.querySelectorAll("body *")).filter(
				(element) => visible(element) && normalize(element.textContent) === needle,
			);
			const target = candidates.find((element) =>
				!Array.from(element.querySelectorAll("*")).some(
					(descendant) => visible(descendant) && normalize(descendant.textContent) === needle,
				),
			) ?? candidates[candidates.length - 1];
			if (!(target instanceof HTMLElement)) return false;
			target.click();
			return true;
		})()`);
		if (!clicked) throw new Error(`visible text ${JSON.stringify(text)} was not clickable`);
	}

	async clickSessionCard(name: string): Promise<void> {
		const clicked = await this.execute<boolean>(`(() => {
			const visible = ${visibleElementSource};
			const name = ${JSON.stringify(name)};
			const target = Array.from(document.querySelectorAll('[data-testid="board-session-card"]')).find(
				(element) => visible(element) && (element.textContent ?? "").includes(name),
			);
			if (!(target instanceof HTMLElement)) return false;
			target.click();
			return true;
		})()`);
		// Once a card opens the detail route, the board is unmounted but the same
		// sessions remain user-selectable in the sidebar. Follow that real UI path
		// for subsequent session switches.
		if (!clicked) await this.clickExactText(name);
	}

	async isTestIdVisible(testId: string): Promise<boolean> {
		return this.execute(`(() => {
			const visible = ${visibleElementSource};
			return Array.from(document.querySelectorAll("[data-testid]")).some(
				(element) => element.getAttribute("data-testid") === ${JSON.stringify(testId)} && visible(element),
			);
		})()`);
	}

	async testIdCount(testId: string): Promise<number> {
		return this.execute(`Array.from(document.querySelectorAll("[data-testid]")).filter(
			(element) => element.getAttribute("data-testid") === ${JSON.stringify(testId)},
		).length`);
	}

	async visibleExactTextCount(text: string): Promise<number> {
		return this.execute(`(() => {
			const visible = ${visibleElementSource};
			const needle = ${JSON.stringify(text)};
			const normalize = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
			return Array.from(document.querySelectorAll("body *")).filter(
				(element) => visible(element) && normalize(element.textContent) === needle,
			).length;
		})()`);
	}

	async startupRecoveryLayers(): Promise<{ overlay: number; cover: number; banner: number } | null> {
		return this.execute(`(() => {
			const cover = document.querySelector('[data-testid="startup-recovery-cover"]');
			const banner = document.querySelector('[role="alert"]');
			if (!(cover instanceof HTMLElement) || !(banner instanceof HTMLElement)) return null;
			const number = (value) => Number.parseFloat(value.trim());
			return {
				overlay: number(getComputedStyle(document.documentElement).getPropertyValue('--z-overlay')),
				cover: number(getComputedStyle(cover).zIndex),
				banner: number(getComputedStyle(banner).zIndex),
			};
		})()`);
	}

	async focusWithinTestId(testId: string, selector: string): Promise<void> {
		const focused = await this.execute<boolean>(`(() => {
			const visible = ${visibleElementSource};
			const owner = Array.from(document.querySelectorAll("[data-testid]")).find(
				(element) => element.getAttribute("data-testid") === ${JSON.stringify(testId)} && visible(element),
			);
			const target = owner?.querySelector(${JSON.stringify(selector)});
			if (!(target instanceof HTMLElement)) return false;
			target.focus();
			return document.activeElement === target;
		})()`);
		if (!focused) throw new Error(`could not focus ${selector} within [data-testid=${testId}]`);
	}

	async textContentsWithinTestId(testId: string, selector: string): Promise<string[]> {
		return this.execute(`(() => {
			const owners = Array.from(document.querySelectorAll("[data-testid]")).filter(
				(element) => element.getAttribute("data-testid") === ${JSON.stringify(testId)},
			);
			return owners.flatMap((owner) =>
				Array.from(owner.querySelectorAll(${JSON.stringify(selector)})).map(
					(element) => element.textContent ?? "",
				),
			);
		})()`);
	}

	async type(text: string): Promise<void> {
		if (this.page) {
			try {
				await this.page.keyboard.type(text);
				return;
			} catch {
				// Fall through to the BaseWindow-safe Electron input path.
			}
		}
		await this.application.evaluate(
			({ webContents }, input) => {
				const target = webContents.fromId(input.id);
				if (!target || target.isDestroyed()) throw new Error("AO shell WebContents is unavailable");
				target.focus();
				for (const character of input.text) {
					target.sendInputEvent({ type: "keyDown", keyCode: character });
					target.sendInputEvent({ type: "char", keyCode: character });
					target.sendInputEvent({ type: "keyUp", keyCode: character });
				}
			},
			{ id: this.target.id, text },
		);
	}

	async press(key: "Enter" | "Control+U"): Promise<void> {
		if (this.page) {
			try {
				await this.page.keyboard.press(key);
				return;
			} catch {
				// Fall through to the BaseWindow-safe Electron input path.
			}
		}
		await this.application.evaluate(
			({ webContents }, input) => {
				const target = webContents.fromId(input.id);
				if (!target || target.isDestroyed()) throw new Error("AO shell WebContents is unavailable");
				target.focus();
				if (input.key === "Control+U") {
					target.sendInputEvent({ type: "keyDown", keyCode: "U", modifiers: ["control"] });
					target.sendInputEvent({ type: "keyUp", keyCode: "U", modifiers: ["control"] });
					return;
				}
				target.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
				target.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
			},
			{ id: this.target.id, key },
		);
	}

	async screenshot(file: string): Promise<void> {
		if (this.page) {
			try {
				await this.page.screenshot({ path: file });
				return;
			} catch {
				// Fall through to capturePage on the exact WebContentsView.
			}
		}
		const base64 = await this.application.evaluate(
			async ({ webContents }, input) => {
				const target = webContents.fromId(input.id);
				if (!target || target.isDestroyed()) throw new Error("AO shell WebContents is unavailable");
				return (await target.capturePage()).toPNG().toString("base64");
			},
			{ id: this.target.id },
		);
		await fs.writeFile(file, Buffer.from(base64, "base64"));
	}

	async requestQuit(): Promise<void> {
		await this.execute(`window.ao?.menu?.action("app.quit")`);
	}

	async observationId(): Promise<string | null> {
		return this.execute(`window.__aoRestartObservation?.id ?? null`);
	}

	async exitedFrames(expectedId: string): Promise<string[]> {
		return this.execute(`(() => {
			const observation = window.__aoRestartObservation;
			if (!observation || observation.id !== ${JSON.stringify(expectedId)}) {
				throw new Error("restart observer document was replaced; refusing a false-negative frame assertion");
			}
			return observation.exitedFrames();
		})()`);
	}
}

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

async function waitReady(
	runFile: string,
	expectedPort: number,
	expectedAppRunId?: string,
): Promise<RunFile> {
	const info = await waitFor(async () => {
		const candidate = await readRunFile(runFile);
		return candidate?.port === expectedPort &&
			(!expectedAppRunId || candidate.appRunId === expectedAppRunId)
			? candidate
			: null;
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

async function waitStartupRecoveryFailure(
	runFile: string,
	expectedPort: number,
	expectedAppRunId?: string,
): Promise<RunFile> {
	const info = await waitFor(async () => {
		const candidate = await readRunFile(runFile);
		return candidate?.port === expectedPort &&
			(!expectedAppRunId || candidate.appRunId === expectedAppRunId)
			? candidate
			: null;
	});
	await waitFor(async () => {
		try {
			const response = await fetch(`http://127.0.0.1:${expectedPort}/readyz`);
			const payload = (await response.json()) as { status?: string; code?: string; pid?: number };
			return response.status === 503 &&
				payload.status === "error" &&
				payload.code === "startup_recovery_failed" &&
				payload.pid === info.pid
				? true
				: null;
		} catch {
			return null;
		}
	}, 45_000);
	return info;
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

async function stopFixtureDaemon(runFile: string, logs: string[]): Promise<boolean> {
	const info = await readRunFile(runFile);
	if (!info) return true;
	let owned = false;
	try {
		const health = await fetch(`http://127.0.0.1:${info.port}/healthz`);
		const payload = (await health.json()) as { status?: string; service?: string; pid?: number };
		owned =
			health.ok &&
			payload.status === "ok" &&
			payload.service === "agent-orchestrator-daemon" &&
			payload.pid === info.pid;
	} catch {
		return true;
	}
	if (!owned) {
		logs.push(`[cleanup] refused to stop daemon ${info.pid}: health identity did not match`);
		return false;
	}
	await fetch(`http://127.0.0.1:${info.port}/shutdown`, { method: "POST" }).catch(() => undefined);
	try {
		await waitFor(async () => {
			try {
				await fetch(`http://127.0.0.1:${info.port}/healthz`);
				return null;
			} catch {
				return true;
			}
		}, 5_000);
		return true;
	} catch {
		// The identity-safe HTTP control path is the only authority this harness
		// has over the daemon. Never signal a stale numeric PID: it may have been
		// reused by an unrelated process after the health check.
		logs.push(`[cleanup] daemon ${info.pid} ignored its authenticated fixture /shutdown request`);
		return false;
	}
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

async function historicalSocketAddress(runFile: string): Promise<{ address: string; aliasDir?: string }> {
	const rawSocket = historicalSocket(runFile);
	if (Buffer.byteLength(rawSocket) <= 103) return { address: rawSocket };
	if (process.getuid === undefined) throw new Error("historical tmux socket alias requires a Unix uid");

	const targetDir = await fs.realpath(path.dirname(rawSocket));
	const canonicalSocket = path.join(targetDir, path.basename(rawSocket));
	const digest = createHash("sha256").update(canonicalSocket).digest().subarray(0, 16).toString("hex");
	const aliasRoot = `/tmp/ao-tmux-${process.getuid()}`;
	const aliasDir = path.join(aliasRoot, digest);
	await fs.mkdir(aliasRoot, { recursive: true, mode: 0o700 });
	await fs.chmod(aliasRoot, 0o700);
	try {
		await fs.symlink(targetDir, aliasDir, "dir");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existingTarget = await fs.realpath(aliasDir);
		if (existingTarget !== targetDir) {
			throw new Error(`historical tmux alias ${aliasDir} points to ${existingTarget}, want ${targetDir}`);
		}
	}
	return { address: path.join(aliasDir, path.basename(canonicalSocket)), aliasDir };
}

function isolatedAppEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const inherited = ["PATH", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "USER", "LOGNAME", "TERM"];
	const env: NodeJS.ProcessEnv = {};
	for (const key of inherited) {
		if (process.env[key] !== undefined) env[key] = process.env[key];
	}
	return { ...env, ...overrides };
}

async function launchApp(
	env: NodeJS.ProcessEnv,
	logs: string[],
): Promise<NativeApp> {
	const appRunId = `restart-e2e-${randomUUID()}`;
	const launchEnv = {
		...env,
		// A real desktop restart is a new supervisor owner. Reusing this value
		// would accidentally test an in-process refresh instead of owner handoff.
		AO_APP_RUN_ID: appRunId,
		// main.ts passes this into the WebContentsView's additionalArguments before
		// preload runs, so the frame ledger covers the document from creation.
		AO_RESTART_CONTINUITY_E2E: "1",
	};
	let application: ElectronApplication | undefined;
	let child: ChildProcess | undefined;
	try {
		// Use Playwright's Electron main-process transport, as the repository's
		// packaged-app smoke tests do. Raw connectOverCDP can hang forever on
		// Electron's browser websocket. AO's UI is an explicit WebContentsView under
		// BaseWindow, so discover it by WebContents identity instead of depending on
		// a BrowserWindow-oriented `windows()` event.
		application = await electron.launch({
			executablePath: APP_BIN,
			args: ["--use-mock-keychain", "--disable-gpu", "--no-sandbox"],
			env: launchEnv,
			timeout: 30_000,
		});
		const launchedChild = application.process();
		child = launchedChild;
		launchedChild.stdout?.on("data", (chunk) => logs.push(`[stdout] ${String(chunk)}`));
		launchedChild.stderr?.on("data", (chunk) => logs.push(`[stderr] ${String(chunk)}`));
		launchedChild.once("exit", (code, signal) =>
			logs.push(`[app-exit] code=${String(code)} signal=${String(signal)}`),
		);
		const target = await waitFor(async () => {
			return application!.evaluate(({ webContents }) => {
				const shell = webContents
					.getAllWebContents()
					.find((candidate) => candidate.getURL().startsWith("app://renderer"));
				return shell ? { id: shell.id, url: shell.getURL() } : null;
			});
		}, 30_000);
		const page = application.windows().find((candidate) => candidate.url() === target.url);
		const renderer = new NativeRenderer(application, target, page);
		const observerId = await waitFor(() => renderer.observationId(), 10_000).catch(() => {
			throw new Error(
				"restart observer missed document creation; verify AO_RESTART_CONTINUITY_E2E reached the packaged app",
			);
		});
		return { process: launchedChild, application, renderer, observerId, appRunId };
	} catch (error) {
		if (application) {
			await Promise.race([
				application.close().catch(() => undefined),
				new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
			]);
		}
		if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		throw error;
	}
}

async function quitApp(app: NativeApp): Promise<void> {
	if (app.process.exitCode === null && app.process.signalCode === null) {
		const exited = new Promise<boolean>((resolve) => app.process.once("exit", () => resolve(true)));
		await app.renderer.requestQuit().catch(() => undefined);
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
		app.application.close().catch(() => undefined),
		new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
	]);
}

async function exitedFrames(app: NativeApp): Promise<string[]> {
	return app.renderer.exitedFrames(app.observerId);
}

function loopbackTarget(address: string): { host: string; port: number } {
	const match = /^(127\.0\.0\.1):(\d+)$/.exec(address);
	const port = Number(match?.[2]);
	if (!match || !Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`refusing non-loopback fixture host address ${JSON.stringify(address)}`);
	}
	return { host: match[1], port };
}

async function connectFixtureHost(address: string): Promise<net.Socket> {
	const target = loopbackTarget(address);
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(target);
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`timed out connecting to fixture host ${address}`));
		}, 3_000);
		socket.once("connect", () => {
			clearTimeout(timer);
			resolve(socket);
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

function ptyFrame(type: number): Buffer {
	return Buffer.from([type, 0, 0, 0, 0]);
}

async function readPtyStatus(socket: net.Socket): Promise<PtyHostStatus> {
	return new Promise((resolve, reject) => {
		let buffered = Buffer.alloc(0);
		const timer = setTimeout(() => finish(new Error("timed out reading fixture PTY status")), 3_000);
		const finish = (error?: Error, status?: PtyHostStatus) => {
			clearTimeout(timer);
			socket.off("data", onData);
			socket.off("error", onError);
			socket.off("close", onClose);
			if (error) reject(error);
			else resolve(status!);
		};
		const onError = (error: Error) => finish(error);
		const onClose = () => finish(new Error("fixture PTY host closed before status proof"));
		const onData = (chunk: Buffer) => {
			buffered = Buffer.concat([buffered, chunk]);
			while (buffered.length >= 5) {
				const payloadLength = buffered.readUInt32BE(1);
				if (payloadLength > 4 * 1024 * 1024) {
					finish(new Error(`fixture PTY host sent oversized frame (${payloadLength} bytes)`));
					return;
				}
				const frameLength = 5 + payloadLength;
				if (buffered.length < frameLength) return;
				const type = buffered[0];
				const payload = buffered.subarray(5, frameLength);
				buffered = buffered.subarray(frameLength);
				if (type !== 0x07) continue;
				try {
					const status = JSON.parse(payload.toString("utf8")) as Partial<PtyHostStatus>;
					if (
						typeof status.alive !== "boolean" ||
						typeof status.pid !== "number" ||
						!Number.isInteger(status.pid) ||
						typeof status.protocolVersion !== "number" ||
						!Number.isInteger(status.protocolVersion)
					) {
						finish(new Error("fixture PTY host returned an incompatible status proof"));
						return;
					}
					finish(undefined, status as PtyHostStatus);
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
				return;
			}
		};
		socket.on("data", onData);
		socket.once("error", onError);
		socket.once("close", onClose);
		socket.write(ptyFrame(0x06));
	});
}

function assertPtyHostStatusIdentity(entry: PtyHostRegistryEntry, status: PtyHostStatus): void {
	if (entry.hostToken) {
		const expectedToken = Buffer.from(entry.hostToken);
		const observedToken = Buffer.from(typeof status.hostToken === "string" ? status.hostToken : "");
		if (
			status.protocolVersion < 3 ||
			status.sessionId !== entry.sessionId ||
			status.launchId !== entry.launchId ||
			status.hostPid !== entry.ptyHostPid ||
			expectedToken.length !== observedToken.length ||
			!timingSafeEqual(expectedToken, observedToken)
		) {
			throw new Error(`refusing to control PTY host: authenticated fixture identity did not match`);
		}
		return;
	}
	if (
		status.protocolVersion !== 2 ||
		status.sessionId !== undefined ||
		status.launchId !== undefined ||
		status.hostPid !== undefined ||
		status.hostToken !== undefined
	) {
		throw new Error(`refusing to control PTY host: legacy fixture protocol proof did not match`);
	}
}

async function shutdownPtyHost(
	entry: PtyHostRegistryEntry,
	runFile: string,
	expectedExecutable: string,
): Promise<void> {
	if (!entry.launchId) throw new Error(`PTY host ${entry.sessionId} has no immutable launch identity`);
	const target = loopbackTarget(entry.pipePath);
	const { stdout: command } = await execFileAsync(
		"/bin/ps",
		["eww", "-p", String(entry.ptyHostPid), "-o", "command="],
		{ encoding: "utf8" },
	);
	if (
		!command.includes(expectedExecutable) ||
		!command.includes(` pty-host ${entry.sessionId} `) ||
		!command.includes(`AO_RUN_FILE=${runFile}`) ||
		!command.includes(`AO_RUNTIME_LAUNCH_ID=${entry.launchId}`)
	) {
		throw new Error(`refusing to control PTY pid ${entry.ptyHostPid}: immutable fixture identity did not match`);
	}
	const { stdout: listeners } = await execFileAsync(
		"/usr/sbin/lsof",
		["-nP", "-a", "-p", String(entry.ptyHostPid), `-iTCP:${target.port}`, "-sTCP:LISTEN", "-Fn"],
		{ encoding: "utf8" },
	);
	const listenerFacts = listeners.split("\n");
	if (!listenerFacts.includes(`p${entry.ptyHostPid}`) || !listenerFacts.includes(`n127.0.0.1:${target.port}`)) {
		throw new Error(`refusing to control PTY pid ${entry.ptyHostPid}: fixture listener ownership did not match`);
	}

	const socket = await connectFixtureHost(entry.pipePath);
	try {
		const status = await readPtyStatus(socket);
		assertPtyHostStatusIdentity(entry, status);
		if (status.alive) {
			const { stdout: parent } = await execFileAsync(
				"/bin/ps",
				["-p", String(status.pid), "-o", "ppid="],
				{ encoding: "utf8" },
			);
			if (Number(parent.trim()) !== entry.ptyHostPid) {
				throw new Error(`refusing to control PTY host: managed child ${status.pid} has the wrong owner`);
			}
		}
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("fixture PTY host ignored graceful shutdown")), 5_000);
			socket.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			socket.write(ptyFrame(0x08));
		});
		await waitFor(async () => {
			try {
				const { stdout } = await execFileAsync(
					"/bin/ps",
					["-p", String(entry.ptyHostPid), "-o", "pid="],
					{ encoding: "utf8" },
				);
				return stdout.trim() === "" ? true : null;
			} catch (error) {
				const exitCode = (error as { code?: unknown }).code;
				if (exitCode === 1) return true;
				throw error;
			}
		}, 5_000);
	} finally {
		socket.destroy();
	}
}

async function launchPackagedProtocolV2PtyHost(
	executable: string,
	sessionId: string,
	workspacePath: string,
	launchId: string,
	env: NodeJS.ProcessEnv,
	logs: string[],
	registryPath: string,
	registryEntries: PtyHostRegistryEntry[],
): Promise<{ entry: PtyHostRegistryEntry; childPid: number }> {
	const hostEnv: NodeJS.ProcessEnv = {
		...env,
		AO_SESSION_ID: sessionId,
		AO_RUNTIME_LAUNCH_ID: launchId,
		AO_RESTART_CONTINUITY_E2E: "1",
		AO_RESTART_CONTINUITY_PTY_V2: "1",
		AO_SUPERVISED_PROCESS: "1",
	};
	// A token would select the modern authenticated protocol. This fixture
	// deliberately exercises adoption of an already-running shipped v2 host.
	delete hostEnv.AO_PTY_HOST_TOKEN;
	const child = spawnProcess(
		executable,
		[
			"pty-host",
			sessionId,
			workspacePath,
			executable,
			"agent-process",
			"supervise",
			"--session",
			sessionId,
			"--launch",
			launchId,
			"--",
			"/bin/zsh",
			"-f",
		],
		{
			cwd: workspacePath,
			detached: true,
			env: hostEnv,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const hostPid = child.pid;
	if (!hostPid) throw new Error("packaged protocol-v2 pty-host did not receive a process id");

	try {
		const ready = await new Promise<{ childPid: number; port: number }>((resolve, reject) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			const finish = (error?: Error, value?: { childPid: number; port: number }) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				child.off("error", onError);
				child.off("exit", onExit);
				if (error) reject(error);
				else resolve(value!);
			};
			const onError = (error: Error) => finish(error);
			const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
				finish(
					new Error(
						`packaged protocol-v2 pty-host exited before READY (code=${String(code)} ` +
							`signal=${String(signal)} stderr=${JSON.stringify(stderr.slice(-2_000))})`,
					),
				);
			const timer = setTimeout(
				() => finish(new Error(`timed out waiting for packaged protocol-v2 pty-host READY: ${stderr.slice(-2_000)}`)),
				10_000,
			);
			child.once("error", onError);
			child.once("exit", onExit);
			child.stdout!.on("data", (chunk) => {
				stdout += String(chunk);
				const match = /READY:(\d+) (\d+)/.exec(stdout);
				if (!match) return;
				finish(undefined, { childPid: Number(match[1]), port: Number(match[2]) });
			});
			child.stderr!.on("data", (chunk) => {
				const text = String(chunk);
				stderr += text;
				logs.push(`[v2-pty-stderr] ${text}`);
			});
		});
		const entry: PtyHostRegistryEntry = {
			sessionId,
			ptyHostPid: hostPid,
			pipePath: `127.0.0.1:${ready.port}`,
			launchId,
			registeredAt: new Date().toISOString(),
		};
		await fs.writeFile(
			registryPath,
			`${JSON.stringify(
				[...registryEntries.filter((candidate) => candidate.sessionId !== sessionId), entry],
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
		child.stdout?.destroy();
		child.stderr?.destroy();
		child.unref();
		return { entry, childPid: ready.childPid };
	} catch (error) {
		if (child.exitCode === null && child.signalCode === null) {
			// `detached` created this exact process group. Stop both the host and its
			// PTY child if fixture publication fails before normal authenticated
			// teardown can own them.
			try {
				process.kill(-hostPid, "SIGKILL");
			} catch (killError) {
				if ((killError as NodeJS.ErrnoException).code !== "ESRCH") throw killError;
			}
		}
		throw error;
	}
}

async function assertPtyHostRunning(entry: PtyHostRegistryEntry, expectedChildPid: number): Promise<void> {
	const socket = await connectFixtureHost(entry.pipePath);
	try {
		const status = await readPtyStatus(socket);
		assertPtyHostStatusIdentity(entry, status);
		if (!status.alive || status.pid !== expectedChildPid) {
			throw new Error(`fixture PTY host child identity did not survive restart`);
		}
	} finally {
		socket.destroy();
	}
}

async function assertPtyRegistryOwnership(
	registryPath: string,
	expected: PtyHostRegistryEntry,
): Promise<void> {
	const entries = JSON.parse(await fs.readFile(registryPath, "utf8")) as PtyHostRegistryEntry[];
	const observed = entries.find((entry) => entry.sessionId === expected.sessionId);
	if (
		!observed ||
		observed.ptyHostPid !== expected.ptyHostPid ||
		observed.pipePath !== expected.pipePath ||
		observed.launchId !== expected.launchId ||
		observed.hostToken !== expected.hostToken ||
		observed.registeredAt !== expected.registeredAt
	) {
		throw new Error(`durable PTY registry ownership changed for ${expected.sessionId}`);
	}
}

async function shutdownChatHost(descriptor: ChatHostDescriptor): Promise<void> {
	if (
		descriptor.version !== 1 ||
		!descriptor.sessionId ||
		!descriptor.token ||
		!Number.isInteger(descriptor.pid)
	) {
		throw new Error("invalid fixture Chat host descriptor");
	}
	const socket = await connectFixtureHost(descriptor.address);
	try {
		await new Promise<void>((resolve, reject) => {
			let buffered = "";
			const timer = setTimeout(() => reject(new Error("fixture Chat host ignored authenticated shutdown")), 3_000);
			socket.on("data", (chunk) => {
				buffered += String(chunk);
				const newline = buffered.indexOf("\n");
				if (newline < 0) return;
				try {
					const response = JSON.parse(buffered.slice(0, newline)) as { ok?: boolean; error?: string };
					if (!response.ok) throw new Error(response.error || "fixture Chat host rejected shutdown");
					clearTimeout(timer);
					resolve();
				} catch (error) {
					clearTimeout(timer);
					reject(error);
				}
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			socket.write(`${JSON.stringify({ version: 1, token: descriptor.token, action: "shutdown" })}\n`);
		});
	} finally {
		socket.destroy();
	}
}

async function assertChatControllerAttached(descriptor: ChatHostDescriptor): Promise<void> {
	const socket = await connectFixtureHost(descriptor.address);
	try {
		await new Promise<void>((resolve, reject) => {
			let buffered = "";
			const timer = setTimeout(() => reject(new Error("timed out proving Chat controller ownership")), 3_000);
			socket.on("data", (chunk) => {
				buffered += String(chunk);
				const newline = buffered.indexOf("\n");
				if (newline < 0) return;
				clearTimeout(timer);
				try {
					const response = JSON.parse(buffered.slice(0, newline)) as { ok?: boolean; error?: string };
					if (response.ok || response.error !== "chat host already has a controller") {
						throw new Error(`Chat host did not prove an attached controller: ${JSON.stringify(response)}`);
					}
					resolve();
				} catch (error) {
					reject(error);
				}
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			socket.write(`${JSON.stringify({ version: 1, token: descriptor.token, action: "attach" })}\n`);
		});
	} finally {
		socket.destroy();
	}
}

async function typeAndObserveNativeTerminal(
	renderer: NativeRenderer,
	root: string,
	label: string,
	displayName = "Native TUI",
): Promise<void> {
	const marker = `NATIVE_${label}_${path.basename(root).replaceAll(/[^A-Za-z0-9]/g, "")}`;
	const received: string[] = [];
	const terminalOutput: string[] = [];
	const terminalInput: string[] = [];
	const decodeTerminalDataFrame = (payload: string, destination: string[]) => {
		try {
			const frame = JSON.parse(payload) as { ch?: unknown; type?: unknown; data?: unknown };
			if (frame.ch === "terminal" && frame.type === "data" && typeof frame.data === "string") {
				destination.push(Buffer.from(frame.data, "base64").toString("utf8"));
			}
		} catch {
			// Binary/raw frames remain available in `received` for diagnostics.
		}
	};
	const onWebSocket = (socket: WebSocket) => {
		socket.on("framereceived", ({ payload }) => {
			const raw = typeof payload === "string" ? payload : payload.toString("utf8");
			received.push(raw);
			decodeTerminalDataFrame(raw, terminalOutput);
		});
		socket.on("framesent", ({ payload }) => {
			const raw = typeof payload === "string" ? payload : payload.toString("utf8");
			decodeTerminalDataFrame(raw, terminalInput);
		});
	};
	renderer.page?.on("websocket", onWebSocket);
	try {
		await renderer.clickSessionCard(displayName);
		await waitFor(async () => (await renderer.isTestIdVisible("session-terminal")) || null, 30_000);
		await waitFor(async () => ((await renderer.testIdCount("terminal-replay-cover")) === 0) || null, 30_000);
		await renderer.focusWithinTestId("session-terminal", ".xterm-helper-textarea");
		const outputFramesBeforeInput = terminalOutput.length;
		await renderer.type(marker);
		try {
			await waitFor(async () => {
				const visible = await renderer.textContentsWithinTestId(
					"session-terminal",
					".xterm-rows, .xterm-accessibility-tree",
				);
				const exactInputReachedMux = terminalInput.join("").includes(marker);
				const outputReturnedAfterInput = terminalOutput.length > outputFramesBeforeInput;
				return visible.join("\n").includes(marker) || (exactInputReachedMux && outputReturnedAfterInput)
					? true
					: null;
			}, 30_000);
		} catch (error) {
			const visible = await renderer.textContentsWithinTestId(
				"session-terminal",
				".xterm-rows, .xterm-accessibility-tree",
			);
			throw new Error(
				`native terminal input did not round-trip (playwrightPage=${Boolean(renderer.page)}, ` +
					`visible=${JSON.stringify(visible.join("\n").slice(-500))}, ` +
					`terminalInput=${JSON.stringify(terminalInput.join("").slice(-500))}, ` +
					`terminalOutput=${JSON.stringify(terminalOutput.join("").slice(-500))}, ` +
					`websocket=${JSON.stringify(received.join("").slice(-500))}): ${String(error)}`,
			);
		}
		// Leave the live agent prompt unsubmitted. Ctrl+U exercises the input path a
		// second time and prevents a later restart from interpreting the probe text.
		await renderer.press("Control+U");
	} finally {
		renderer.page?.off("websocket", onWebSocket);
	}
}

async function cleanupDetachedHosts(
	root: string,
	dataDir: string,
	runFile: string,
	daemon: string,
	logs: string[],
): Promise<boolean> {
	let clean = true;
	try {
		const registry = JSON.parse(
			await fs.readFile(path.join(root, "windows-pty-hosts.json"), "utf8"),
		) as PtyHostRegistryEntry[];
		for (const entry of registry) {
			await shutdownPtyHost(entry, runFile, daemon).catch((error) => {
				clean = false;
				logs.push(`[cleanup] preserve unproven PTY host ${entry.sessionId}: ${String(error)}`);
			});
		}
	} catch (error) {
		if (!isMissing(error)) {
			clean = false;
			logs.push(`[cleanup] preserve unreadable PTY registry: ${String(error)}`);
		}
	}
	try {
		const chatRoot = path.join(dataDir, "chat-hosts");
		for (const entry of await fs.readdir(chatRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			try {
				const descriptor = JSON.parse(
					await fs.readFile(path.join(chatRoot, entry.name, "host.json"), "utf8"),
				) as ChatHostDescriptor;
				if (descriptor.sessionId !== entry.name) {
					throw new Error("fixture Chat host descriptor/session mismatch");
				}
				await shutdownChatHost(descriptor);
			} catch (error) {
				const descriptorPath = path.join(chatRoot, entry.name, "host.json");
				try {
					await fs.access(descriptorPath);
					clean = false;
					logs.push(`[cleanup] preserve unproven Chat host ${entry.name}: ${String(error)}`);
				} catch (accessError) {
					if (!isMissing(accessError)) {
						clean = false;
						logs.push(`[cleanup] preserve unreadable Chat descriptor ${entry.name}: ${String(accessError)}`);
					}
				}
			}
		}
	} catch (error) {
		if (!isMissing(error)) {
			clean = false;
			logs.push(`[cleanup] preserve unreadable Chat host directory: ${String(error)}`);
		}
	}
	return clean;
}

function tmuxHasNoServer(error: unknown): boolean {
	const output = `${String((error as { stdout?: unknown })?.stdout ?? "")}\n${String((error as { stderr?: unknown })?.stderr ?? "")}`;
	return /no server running|failed to connect to server|connection refused/i.test(output);
}

async function tmuxSessionNames(
	tmux: string,
	namespaceArgs: string[],
	env: NodeJS.ProcessEnv,
): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync(tmux, [...namespaceArgs, "list-sessions", "-F", "#{session_name}"], {
			env,
			encoding: "utf8",
		});
		return stdout.split("\n").map((name) => name.trim()).filter(Boolean);
	} catch (error) {
		if (tmuxHasNoServer(error)) return [];
		throw error;
	}
}

async function stopFixtureTmuxSession(
	tmux: string,
	namespaceArgs: string[],
	sessionId: string,
	env: NodeJS.ProcessEnv,
	logs: string[],
	label: string,
): Promise<boolean> {
	try {
		if (!(await tmuxSessionNames(tmux, namespaceArgs, env)).includes(sessionId)) return true;
		await execFileAsync(tmux, [...namespaceArgs, "kill-session", "-t", `=${sessionId}`], { env });
		if ((await tmuxSessionNames(tmux, namespaceArgs, env)).includes(sessionId)) {
			throw new Error("session still exists after kill-session");
		}
		return true;
	} catch (error) {
		logs.push(`[cleanup] could not prove ${label} tmux session ${sessionId} stopped: ${String(error)}`);
		return false;
	}
}

test("packaged desktop restart preserves Chat and TUI continuity without an Exited frame @real", async ({}, testInfo) => {
	test.skip(!RUN_REAL_RESTART_E2E, "set AO_RESTART_CONTINUITY_E2E=1 for the destructive isolated native-app scenario");
	test.skip(process.platform !== "darwin", "the historical private-socket fixture in this scenario targets macOS");
	test.setTimeout(300_000);
	if (!APP_BIN) throw new Error("AO_APP_BIN must point to the packaged Electron executable");

	// Force the historical raw socket beyond macOS's sockaddr_un limit. The
	// #4393 fixture must therefore survive through its exact deterministic /tmp
	// alias, not through the easier short-path case.
	const root = await fs.mkdtemp(path.join("/tmp", `ao-restart-continuity-${"x".repeat(80)}-`));
	const home = path.join(root, "home");
	const dataDir = path.join(root, "data");
	const runFile = path.join(root, "running.json");
	const tmuxTmp = path.join(root, "tmux-tmp");
	const repo = path.join(root, "repo");
	const remote = path.join(root, "remote.git");
	const db = path.join(dataDir, "ao.db");
	const port = await freePort();
	const originalHome = os.homedir();
	const sourceCodexHome = process.env.CODEX_HOME || path.join(originalHome, ".codex");
	const codexHome = path.join(root, "codex-home");
	const codexAuth = path.join(codexHome, "auth.json");
	const logs: string[] = [];
	const phase = (message: string) => {
		const line = `[restart-e2e] ${message}`;
		logs.push(line);
		console.log(line);
	};
	const apps: NativeApp[] = [];
	const resources = path.resolve(APP_BIN, "../../Resources");
	const daemon = path.join(resources, "daemon", "ao");
	const tmux = path.join(resources, "tmux", "bin", "tmux");
	const historicalTarget = await historicalSocketAddress(runFile);
	expect(Buffer.byteLength(historicalSocket(runFile))).toBeGreaterThan(103);
	const env = isolatedAppEnv({
		HOME: home,
		CODEX_HOME: codexHome,
		AO_DATA_DIR: dataDir,
		AO_RUN_FILE: runFile,
		AO_PORT: String(port),
		AO_DISABLE_GPU: "1",
		AO_TELEMETRY_EVENTS: "off",
		AO_TELEMETRY_REMOTE: "off",
		// The packaged main process has a baked Sentry fallback. Point it at a
		// closed loopback port so even crash/error telemetry cannot leave this test.
		AO_SENTRY_DSN: "http://restart-e2e@127.0.0.1:9/1",
		ELECTRON_DISABLE_SANDBOX: "1",
		TMUX_TMPDIR: tmuxTmp,
	});

	let foreignCreated = false;
	let legacyFixtureSessionId: string | null = null;
	let scenarioCompleted = false;
	try {
		phase(`fixture ${root}`);
		await fs.mkdir(home, { recursive: true, mode: 0o700 });
		await fs.mkdir(codexHome, { recursive: true, mode: 0o700 });
		// A fresh state directory normally asks the user whether to enable updates.
		// This isolated test must never open a native modal or contact an update feed.
		// Persisting the production "Not now" shape makes that choice deterministic.
		await fs.writeFile(
			path.join(root, "update-settings.json"),
			`${JSON.stringify({ enabled: false, channel: "latest", nightlyAck: false, feature: null }, null, 2)}\n`,
			{ mode: 0o600 },
		);
		const sourceAuth = path.join(sourceCodexHome, "auth.json");
		const authStat = await fs.stat(sourceAuth);
		if (!authStat.isFile()) throw new Error(`${sourceAuth} is not a regular file`);
		await fs.copyFile(sourceAuth, codexAuth);
		await fs.chmod(codexAuth, 0o600);
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

		phase("launching initial app");
		const first = await launchApp(env, logs);
		apps.push(first);
		await waitReady(runFile, port, first.appRunId);
		phase("initial daemon ready");
		await waitFor(async () => (await first.renderer.bodyContains("Agent Orchestrator")) || null, 30_000);

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
		const protocolV2TUI = await spawn("Protocol v2 TUI", "tui");
		const legacyTUI = await spawn("Legacy TUI", "tui");
		phase("Chat, native v3/v2 PTY TUIs, and legacy-conversion TUI spawned");
		legacyFixtureSessionId = legacyTUI.id;
		const beforeQuit = sqliteRows(db);
		const chatBefore = beforeQuit.find((row) => row.id === chat.id)!;
		const modernBefore = beforeQuit.find((row) => row.id === modernTUI.id)!;
		const protocolV2Before = beforeQuit.find((row) => row.id === protocolV2TUI.id)!;
		const legacyBefore = beforeQuit.find((row) => row.id === legacyTUI.id)!;
		expect(chatBefore.session_mode).toBe("chat");
		expect(modernBefore.runtime_handle_id).toMatch(/^ptyhost-v1:/);
		expect(protocolV2Before.runtime_handle_id).toMatch(/^ptyhost-v1:/);
		const expectedChatActivity = chatBefore.activity_state;
		const expectedNativeActivity = modernBefore.activity_state;
		const expectedProtocolV2Activity = "active";
		const expectedLegacyActivity = "active";
		expect(expectedChatActivity).not.toBe("exited");
		expect(expectedNativeActivity).not.toBe("exited");
		const chatDescriptorPath = path.join(dataDir, "chat-hosts", chat.id, "host.json");
		const chatHostBefore = JSON.parse(await fs.readFile(chatDescriptorPath, "utf8")) as ChatHostDescriptor;
		await assertChatControllerAttached(chatHostBefore);

		await quitApp(first);
		await waitStopped(port);
		phase("initial app and daemon stopped cleanly");
		const afterGracefulQuit = sqliteRows(db);
		expect(afterGracefulQuit.find((row) => row.id === chat.id)!.activity_state).toBe(expectedChatActivity);
		expect(afterGracefulQuit.find((row) => row.id === modernTUI.id)!.activity_state).toBe(expectedNativeActivity);
		expect(afterGracefulQuit.find((row) => row.id === protocolV2TUI.id)!.activity_state).toBe(
			protocolV2Before.activity_state,
		);
		expect(afterGracefulQuit.find((row) => row.id === legacyTUI.id)!.activity_state).toBe(legacyBefore.activity_state);

		// Replace one modern host with a faithful shipped protocol-v2 process and
		// another with a pre-upgrade private-socket tmux pane. Both keep exact
		// supervisor generations and stale durable Exited facts. The current/default
		// tmux namespace gets a same-name foreign pane to prove ownership beats names.
		const registryPath = path.join(root, "windows-pty-hosts.json");
		const registry = JSON.parse(
			await fs.readFile(registryPath, "utf8"),
		) as PtyHostRegistryEntry[];
		const legacyHost = registry.find((entry) => entry.sessionId === legacyTUI.id);
		const protocolV2OriginalHost = registry.find((entry) => entry.sessionId === protocolV2TUI.id);
		if (!protocolV2OriginalHost) throw new Error("native PTY fixture was not durably registered");
		if (legacyHost) {
			await shutdownPtyHost(legacyHost, runFile, daemon);
		}
		await shutdownPtyHost(protocolV2OriginalHost, runFile, daemon);
		const survivingRegistry = registry.filter(
			(entry) => entry.sessionId !== legacyTUI.id && entry.sessionId !== protocolV2TUI.id,
		);

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
		execFileSync("sqlite3", [
			db,
			`UPDATE sessions SET activity_state='active', activity_last_at=${sqlQuote(activeAt)}, updated_at=${sqlQuote(activeAt)} WHERE id=${sqlQuote(protocolV2TUI.id)};`,
		]);
		execFileSync("sqlite3", [
			db,
			`UPDATE sessions SET activity_state='exited', activity_last_at=${sqlQuote(exitedAt)}, updated_at=${sqlQuote(exitedAt)} WHERE id=${sqlQuote(protocolV2TUI.id)};`,
		]);

		// Reproduce #4393's exact pane_start_command grammar. That release put
		// AO_* values in tmux's session environment, so none of them appeared as
		// shell exports here; only the quoted supervisor session+launch argv is
		// durable pane provenance.
		const launchCommand = [
			`cd ${shellQuote(legacyBefore.workspace_path)} || exit;`,
			"unset NO_COLOR;",
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
				"/bin/zsh",
				"-f",
			].map(shellQuote).join(" ") + ";",
			"exec cat >/dev/null",
		].join(" ");
		const socket = historicalTarget.address;
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
		const protocolV2Host = await launchPackagedProtocolV2PtyHost(
			daemon,
			protocolV2TUI.id,
			protocolV2Before.workspace_path,
			protocolV2Before.runtime_launch_id,
			env,
			logs,
			registryPath,
			survivingRegistry,
		);
		await assertPtyRegistryOwnership(registryPath, protocolV2Host.entry);
		await assertPtyHostRunning(protocolV2Host.entry, protocolV2Host.childPid);
		phase("historical private tmux, foreign collision, and packaged protocol-v2 PTY fixtures ready");

		const second = await launchApp(env, logs);
		apps.push(second);
		await waitReady(runFile, port, second.appRunId);
		phase("first cold restart ready");
		await waitFor(async () => (await second.renderer.hasVisibleExactText("Restart E2E")) || null, 30_000);
		await second.renderer.clickExactText("Restart E2E");
		for (const name of ["Chat Restart", "Native TUI", "Protocol v2 TUI", "Legacy TUI"]) {
			await waitFor(async () => (await second.renderer.hasVisibleExactText(name)) || null, 30_000);
		}
		expect(await exitedFrames(second)).toEqual([]);
		await second.renderer.screenshot(testInfo.outputPath("restart-two-ready.png"));

		const afterSecond = sqliteRows(db);
		const chatSecond = afterSecond.find((row) => row.id === chat.id)!;
		const modernSecond = afterSecond.find((row) => row.id === modernTUI.id)!;
		const protocolV2Second = afterSecond.find((row) => row.id === protocolV2TUI.id)!;
		const legacySecond = afterSecond.find((row) => row.id === legacyTUI.id)!;
		expect(chatSecond.activity_state).toBe(expectedChatActivity);
		expect(chatSecond.agent_session_id).toBe(chatBefore.agent_session_id);
		expect(chatSecond.controller_generation).not.toBe(chatBefore.controller_generation);
		expect(modernSecond.activity_state).toBe(expectedNativeActivity);
		expect(modernSecond.runtime_handle_id).toBe(modernBefore.runtime_handle_id);
		expect(protocolV2Second.activity_state).toBe(expectedProtocolV2Activity);
		expect(protocolV2Second.runtime_handle_id).toBe(protocolV2Before.runtime_handle_id);
		expect(protocolV2Second.runtime_launch_id).toBe(protocolV2Before.runtime_launch_id);
		expect(legacySecond.activity_state).toBe(expectedLegacyActivity);
		expect(legacySecond.runtime_launch_id).toBe(legacyLaunch);
		expect(legacySecond.runtime_handle_id).toMatch(/^tmux-v1:/);
		await execFileAsync(tmux, ["-L", "default", "has-session", "-t", `=${legacyTUI.id}`], { env });
		const chatHostSecond = JSON.parse(await fs.readFile(chatDescriptorPath, "utf8")) as ChatHostDescriptor;
		expect(chatHostSecond.pid).toBe(chatHostBefore.pid);
		await assertChatControllerAttached(chatHostSecond);
		await typeAndObserveNativeTerminal(second.renderer, root, "SECOND");
		await assertPtyRegistryOwnership(registryPath, protocolV2Host.entry);
		await assertPtyHostRunning(protocolV2Host.entry, protocolV2Host.childPid);
		await typeAndObserveNativeTerminal(second.renderer, root, "V2_SECOND", "Protocol v2 TUI");

		await second.renderer.clickSessionCard("Legacy TUI");
		await waitFor(async () => (await second.renderer.isTestIdVisible("session-detail")) || null, 30_000);
		await waitFor(async () => (await second.renderer.isTestIdVisible("session-terminal")) || null, 30_000);
		await waitFor(
			async () => ((await second.renderer.testIdCount("terminal-replay-cover")) === 0) || null,
			30_000,
		);
		const secondAttachMarker = path.join(root, "second-legacy-attach.ok");
		await second.renderer.focusWithinTestId("session-terminal", ".xterm-helper-textarea");
		// XtermTerminal deliberately forwards onKey rather than raw input events so
		// terminal-generated protocol replies cannot corrupt the agent PTY. Exercise
		// the same keyboard path a user does; insertText() would bypass onKey.
		await second.renderer.type(`printf attached > ${shellQuote(secondAttachMarker)}`);
		await second.renderer.press("Enter");
		await waitFor(async () => {
			try {
				return (await fs.readFile(secondAttachMarker, "utf8")) === "attached" ? true : null;
			} catch {
				return null;
			}
		}, 30_000);
		// Observe through at least one periodic reaper interval, then read the
		// preload-owned frame ledger again immediately before shutdown.
		await new Promise((resolve) => setTimeout(resolve, 6_000));
		expect(await exitedFrames(second)).toEqual([]);
		phase("first cold restart continuity verified through reaper interval");

		await quitApp(second);
		await waitStopped(port);

		const third = await launchApp(env, logs);
		apps.push(third);
		await waitReady(runFile, port, third.appRunId);
		phase("second cold restart ready");
		await waitFor(async () => (await third.renderer.hasVisibleExactText("Restart E2E")) || null, 30_000);
		await third.renderer.clickExactText("Restart E2E");
		await waitFor(async () => (await third.renderer.hasVisibleExactText("Legacy TUI")) || null, 30_000);
		expect(await exitedFrames(third)).toEqual([]);
		const afterThird = sqliteRows(db);
		const chatThird = afterThird.find((row) => row.id === chat.id)!;
		const modernThird = afterThird.find((row) => row.id === modernTUI.id)!;
		const protocolV2Third = afterThird.find((row) => row.id === protocolV2TUI.id)!;
		const legacyThird = afterThird.find((row) => row.id === legacyTUI.id)!;
		expect(chatThird.activity_state).toBe(expectedChatActivity);
		expect(chatThird.controller_generation).not.toBe(chatSecond.controller_generation);
		expect(modernThird.activity_state).toBe(expectedNativeActivity);
		expect(modernThird.runtime_handle_id).toBe(modernSecond.runtime_handle_id);
		expect(protocolV2Third.activity_state).toBe(expectedProtocolV2Activity);
		expect(protocolV2Third.runtime_handle_id).toBe(protocolV2Second.runtime_handle_id);
		expect(protocolV2Third.runtime_launch_id).toBe(protocolV2Second.runtime_launch_id);
		expect(legacyThird.runtime_handle_id).toBe(legacySecond.runtime_handle_id);
		expect(legacyThird.activity_state).toBe(expectedLegacyActivity);
		const chatHostThird = JSON.parse(await fs.readFile(chatDescriptorPath, "utf8")) as ChatHostDescriptor;
		expect(chatHostThird.pid).toBe(chatHostBefore.pid);
		await assertChatControllerAttached(chatHostThird);
		await typeAndObserveNativeTerminal(third.renderer, root, "THIRD");
		await assertPtyRegistryOwnership(registryPath, protocolV2Host.entry);
		await assertPtyHostRunning(protocolV2Host.entry, protocolV2Host.childPid);
		await typeAndObserveNativeTerminal(third.renderer, root, "V2_THIRD", "Protocol v2 TUI");
		await third.renderer.clickSessionCard("Legacy TUI");
		await waitFor(async () => (await third.renderer.isTestIdVisible("session-terminal")) || null, 30_000);
		await waitFor(
			async () => ((await third.renderer.testIdCount("terminal-replay-cover")) === 0) || null,
			30_000,
		);
		const thirdAttachMarker = path.join(root, "third-legacy-attach.ok");
		await third.renderer.focusWithinTestId("session-terminal", ".xterm-helper-textarea");
		await third.renderer.type(`printf attached > ${shellQuote(thirdAttachMarker)}`);
		await third.renderer.press("Enter");
		await waitFor(async () => {
			try {
				return (await fs.readFile(thirdAttachMarker, "utf8")) === "attached" ? true : null;
			} catch {
				return null;
			}
		}, 30_000);
		await new Promise((resolve) => setTimeout(resolve, 6_000));
		expect(await exitedFrames(third)).toEqual([]);
		phase("second cold restart continuity verified through reaper interval");

		// Exercise the production relaunch path too. Each Electron launch rotates
		// AO_APP_RUN_ID and the memory-only browser-runtime credential, so the new app
		// must replace (not reuse) the prior daemon, then recover the same workloads
		// without exposing a stale Exited frame.
		const daemonBeforeHandoff = await readRunFile(runFile);
		expect(daemonBeforeHandoff).not.toBeNull();
		await quitApp(third);
		const fourth = await launchApp(env, logs);
		apps.push(fourth);
		const daemonAfterHandoff = await waitReady(runFile, port, fourth.appRunId);
		expect(daemonAfterHandoff.pid).not.toBe(daemonBeforeHandoff!.pid);
		await waitFor(async () => (await fourth.renderer.hasVisibleExactText("Restart E2E")) || null, 30_000);
		await fourth.renderer.clickExactText("Restart E2E");
		for (const name of ["Chat Restart", "Native TUI", "Protocol v2 TUI", "Legacy TUI"]) {
			await waitFor(async () => (await fourth.renderer.hasVisibleExactText(name)) || null, 30_000);
		}
		await new Promise((resolve) => setTimeout(resolve, 6_000));
		expect((await readRunFile(runFile))?.pid).toBe(daemonAfterHandoff.pid);
		expect(await exitedFrames(fourth)).toEqual([]);
		const afterFourth = sqliteRows(db);
		const chatFourth = afterFourth.find((row) => row.id === chat.id)!;
		const modernFourth = afterFourth.find((row) => row.id === modernTUI.id)!;
		const protocolV2Fourth = afterFourth.find((row) => row.id === protocolV2TUI.id)!;
		const legacyFourth = afterFourth.find((row) => row.id === legacyTUI.id)!;
		expect(chatFourth.activity_state).toBe(expectedChatActivity);
		expect(chatFourth.controller_generation).not.toBe(chatThird.controller_generation);
		expect(chatFourth.agent_session_id).toBe(chatThird.agent_session_id);
		expect(modernFourth.activity_state).toBe(expectedNativeActivity);
		expect(modernFourth.runtime_handle_id).toBe(modernThird.runtime_handle_id);
		expect(protocolV2Fourth.activity_state).toBe(expectedProtocolV2Activity);
		expect(protocolV2Fourth.runtime_handle_id).toBe(protocolV2Third.runtime_handle_id);
		expect(protocolV2Fourth.runtime_launch_id).toBe(protocolV2Third.runtime_launch_id);
		expect(legacyFourth.activity_state).toBe(expectedLegacyActivity);
		expect(legacyFourth.runtime_handle_id).toBe(legacyThird.runtime_handle_id);
		const chatHostFourth = JSON.parse(await fs.readFile(chatDescriptorPath, "utf8")) as ChatHostDescriptor;
		expect(chatHostFourth.pid).toBe(chatHostBefore.pid);
		await assertChatControllerAttached(chatHostFourth);
		await assertPtyRegistryOwnership(registryPath, protocolV2Host.entry);
		await assertPtyHostRunning(protocolV2Host.entry, protocolV2Host.childPid);
		phase("immediate app handoff safely replaced the daemon and recovered every workload");

		await quitApp(fourth);
		await waitStopped(port);

		// Negative control: a bare legacy handle with two exact AO-owned workloads
		// is genuinely ambiguous. Startup must stay unready, keep the board covered,
		// and leave both workloads and the durable row untouched.
		expect(
			await stopFixtureTmuxSession(tmux, ["-L", "default"], legacyTUI.id, env, logs, "foreign"),
		).toBe(true);
		foreignCreated = false;
		const duplicateLaunchCommand = [
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
				"/bin/zsh",
				"-f",
			].map(shellQuote).join(" ") + ";",
			"exec cat >/dev/null",
		].join(" ");
		await execFileAsync(
			tmux,
			[
				"-L", "default", "new-session", "-d", "-s", legacyTUI.id,
				"-x", "220", "-y", "50", "-c", legacyBefore.workspace_path,
				"/bin/zsh", "-c", duplicateLaunchCommand,
			],
			{ env },
		);
		foreignCreated = true;
		execFileSync("sqlite3", [
			db,
			`UPDATE sessions SET activity_state='active', runtime_handle_id=${sqlQuote(legacyTUI.id)} WHERE id=${sqlQuote(legacyTUI.id)};`,
		]);
		const ambiguousBefore = sqliteRows(db).find((row) => row.id === legacyTUI.id)!;

		const fifth = await launchApp(env, logs);
		apps.push(fifth);
		await waitStartupRecoveryFailure(runFile, port, fifth.appRunId);
		await waitFor(
			async () => (await fifth.renderer.hasVisibleExactText("startup_recovery_failed")) || null,
			30_000,
		);
		await waitFor(async () => (await fifth.renderer.isTestIdVisible("daemon-startup-loader")) || null, 30_000);
		const recoveryLayers = await fifth.renderer.startupRecoveryLayers();
		expect(recoveryLayers).not.toBeNull();
		expect(recoveryLayers!.cover).toBeGreaterThan(recoveryLayers!.overlay);
		expect(recoveryLayers!.banner).toBeGreaterThan(recoveryLayers!.cover);
		const gatedSessions = await fetch(`http://127.0.0.1:${port}/api/v1/sessions`);
		expect(gatedSessions.status).toBe(503);
		expect(await gatedSessions.text()).toContain("startup_recovery_failed");
		expect(await fifth.renderer.visibleExactTextCount("Legacy TUI")).toBe(0);
		expect(await exitedFrames(fifth)).toEqual([]);
		const ambiguousAfter = sqliteRows(db).find((row) => row.id === legacyTUI.id)!;
		expect({
			activity: ambiguousAfter.activity_state,
			handle: ambiguousAfter.runtime_handle_id,
			launch: ambiguousAfter.runtime_launch_id,
		}).toEqual({
			activity: ambiguousBefore.activity_state,
			handle: ambiguousBefore.runtime_handle_id,
			launch: ambiguousBefore.runtime_launch_id,
		});
		expect(await tmuxSessionNames(tmux, ["-L", "default"], env)).toContain(legacyTUI.id);
		expect(await tmuxSessionNames(tmux, ["-S", historicalTarget.address], env)).toContain(legacyTUI.id);
		phase("ambiguous ownership failed closed without exposing or mutating the board");
		await quitApp(fifth);
		await waitStopped(port);
		scenarioCompleted = true;
	} finally {
		let cleanupFailure: Error | undefined;
		for (const app of apps.reverse()) await quitApp(app).catch(() => undefined);
		const daemonClean = await stopFixtureDaemon(runFile, logs);
		const hostsClean = await cleanupDetachedHosts(root, dataDir, runFile, daemon, logs);
		const foreignTmuxClean =
			!foreignCreated || !legacyFixtureSessionId
				? true
				: await stopFixtureTmuxSession(tmux, ["-L", "default"], legacyFixtureSessionId, env, logs, "foreign");
		const historicalTmuxClean = !legacyFixtureSessionId
			? true
			: await stopFixtureTmuxSession(
					tmux,
					["-S", historicalTarget.address],
					legacyFixtureSessionId,
					env,
					logs,
					"historical private-socket",
				);
		let credentialClean = true;
		try {
			// Never preserve a copied login token with a failed fixture. The isolated
			// processes have already been stopped or positively refused above.
			await fs.rm(codexAuth, { force: true });
		} catch (error) {
			credentialClean = false;
			logs.push(`[cleanup] could not remove isolated Codex auth: ${String(error)}`);
		}
		let aliasClean = historicalTarget.aliasDir === undefined;
		if (historicalTarget.aliasDir && historicalTmuxClean) {
			try {
				await fs.rm(historicalTarget.aliasDir, { force: true });
				aliasClean = true;
			} catch (error) {
				logs.push(`[cleanup] could not remove historical tmux alias: ${String(error)}`);
			}
		}
		if (daemonClean && hostsClean && foreignTmuxClean && historicalTmuxClean && credentialClean && aliasClean) {
			try {
				await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			} catch (error) {
				logs.push(`[cleanup] remove ${root}: ${String(error)}`);
				if (scenarioCompleted) cleanupFailure = error instanceof Error ? error : new Error(String(error));
			}
		} else {
			logs.push(`[cleanup] preserved isolated fixture root ${root}: one or more fixture owners could not be proven stopped`);
			if (scenarioCompleted) {
				cleanupFailure = new Error(`fixture cleanup could not prove all owners stopped; preserved ${root}`);
			}
		}
		await testInfo.attach("native-app-logs", { body: logs.join("\n"), contentType: "text/plain" });
		if (cleanupFailure) throw cleanupFailure;
	}
});
