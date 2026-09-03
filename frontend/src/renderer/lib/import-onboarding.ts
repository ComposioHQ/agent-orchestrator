import type { TFunction } from "i18next";
import type { components } from "../../api/schema";
import { apiClient, apiErrorMessage } from "./api-client";

export type ImportValidationResult = components["schemas"]["ImportValidationResult"];
export type GitPreparationResult = components["schemas"]["GitPreparationResult"];
export type GitPreparationEvent = components["schemas"]["GitPreparationEvent"];

export const GIT_PREP_ACTIONS = ["git_init", "git_commit", "set_remote"] as const;
export type GitPrepAction = (typeof GIT_PREP_ACTIONS)[number];

export async function validateProjectImport(path: string): Promise<ImportValidationResult> {
	const { data, error } = await apiClient.POST("/api/v1/imports/validate", {
		body: { importKind: "project", path },
	});
	if (error) throw new Error(apiErrorMessage(error));
	if (!data) throw new Error("Import validation returned no result");
	return data;
}

export async function prepareProjectGit(input: {
	path: string;
	approvedActions: string[];
	remoteUrl?: string;
}): Promise<GitPreparationResult> {
	const { data, error } = await apiClient.POST("/api/v1/imports/prepare-git", {
		body: {
			importKind: "project",
			path: input.path,
			approvedActions: input.approvedActions,
			remoteUrl: input.remoteUrl?.trim() || undefined,
		},
	});
	if (error) throw new Error(apiErrorMessage(error));
	if (!data) throw new Error("Git preparation returned no result");
	return data;
}

export function importValidationPath(result: ImportValidationResult): string {
	return result.root.repoPath;
}

export function formatImportBlockingErrors(result: ImportValidationResult, t: TFunction): string {
	if (result.blockingErrors.length === 0) return t("createProject.couldNotAdd");
	return result.blockingErrors.map((code) => formatImportBlockingError(code, t)).join(" ");
}

export function formatImportBlockingError(code: string, t: TFunction): string {
	const key = `createProject.importError.${code}` as const;
	const translated = t(key, { defaultValue: "" });
	return translated || code.replaceAll("_", " ").toLowerCase();
}

export function gitPrepActionLabel(action: string, t: TFunction): string {
	switch (action) {
		case "git_init":
			return t("createProject.importGitInit");
		case "git_commit":
			return t("createProject.importGitCommit");
		case "set_remote":
			return t("createProject.importGitSetRemote");
		default:
			return action;
	}
}

export function orderedGitPrepActions(requiredActions: string[]): GitPrepAction[] {
	return GIT_PREP_ACTIONS.filter((action) => requiredActions.includes(action));
}

export function latestGitPrepEventState(
	events: GitPreparationEvent[],
	repoPath: string,
	action: string,
): GitPreparationEvent["state"] | null {
	let state: GitPreparationEvent["state"] | null = null;
	for (const event of events) {
		if (event.repoPath === repoPath && event.action === action) state = event.state;
	}
	return state;
}

export function gitPrepFailedEvent(events: GitPreparationEvent[]): GitPreparationEvent | null {
	return events.find((event) => event.state === "error") ?? null;
}
