const DEFAULT_BRANCH_UNRESOLVED_CODE = "DEFAULT_BRANCH_UNRESOLVED";

function extractRemoteUrl(message: string): string | null {
	const singleQuoted = message.match(/fatal:\s+repository\s+'([^']+)'/i);
	if (singleQuoted?.[1]) return singleQuoted[1].replace(/\/+$/, "");
	const doubleQuoted = message.match(/repository\s+"([^"]+\.git)"\s+not found/i);
	if (doubleQuoted?.[1]) return doubleQuoted[1].replace(/\/+$/, "");
	return null;
}

function extractWorkspaceRepoName(message: string): string | null {
	const namedRepo = message.match(/resolve workspace repo\s+"([^"]+)"/i);
	if (namedRepo?.[1]) return namedRepo[1];
	return null;
}

export function formatOrchestratorStartupError(message: string): string {
	if (!message.includes(DEFAULT_BRANCH_UNRESOLVED_CODE)) return message;
	const repoName = extractWorkspaceRepoName(message);
	const remoteUrl = extractRemoteUrl(message);
	const repoLabel = repoName ? `child repository "${repoName}"` : "child repository";
	if (remoteUrl) {
		return `Project added, but orchestrator did not start. The ${repoLabel} still needs its remote repository set up at ${remoteUrl}. Create or fix that remote, then retry starting the orchestrator.`;
	}
	return `Project added, but orchestrator did not start. The ${repoLabel} still needs its remote repository set up before the orchestrator can start. Create or fix that remote, then retry starting the orchestrator.`;
}
