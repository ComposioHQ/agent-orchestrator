import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { formatEstimatedCost } from "../lib/format-cost";
import { formatTokenCount } from "../lib/format-token-count";
import type { SessionUsageSummary } from "../hooks/useSessionUsageSummaries";
import { toUsagePresentation } from "./SessionsBoardAdapters";

// A fake `t` that echoes its inputs back, so assertions exercise the real
// composition logic in toUsagePresentation instead of the actual English copy.
const fakeT = ((key: string, options?: { count?: string }) =>
	`translated(${key}:${options?.count})`) as TFunction;

function makeUsage(overrides: Partial<SessionUsageSummary>): SessionUsageSummary {
	return {
		estimatedCost: null,
		incomplete: false,
		processedTokens: null,
		sessionId: "session-1",
		totalTokens: 0,
		...overrides,
	};
}

const estimatedCost: SessionUsageSummary["estimatedCost"] = {
	cachedInputNanos: null,
	coverage: "complete",
	inputNanos: 1,
	outputNanos: 1,
	providerAttribution: "observed",
	totalNanos: 10_960_000_000,
};

describe("toUsagePresentation", () => {
	it("combines cost and tokens, with the same values feeding both labels", () => {
		const usage = makeUsage({ estimatedCost, processedTokens: 42_300 });

		const result = toUsagePresentation(usage, fakeT);
		expect(result).toBeDefined();

		const cost = formatEstimatedCost(usage.estimatedCost);
		const compactTokens = formatTokenCount(usage.processedTokens as number).replace(/ tok$/, "");
		expect(cost).not.toBeNull();

		// accessibleLabel and compactLabel must be built from the same cost/token
		// values -- that divergence was the original bug. Assert both contain the
		// literal formatted numbers produced by the same formatting utilities.
		expect(result!.accessibleLabel).toBe(`${cost} · translated(shell.usageTokens:42,300)`);

		const { container } = render(<>{result!.compactLabel}</>);
		expect(container.textContent).toBe(`${cost} · ${compactTokens}`);
	});

	it("shows cost only, with no dangling separator, when tokens are absent", () => {
		const usage = makeUsage({ estimatedCost, processedTokens: null });

		const result = toUsagePresentation(usage, fakeT);
		const cost = formatEstimatedCost(usage.estimatedCost);

		expect(result).toEqual({ accessibleLabel: cost, compactLabel: cost });
	});

	it("shows tokens only, with no dangling separator, when cost is absent", () => {
		const usage = makeUsage({ estimatedCost: null, processedTokens: 42_300 });

		const result = toUsagePresentation(usage, fakeT);
		const compactTokens = formatTokenCount(usage.processedTokens as number).replace(/ tok$/, "");

		expect(result).toEqual({
			accessibleLabel: "translated(shell.usageTokens:42,300)",
			compactLabel: compactTokens,
		});
	});

	it("returns undefined when neither cost nor tokens are present", () => {
		expect(toUsagePresentation(makeUsage({ estimatedCost: null, processedTokens: null }), fakeT)).toBeUndefined();
		expect(toUsagePresentation(makeUsage({ estimatedCost: null, processedTokens: 0 }), fakeT)).toBeUndefined();
		expect(toUsagePresentation(undefined, fakeT)).toBeUndefined();
	});
});
