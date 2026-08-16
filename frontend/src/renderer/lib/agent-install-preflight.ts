import { apiClient } from "./api-client";

/** AO's agent-adapter docs: the one page that covers every harness AO ships.
 *  Deliberately not deep-linked per agent — only a handful of harnesses have
 *  their own page, so a generated `/agents/{id}` link 404s for most of them. */
export const AGENT_DOCS_URL = "https://aoagents.dev/docs/plugins/agents";

/** A spawn refused locally because the selected agent's CLI is not installed. */
export class AgentNotInstalledError extends Error {
	readonly code = "AGENT_NOT_INSTALLED";

	constructor(
		readonly agentId: string,
		readonly agentLabel: string,
	) {
		super(`${agentLabel} is not installed`);
		this.name = "AgentNotInstalledError";
	}
}

export function isAgentNotInstalledError(error: unknown): error is AgentNotInstalledError {
	return error instanceof AgentNotInstalledError;
}

/**
 * Refuse a spawn whose agent CLI is missing, before the request is made.
 *
 * The daemon rejects these spawns too, but only once asked: the user spends a
 * round trip to learn their CLI is not installed, and the refusal lands in spawn
 * telemetry looking like the spawn engine broke. A missing agent binary is the
 * single largest cause of spawn failures, and it is a setup gap, not a spawn bug
 * — so the click should not become a spawn at all.
 *
 * One-sided on purpose. The cached inventory is a boot-time snapshot, so a
 * "not installed" entry is re-probed before it is believed, and anything the
 * probe cannot answer — an older daemon without the endpoint, a transport
 * failure, an unset or unsupported agent — falls through to the daemon, which
 * validates for real. Blocking a spawn that would have worked is worse than the
 * cheap failure this replaces.
 */
export async function assertAgentInstalled(agentId: string | undefined): Promise<void> {
	const id = agentId?.trim();
	if (!id) return;

	let missing: AgentNotInstalledError | undefined;
	try {
		missing = await missingAgent(id);
	} catch {
		// The catalog or probe call itself failed. That says nothing about the CLI,
		// so the spawn goes to the daemon.
		return;
	}
	if (missing) throw missing;
}

async function missingAgent(id: string): Promise<AgentNotInstalledError | undefined> {
	const { data, error } = await apiClient.GET("/api/v1/agents");
	if (error || !data) return undefined;
	const supported = data.supported?.find((agent) => agent.id === id);
	if (!supported) return undefined;
	if (data.installed?.some((agent) => agent.id === id)) return undefined;

	const probe = await apiClient.POST("/api/v1/agents/{agent}/probe", {
		params: { path: { agent: id } },
	});
	if (probe.error || !probe.data) return undefined;
	if (probe.data.installed) return undefined;

	return new AgentNotInstalledError(id, probe.data.agent?.label || supported.label || id);
}
