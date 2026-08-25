import type { CloudHarness } from "../../shared/cloud-beta";
import type { WorkspaceSummary } from "../types/workspace";
import { aoBridge } from "./bridge";

export async function spawnCloudOrchestrator(workspace: WorkspaceSummary): Promise<string> {
	const harness = workspace.orchestratorAgent;
	if (
		workspace.executionLocation !== "cloud" ||
		!workspace.cloudOrgId ||
		(harness !== "claude-code" && harness !== "codex")
	) {
		throw new Error("Cloud project configuration is incomplete.");
	}
	await aoBridge.cloud.connectLocalHarness(harness as CloudHarness);
	const session = await aoBridge.cloud.createSession({
		orgId: workspace.cloudOrgId,
		projectId: workspace.id,
		kind: "orchestrator",
		harness: harness as CloudHarness,
		displayName: `${workspace.name} orchestrator`,
		prompt: "",
	});
	return session.id;
}
