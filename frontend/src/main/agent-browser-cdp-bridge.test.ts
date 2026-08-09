import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
	AgentBrowserCDPBridge,
	type AgentBrowserDebugger,
	type AgentBrowserTarget,
} from "./agent-browser-cdp-bridge";

class FakeDebugger extends EventEmitter implements AgentBrowserDebugger {
	attached = false;
	readonly sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>, sessionId?: string) => ({
		method,
		params,
		...(sessionId ? { sessionId } : {}),
	}));

	attach(): void {
		this.attached = true;
	}

	detach(): void {
		this.attached = false;
		this.emit("detach");
	}

	isAttached(): boolean {
		return this.attached;
	}
}

describe("worker-scoped agent-browser CDP bridge", () => {
	it("exposes only provider targets and forwards flattened target commands", async () => {
		const debug = new FakeDebugger();
		const targets: AgentBrowserTarget[] = [
			{ id: "t1", url: "http://localhost:5173/", title: "AO fixture", debugger: debug },
		];
		const provider = {
			listTargets: () => targets,
			createTarget: vi.fn(async () => targets[0]),
			activateTarget: vi.fn(),
			closeTarget: vi.fn(),
		};
		const bridge = new AgentBrowserCDPBridge(provider);
		const endpoint = await bridge.start();
		const socket = await connect(endpoint);

		try {
			const listed = await rpc(socket, 1, "Target.getTargets");
			expect(listed.result).toEqual({
				targetInfos: [
					expect.objectContaining({
						targetId: "t1",
						type: "page",
						url: "http://localhost:5173/",
					}),
				],
			});

			const attached = await rpc(socket, 2, "Target.attachToTarget", { targetId: "t1", flatten: true });
			const sessionId = (attached.result as { sessionId: string }).sessionId;
			expect(sessionId).toMatch(/^ao-/);

			const forwarded = await rpc(socket, 3, "Runtime.evaluate", { expression: "document.title" }, sessionId);
			expect(forwarded.result).toEqual({
				method: "Runtime.evaluate",
				params: { expression: "document.title" },
			});
			expect(debug.sendCommand).toHaveBeenCalledWith("Runtime.evaluate", {
				expression: "document.title",
			});
			const blockedNavigation = await rpc(
				socket,
				31,
				"Page.navigate",
				{ url: "file:///tmp/outside-policy" },
				sessionId,
			);
			expect(blockedNavigation.error?.message).toContain("Navigation scheme is not permitted");

			const sibling = await rpc(socket, 4, "Target.attachToTarget", { targetId: "other-worker" });
			expect(sibling.error?.message).toContain("outside this AO worker");

			const close = await rpc(socket, 5, "Browser.close");
			expect(close.error?.message).toContain("not permitted");
		} finally {
			socket.close();
			await bridge.close();
		}
	});

	it("keeps one physical debugger attached while restricted clients share a target", async () => {
		const debug = new FakeDebugger();
		const targets: AgentBrowserTarget[] = [
			{ id: "t1", url: "http://localhost:5173/", title: "AO fixture", debugger: debug },
		];
		const provider = {
			listTargets: () => targets,
			createTarget: vi.fn(async () => targets[0]),
			activateTarget: vi.fn(),
			closeTarget: vi.fn(),
		};
		const bridge = new AgentBrowserCDPBridge(provider);
		const endpoint = await bridge.start();
		const agentSocket = await connect(endpoint);
		const siblingSocket = await connect(endpoint);

		try {
			const agentAttach = await rpc(agentSocket, 1, "Target.attachToTarget", { targetId: "t1", flatten: true });
			const siblingAttach = await rpc(siblingSocket, 2, "Target.attachToTarget", { targetId: "t1", flatten: true });
			const agentSession = (agentAttach.result as { sessionId: string }).sessionId;
			const siblingSession = (siblingAttach.result as { sessionId: string }).sessionId;
			expect(agentSession).toMatch(/^ao-/);
			expect(siblingSession).toMatch(/^ao-/);
			expect(debug.attached).toBe(true);
			await expectRPCResult(agentSocket, 3, "Runtime.enable", {}, agentSession);
			await expectRPCResult(siblingSocket, 4, "Runtime.enable", {}, siblingSession);

			agentSocket.close();
			await waitFor(() => expect(debug.attached).toBe(true));
			await expectRPCResult(siblingSocket, 5, "Runtime.enable", {}, siblingSession);

			siblingSocket.close();
			await waitFor(() => expect(debug.attached).toBe(false));
		} finally {
			siblingSocket.close();
			agentSocket.close();
			await bridge.close();
		}
	});

	it("routes flattened cross-origin iframe sessions only through their owning target connection", async () => {
		const firstDebug = new FakeDebugger();
		const secondDebug = new FakeDebugger();
		const targets: AgentBrowserTarget[] = [
			{ id: "t1", url: "https://first.example/", title: "First", debugger: firstDebug },
			{ id: "t2", url: "https://second.example/", title: "Second", debugger: secondDebug },
		];
		const bridge = new AgentBrowserCDPBridge({
			listTargets: () => targets,
			createTarget: vi.fn(async () => targets[0]),
			activateTarget: vi.fn(),
			closeTarget: vi.fn(),
		});
		const endpoint = await bridge.start();
		const owner = await connect(endpoint);
		const sibling = await connect(endpoint);

		try {
			const ownerAttach = await rpc(owner, 1, "Target.attachToTarget", { targetId: "t1", flatten: true });
			const ownerSessionId = (ownerAttach.result as { sessionId: string }).sessionId;
			await rpc(sibling, 2, "Target.attachToTarget", { targetId: "t2", flatten: true });

			const attachedEvent = nextCDPEvent(owner, "Target.attachedToTarget");
			firstDebug.emit(
				"message",
				{},
				"Target.attachedToTarget",
				{
					sessionId: "chromium-oopif-session",
					targetInfo: { targetId: "oopif-1", type: "iframe", url: "https://cross-origin.example/" },
					waitingForDebugger: false,
				},
			);
			expect(await attachedEvent).toMatchObject({ sessionId: ownerSessionId });

			const childEvent = nextCDPEvent(owner, "Runtime.executionContextCreated");
			firstDebug.emit(
				"message",
				{},
				"Runtime.executionContextCreated",
				{ context: { id: 7 } },
				"chromium-oopif-session",
			);
			expect(await childEvent).toMatchObject({ sessionId: "chromium-oopif-session" });

			const childCommand = await rpc(
				owner,
				3,
				"Runtime.evaluate",
				{ expression: "document.title" },
				"chromium-oopif-session",
			);
			expect(childCommand.error).toBeUndefined();
			expect(firstDebug.sendCommand).toHaveBeenCalledWith(
				"Runtime.evaluate",
				{ expression: "document.title" },
				"chromium-oopif-session",
			);

			const crossTab = await rpc(sibling, 4, "Runtime.enable", {}, "chromium-oopif-session");
			expect(crossTab.error?.message).toContain("Unknown or expired target session");

			const detachedEvent = nextCDPEvent(owner, "Target.detachedFromTarget");
			firstDebug.emit(
				"message",
				{},
				"Target.detachedFromTarget",
				{ sessionId: "chromium-oopif-session", targetId: "oopif-1" },
			);
			await detachedEvent;
			const expired = await rpc(owner, 5, "Runtime.enable", {}, "chromium-oopif-session");
			expect(expired.error?.message).toContain("Unknown or expired target session");
		} finally {
			owner.close();
			sibling.close();
			await bridge.close();
		}
	});

	it("does not elevate an agent connection through forged query parameters", async () => {
		const debug = new FakeDebugger();
		const target: AgentBrowserTarget = {
			id: "t1",
			url: "http://localhost:5173/",
			title: "AO fixture",
			debugger: debug,
		};
		const bridge = new AgentBrowserCDPBridge({
			listTargets: () => [target],
			createTarget: vi.fn(async () => target),
			activateTarget: vi.fn(),
			closeTarget: vi.fn(),
		});
		const endpoint = await bridge.start();
		const forged = await connect(`${endpoint}?target=t1&client=devtools`);

		try {
			const attached = await rpc(forged, 1, "Target.attachToTarget", { targetId: "t1", flatten: true });
			const sessionId = (attached.result as { sessionId: string }).sessionId;
			const blocked = await rpc(forged, 2, "Page.navigate", { url: "file:///tmp/forged" }, sessionId);
			expect(blocked.error?.message).toContain("Navigation scheme is not permitted");
		} finally {
			forged.close();
			await bridge.close();
		}
	});

	it("does not serialize independent target protocol requests", async () => {
		const debug = new FakeDebugger();
		let releaseSlow: (() => void) | undefined;
		debug.sendCommand.mockImplementation((method: string) => {
			if (method !== "Runtime.enable") return Promise.resolve({ method, params: undefined });
			return new Promise((resolve) => {
				releaseSlow = () => resolve({ method, params: undefined });
			});
		});
		const target: AgentBrowserTarget = {
			id: "t1",
			url: "http://localhost:5173/",
			title: "AO fixture",
			debugger: debug,
		};
		const bridge = new AgentBrowserCDPBridge({
			listTargets: () => [target],
			createTarget: vi.fn(async () => target),
			activateTarget: vi.fn(),
			closeTarget: vi.fn(),
		});
		const endpoint = await bridge.start();
		const socket = await connect(endpoint);

		try {
			const attached = await rpc(socket, 1, "Target.attachToTarget", { targetId: "t1", flatten: true });
			const sessionId = (attached.result as { sessionId: string }).sessionId;
			const slow = rpc(socket, 2, "Runtime.enable", {}, sessionId);
			const fast = rpc(socket, 3, "Page.enable", {}, sessionId);
			await expect(
				Promise.race([
					fast,
					new Promise((_, reject) => setTimeout(() => reject(new Error("fast CDP request was serialized")), 500)),
				]),
			).resolves.toMatchObject({ id: 3, result: { method: "Page.enable" } });
			releaseSlow?.();
			await expect(slow).resolves.toMatchObject({ id: 2 });
		} finally {
			releaseSlow?.();
			socket.close();
			await bridge.close();
		}
	});
});

