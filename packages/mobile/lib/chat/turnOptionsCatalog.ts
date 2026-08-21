import type { ApprovalMode } from "./types";

const APPROVAL_OPTIONS = [
	{ id: "read-only", label: "Read only", hint: "Filesystem writes are technically blocked" },
	{ id: "default", label: "Default", hint: "The worktree is the safety boundary" },
	{ id: "accept-edits", label: "Ask outside worktree", hint: "Edits here are allowed; anything else asks" },
	{ id: "auto", label: "Ask when unsure", hint: "The agent decides when to check with you" },
	{ id: "bypass-permissions", label: "Never ask", hint: "No approvals or sandbox prompts" },
] as const;

export function approvalOptionsForPermissionFloor(
	permissionFloor?: ApprovalMode,
	supportsPreventiveReadOnly = true,
) {
	if (permissionFloor === "read-only") {
		return APPROVAL_OPTIONS.filter((mode) => mode.id === "read-only");
	}
	return supportsPreventiveReadOnly
		? APPROVAL_OPTIONS
		: APPROVAL_OPTIONS.filter((mode) => mode.id !== "read-only");
}

export async function loadTurnOptionCatalog<Models, Options>({
	hasProviderConfig,
	loadModels,
	loadConfigOptions,
}: {
	hasProviderConfig: boolean;
	loadModels(): Promise<Models>;
	loadConfigOptions(): Promise<Options>;
}): Promise<{ models: Models | []; configOptions: Options | [] }> {
	if (hasProviderConfig) {
		return { models: [], configOptions: await loadConfigOptions() };
	}
	return { models: await loadModels(), configOptions: [] };
}
