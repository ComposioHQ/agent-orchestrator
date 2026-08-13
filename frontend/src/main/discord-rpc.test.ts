import { describe, it, expect } from "vitest";
import { buildActivityPayload, pickRepresentativeStatus } from "./discord-rpc";

describe("buildActivityPayload", () => {
	it("returns idle with 0 agents when no sessions", () => {
		const result = buildActivityPayload([], []);
		expect(result).not.toBeNull();
		expect(result!.details).toBe("Orchestrating 0 agents");
		expect(result!.state).toBe("Idle");
	});

	it("returns idle with 0 agents when all sessions are terminated", () => {
		const result = buildActivityPayload(
			[{ status: "terminated", isTerminated: true, createdAt: "2026-01-01T00:00:00Z" }],
			[],
		);
		expect(result).not.toBeNull();
		expect(result!.details).toBe("Orchestrating 0 agents");
		expect(result!.state).toBe("Idle");
	});

	it("returns idle with 0 agents when all sessions are exited", () => {
		const result = buildActivityPayload(
			[{ status: "exited", isTerminated: true, createdAt: "2026-01-01T00:00:00Z" }],
			[],
		);
		expect(result).not.toBeNull();
		expect(result!.details).toBe("Orchestrating 0 agents");
		expect(result!.state).toBe("Idle");
	});

	it("returns idle with 0 agents when all sessions are merged", () => {
		const result = buildActivityPayload(
			[{ status: "merged", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
			[],
		);
		expect(result).not.toBeNull();
		expect(result!.details).toBe("Orchestrating 0 agents");
		expect(result!.state).toBe("Idle");
	});

	it("returns 'Working' for a single working session", () => {
		const result = buildActivityPayload(
			[{ status: "working", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
			[],
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
			[],
		);
		expect(result!.details).toBe("Orchestrating 2 agents");
	});

	it("prioritizes needs_input over working", () => {
		const result = buildActivityPayload(
			[
				{ status: "working", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" },
				{ status: "needs_input", isTerminated: false, createdAt: "2026-01-01T00:00:01Z" },
			],
			[],
		);
		expect(result!.state).toBe("Waiting on you");
	});

	it("prioritizes ci_failed over working", () => {
		const result = buildActivityPayload(
			[
				{ status: "working", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" },
				{ status: "ci_failed", isTerminated: false, createdAt: "2026-01-01T00:00:01Z" },
			],
			[],
		);
		expect(result!.state).toBe("Fixing CI");
	});

	it("prioritizes changes_requested over review_pending", () => {
		const result = buildActivityPayload(
			[
				{ status: "review_pending", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" },
				{ status: "changes_requested", isTerminated: false, createdAt: "2026-01-01T00:00:01Z" },
			],
			[],
		);
		expect(result!.state).toBe("Addressing review");
	});

	it("maps review_pending to 'In review'", () => {
		const result = buildActivityPayload(
			[{ status: "review_pending", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
			[],
		);
		expect(result!.state).toBe("In review");
	});

	it("maps pr_open to 'In review'", () => {
		const result = buildActivityPayload(
			[{ status: "pr_open", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
			[],
		);
		expect(result!.state).toBe("In review");
	});

	it("maps mergeable to 'Ready to merge'", () => {
		const result = buildActivityPayload(
			[{ status: "mergeable", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
			[],
		);
		expect(result!.state).toBe("Ready to merge");
	});

	it("maps approved to 'Ready to merge'", () => {
		const result = buildActivityPayload(
			[{ status: "approved", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
			[],
		);
		expect(result!.state).toBe("Ready to merge");
	});

	it("maps draft to 'Drafting PR'", () => {
		const result = buildActivityPayload(
			[{ status: "draft", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
			[],
		);
		expect(result!.state).toBe("Drafting PR");
	});

	it("maps idle to 'Idle'", () => {
		const result = buildActivityPayload(
			[{ status: "idle", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
			[],
		);
		expect(result!.state).toBe("Idle");
	});

	it("maps no_signal to 'Idle'", () => {
		const result = buildActivityPayload(
			[{ status: "no_signal", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
			[],
		);
		expect(result!.state).toBe("Idle");
	});

	it("excludes terminated sessions from count", () => {
		const result = buildActivityPayload(
			[
				{ status: "working", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" },
				{ status: "terminated", isTerminated: true, createdAt: "2026-01-01T00:00:01Z" },
			],
			[],
		);
		expect(result!.details).toBe("Orchestrating 1 agent");
	});

	it("includes button when project has HTTP repo URL", () => {
		const result = buildActivityPayload(
			[{ status: "working", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
			[{ repo: "https://github.com/example/repo.git" }],
		);
		expect(result!.buttons).toEqual([{ label: "View on GitHub", url: "https://github.com/example/repo.git" }]);
	});

	it("omits button when project repo is empty", () => {
		const result = buildActivityPayload(
			[{ status: "working", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
			[{ repo: "" }],
		);
		expect(result!.buttons).toBeUndefined();
	});

	it("omits button when project has no repo field", () => {
		const result = buildActivityPayload(
			[{ status: "working", isTerminated: false, createdAt: "2026-01-01T00:00:00Z" }],
			[{}],
		);
		expect(result!.buttons).toBeUndefined();
	});

	it("uses provided start time as activity start timestamp", () => {
		const startTime = Date.parse("2026-01-01T06:00:00Z");
		const result = buildActivityPayload(
			[
				{ status: "working", isTerminated: false },
				{ status: "working", isTerminated: false },
				{ status: "working", isTerminated: false },
			],
			[],
			startTime,
		);
		expect(result!.startTimestamp).toBe(startTime);
	});

	it("start timestamp stays constant regardless of session createdAt", () => {
		const startTime = Date.parse("2026-01-01T00:00:00Z");
		const result = buildActivityPayload(
			[{ status: "idle", isTerminated: false, createdAt: "2026-01-02T00:00:00Z" }],
			[],
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