type RPCResponse = {
	id: number;
	result?: unknown;
	error?: { message: string };
};

type CDPEvent = {
	method: string;
	params?: Record<string, unknown>;
	sessionId?: string;
};

async function connect(endpoint: string): Promise<WebSocket> {
	const socket = new WebSocket(endpoint);
	await new Promise<void>((resolve, reject) => {
		socket.once("open", resolve);
		socket.once("error", reject);
	});
	return socket;
}

async function rpc(
	socket: WebSocket,
	id: number,
	method: string,
	params?: Record<string, unknown>,
	sessionId?: string,
): Promise<RPCResponse> {
	const response = new Promise<RPCResponse>((resolve) => {
		const listener = (data: Buffer) => {
			const message = JSON.parse(data.toString()) as RPCResponse;
			if (message.id !== id) return;
			socket.off("message", listener);
			resolve(message);
		};
		socket.on("message", listener);
	});
	socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
	return response;
}

function nextCDPEvent(socket: WebSocket, method: string): Promise<CDPEvent> {
	return new Promise((resolve) => {
		const listener = (data: Buffer) => {
			const message = JSON.parse(data.toString()) as CDPEvent;
			if (message.method !== method) return;
			socket.off("message", listener);
			resolve(message);
		};
		socket.on("message", listener);
	});
}

async function expectRPCResult(
	socket: WebSocket,
	id: number,
	method: string,
	params: Record<string, unknown>,
	sessionId?: string,
	expectError = false,
): Promise<void> {
	const response = await rpc(socket, id, method, params, sessionId);
	if (expectError) expect(response.error).toBeDefined();
	else expect(response.error).toBeUndefined();
}

async function waitFor(assertion: () => void): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		try {
			assertion();
			return;
		} catch (error) {
			if (attempt === 49) throw error;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}
