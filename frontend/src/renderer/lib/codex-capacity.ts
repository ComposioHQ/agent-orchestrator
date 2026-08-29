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

export function codexCapacitySummary(capacity: CodexCapacity, stateLabel: string): string {
	const used = capacity.usedPercent === undefined || capacity.usedPercent === null ? undefined : `${capacity.usedPercent}%`;
	return [capacity.plan, used, stateLabel].filter(Boolean).join(" · ");
}
