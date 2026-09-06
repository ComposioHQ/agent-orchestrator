import type { components } from "../../api/schema";
import { agentAuthenticationSignedIn } from "../lib/agent-auth";

export type AgentReadinessSnapshot = components["schemas"]["AgentReadinessSnapshot"];

export function agentReadiness(
	id: string,
	label = id,
	options: {
		installation?: AgentReadinessSnapshot["installation"]["state"];
		authentication?: AgentReadinessSnapshot["authentication"]["state"];
		freshness?: "fresh" | "stale" | "checking";
		usageCount?: number;
		lastUsedAt?: string | null;
	} = {},
): AgentReadinessSnapshot {
	const installation = options.installation ?? "installed";
	const authentication = options.authentication ?? "authorized";
	return {
		id,
		label,
		installation: {
			state: installation,
			freshness: options.freshness ?? "fresh",
			checkedAt: "2026-08-28T00:00:00Z",
			attemptedAt: "2026-08-28T00:00:00Z",
			reasonCode: installation,
			reason: `${label} installation test observation.`,
		},
		authentication: {
			state: authentication,
			freshness: options.freshness ?? "fresh",
			checkedAt: "2026-08-28T00:00:00Z",
			attemptedAt: "2026-08-28T00:00:00Z",
			reasonCode: authentication,
			reason: `${label} authentication test observation.`,
		},
		effectiveReadiness:
			installation === "installed" && agentAuthenticationSignedIn(authentication)
				? "ready"
				: installation === "not_installed" || authentication === "unauthorized"
					? "not_ready"
					: "unknown",
		usageCount: options.usageCount ?? 0,
		lastUsedAt: options.lastUsedAt ?? null,
	};
}

export function agentReadinessResponse(agents: AgentReadinessSnapshot[]) {
	return { data: { agents }, error: undefined };
}
