import type { components } from "../../api/schema";

export type CodexCapacity = components["schemas"]["CodexCapacitySnapshot"];
export type CodexCapacityState = CodexCapacity["state"];

export function codexCapacityTranslationKey(state: CodexCapacityState) {
	switch (state) {
		case "available":
			return "settings.codexProfiles.capacityAvailable" as const;
		case "near_limit":
			return "settings.codexProfiles.capacityNearLimit" as const;
		case "exhausted":
			return "settings.codexProfiles.capacityExhausted" as const;
		case "unsupported":
			return "settings.codexProfiles.capacityUnsupported" as const;
		default:
			return "settings.codexProfiles.capacityUnknown" as const;
	}
}

export function codexCapacityRemainingPercent(usedPercent: number | null | undefined): number | undefined {
	if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return undefined;
	return Math.max(0, Math.min(100, 100 - usedPercent));
}

export function codexCapacitySummary(capacity: CodexCapacity, stateLabel: string): string {
	const remaining = codexCapacityRemainingPercent(capacity.usedPercent);
	return [capacity.plan, remaining === undefined ? undefined : `${remaining}%`, stateLabel].filter(Boolean).join(" · ");
}
