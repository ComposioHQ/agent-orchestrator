import { describe, expect, it } from "vitest";
import { SESSION_STATUSES, type SessionStatus } from "./session-models";
import {
	attentionZone,
	attentionZoneOrder,
	boardAttentionZoneOrder,
	getAgentActivityView,
	getAttentionZoneView,
	getSessionStatusView,
	getSessionTimelinePillView,
	isAgentActivityWorking,
	isSessionIdle,
	type AttentionZone,
} from "./session-presentation";

const expectedAttentionZones: Record<SessionStatus, AttentionZone> = {
	working: "working",
	pr_open: "pending",
	draft: "pending",
	ci_failed: "technical",
	review_pending: "pending",
	changes_requested: "technical",
	approved: "merge",
	mergeable: "merge",
	merged: "merge",
	needs_input: "action",
	exited: "technical",
	no_signal: "technical",
	idle: "working",
	terminated: "done",
	unknown: "technical",
};

describe("session presentation", () => {
	it.each([
		["active", "Working", true, "bg-status-working animate-status-pulse"],
		["idle", "Idle", false, "bg-status-idle"],
		["waiting_input", "Input Needed", false, "bg-status-needs-you"],
		["blocked", "Awaiting Decision", false, "bg-status-needs-you"],
		["exited", "Exited", false, "bg-status-exited"],
		["unknown", "Unknown", false, "bg-status-unknown"],
	] as const)("maps %s activity without app state", (state, label, breathe, indicatorClassName) => {
		expect(getAgentActivityView({ state, lastActivityAt: "" })).toMatchObject({
			label,
			breathe,
			indicatorClassName,
		});
	});

	it("accepts injected labels", () => {
		expect(getSessionStatusView("working", (key) => `translated:${key}`).label).toBe(
			"translated:status.working",
		);
		expect(getAttentionZoneView("approved", (key) => `translated:${key}`).label).toBe(
			"translated:zone.merge",
		);
	});

	it.each(SESSION_STATUSES)("maps %s to exactly one attention zone", (status) => {
		expect(attentionZone(status)).toBe(expectedAttentionZones[status]);
	});

	it("publishes stable attention and board ordering", () => {
		expect(attentionZoneOrder).toEqual(["merge", "action", "technical", "pending", "working", "done"]);
		expect(boardAttentionZoneOrder).toEqual(["working", "action", "technical", "pending", "merge"]);
	});

	it("keeps lifecycle predicates independent of presentation labels", () => {
		expect(isAgentActivityWorking({ state: "active", lastActivityAt: "" })).toBe(true);
		expect(isAgentActivityWorking(undefined)).toBe(false);
		expect(isSessionIdle({ status: "idle" })).toBe(true);
		expect(isSessionIdle({ status: "working" })).toBe(false);
	});

	it("centralizes timeline status treatment", () => {
		expect(getSessionTimelinePillView("ci_failed")).toEqual({
			label: "CI Failed",
			tone: "var(--color-status-exited)",
			breathe: false,
		});
	});
});
