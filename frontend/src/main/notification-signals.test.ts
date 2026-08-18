// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
	dockBounceType,
	shouldSignalAttention,
	shouldToast,
	type NotificationType,
} from "./notification-signals";

const ALL_TYPES: NotificationType[] = ["needs_input", "ready_to_merge", "pr_merged", "pr_closed_unmerged"];

describe("shouldToast", () => {
	it("fires a toast for every backend notification type", () => {
		for (const type of ALL_TYPES) {
			expect(shouldToast({ title: `${type} title` }, true)).toBe(true);
		}
	});

	it("does not toast without a title or when notifications are unsupported", () => {
		expect(shouldToast({ title: "" }, true)).toBe(false);
		expect(shouldToast({}, true)).toBe(false);
		expect(shouldToast({ title: "needs input" }, false)).toBe(false);
	});
});

describe("shouldSignalAttention", () => {
	it("signals for every backend notification type", () => {
		for (const type of ALL_TYPES) {
			expect(shouldSignalAttention(type)).toBe(true);
		}
	});

	it("is default-on, so a new type cannot silently lose its signal", () => {
		expect(shouldSignalAttention("some_future_type")).toBe(true);
		expect(shouldSignalAttention(undefined)).toBe(true);
	});
});

describe("dockBounceType", () => {
	it("bounces critically for a blocked agent waiting on the user", () => {
		expect(dockBounceType("needs_input")).toBe("critical");
	});

	it("bounces once for the other backend types", () => {
		for (const type of ALL_TYPES.filter((t) => t !== "needs_input")) {
			expect(dockBounceType(type)).toBe("informational");
		}
	});

	it("bounces once for unknown or missing types", () => {
		expect(dockBounceType("some_future_type")).toBe("informational");
		expect(dockBounceType(undefined)).toBe("informational");
	});
});
