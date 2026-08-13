import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildActivityPayload, pickRepresentativeStatus, startDiscordRpc, disposeDiscordRpc, getRpcStatus } from "./discord-rpc";

vi.mock("@xhayper/discord-rpc", () => {
	class FakeClient {
		async login() {}
		async destroy() {}
		async request() {}
	}
	return { Client: FakeClient };
});

describe("buildActivityPayload", () => {
	it("returns idle with 0 agents when no sessions", () => {
		const result = buildActivityPayload([]);
		expect(result).not.toBeNull();
		expect(result!.details).toBe("Orchestrating 0 agents");
		expect(result!.state).toBe("Idle");
	});

	it("returns idle with 0 agents when all sessions are terminated", () => {
		const result = buildActivityPayload(
			[{ status: "terminated", isTerminated: true, createdAt: "2026-01-01T00:00:00Z" }],
		);
		expect(result).not.toBeNull();
		expect(result!.details).toBe("Orchestrating 0 agents");
		expect(result!.state).toBe("Idle");
	});

	it("returns idle with 0 agents when all sessions are exited", () => {
		const result = buildActivityPayload(
			[{ status: "exited", isTerminated: true, createdAt: "2026-01-01T00:00:00Z" }],
		);
		expect(result).not.toBeNull();
		expect(result!.details).toBe("Orchestrating 0 agents");
		expect(result!.state).toBe("Idle");
	});

	it("returns idle with 0 agents when all sessions are merged", () => {
		const result = buildActivityPayload(
			[{ status: "merged", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
		);
		expect(result).not.toBeNull();
		expect(result!.details).toBe("Orchestrating 0 agents");
		expect(result!.state).toBe("Idle");
	});

	it("returns 'Working' for a single working session", () => {
		const result = buildActivityPayload(
			[{ status: "working", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
		);
		expect(result).not.toBeNull();
		expect(result!.details).toBe("Orchestrating 1 agent");
		expect(result!.state).toBe("Working");
	});

	it("returns plural 'agents' for multiple sessions", () => {
		const result = buildActivityPayload(
			[
				{ status: "working", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" },
				{ status: "working", isTerminated: false, createdAt: "2026-01-01T00:00:01Z" },
			],
		);
		expect(result!.details).toBe("Orchestrating 2 agents");
	});

	it("prioritizes needs_input over working", () => {
		const result = buildActivityPayload(
			[
				{ status: "working", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" },
				{ status: "needs_input", isTerminated: false, createdAt: "2026-01-01T00:00:01Z" },
			],
		);
		expect(result!.state).toBe("Waiting on you");
	});

	it("prioritizes ci_failed over working", () => {
		const result = buildActivityPayload(
			[
				{ status: "working", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" },
				{ status: "ci_failed", isTerminated: false, createdAt: "2026-01-01T00:00:01Z" },
			],
		);
		expect(result!.state).toBe("Fixing CI");
	});

	it("prioritizes changes_requested over review_pending", () => {
		const result = buildActivityPayload(
			[
				{ status: "review_pending", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" },
				{ status: "changes_requested", isTerminated: false, createdAt: "2026-01-01T00:00:01Z" },
			],
		);
		expect(result!.state).toBe("Addressing review");
	});

	it("maps review_pending to 'In review'", () => {
		const result = buildActivityPayload(
			[{ status: "review_pending", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
		);
		expect(result!.state).toBe("In review");
	});

	it("maps pr_open to 'In review'", () => {
		const result = buildActivityPayload(
			[{ status: "pr_open", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
		);
		expect(result!.state).toBe("In review");
	});

	it("maps mergeable to 'Ready to merge'", () => {
		const result = buildActivityPayload(
			[{ status: "mergeable", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
		);
		expect(result!.state).toBe("Ready to merge");
	});

	it("maps approved to 'Ready to merge'", () => {
		const result = buildActivityPayload(
			[{ status: "approved", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
		);
		expect(result!.state).toBe("Ready to merge");
	});

	it("maps draft to 'Drafting PR'", () => {
		const result = buildActivityPayload(
			[{ status: "draft", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
		);
		expect(result!.state).toBe("Drafting PR");
	});

	it("maps idle to 'Idle'", () => {
		const result = buildActivityPayload(
			[{ status: "idle", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
		);
		expect(result!.state).toBe("Idle");
	});

	it("maps no_signal to 'Idle'", () => {
		const result = buildActivityPayload(
			[{ status: "no_signal", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
		);
		expect(result!.state).toBe("Idle");
	});

	it("excludes terminated sessions from count", () => {
		const result = buildActivityPayload(
			[
				{ status: "working", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" },
				{ status: "terminated", isTerminated: true, createdAt: "2026-01-01T00:00:01Z" },
			],
		);
		expect(result!.details).toBe("Orchestrating 1 agent");
	});

	it("uses provided start time as activity start timestamp", () => {
		const startTime = Date.parse("2026-01-01T06:00:00Z");
		const result = buildActivityPayload(
			[
				{ status: "working", isTerminated: false },
				{ status: "working", isTerminated: false },
				{ status: "working", isTerminated: false },
			],
			startTime,
		);
		expect(result!.startTimestamp).toBe(startTime);
	});

	it("start timestamp stays constant regardless of session createdAt", () => {
		const startTime = Date.parse("2026-01-01T00:00:00Z");
		const result = buildActivityPayload(
			[{ status: "idle", isTerminated: false, createdAt: "2026-01-02T00:00:00Z" }],
			startTime,
		);
		expect(result!.startTimestamp).toBe(startTime);
	});
});

describe("pickRepresentativeStatus", () => {
	it("returns idle with 0 count for empty array", () => {
		const result = pickRepresentativeStatus([]);
		expect(result!.label).toBe("Idle");
		expect(result!.count).toBe(0);
	});

	it("returns idle with 0 count when all excluded", () => {
		const result = pickRepresentativeStatus([
			{ status: "terminated", isTerminated: true },
			{ status: "exited", isTerminated: true },
			{ status: "merged", isTerminated: false },
		]);
		expect(result!.label).toBe("Idle");
		expect(result!.count).toBe(0);
	});

	it("picks highest priority across mixed statuses", () => {
		const result = pickRepresentativeStatus([
			{ status: "working", isTerminated: false },
			{ status: "idle", isTerminated: false },
			{ status: "needs_input", isTerminated: false },
			{ status: "pr_open", isTerminated: false },
		]);
		expect(result!.label).toBe("Waiting on you");
		expect(result!.count).toBe(4);
	});
});

describe("startDiscordRpc lifecycle", () => {
	beforeEach(async () => {
		await disposeDiscordRpc();
	});

	afterEach(async () => {
		await disposeDiscordRpc();
	});

	it("sets connectionState to connected after successful start", async () => {
		await startDiscordRpc();
		expect(getRpcStatus().state).toBe("connected");
	});

	it("sets disconnected and nulls client when login fails", async () => {
		const discordRpc = await import("@xhayper/discord-rpc");
		vi.spyOn(discordRpc.Client.prototype, "login").mockRejectedValue(new Error("Discord not running"));
		await startDiscordRpc();
		expect(getRpcStatus().state).toBe("disconnected");
	});

	it("reconnects after a failed login when startDiscordRpc is called again", async () => {
		const discordRpc = await import("@xhayper/discord-rpc");
		const loginSpy = vi.spyOn(discordRpc.Client.prototype, "login");
		loginSpy.mockRejectedValueOnce(new Error("Discord not running"));
		await startDiscordRpc();
		expect(getRpcStatus().state).toBe("disconnected");

		loginSpy.mockResolvedValueOnce(undefined);
		await startDiscordRpc();
		expect(getRpcStatus().state).toBe("connected");
	});
});
