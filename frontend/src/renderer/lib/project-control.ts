import type { components } from "../../api/schema";
import { apiClient, apiErrorCode, apiErrorMessage } from "./api-client";
export { projectControlQueryKey } from "./project-control-query";

export type ProjectControl = components["schemas"]["ProjectControl"];
export type SetProjectOutcomeRequest = components["schemas"]["SetProjectOutcomeRequest"];

export class ProjectControlRevisionConflict extends Error {
	constructor(readonly currentRevision?: number) {
		super("Project control changed while you were editing");
		this.name = "ProjectControlRevisionConflict";
	}
}

export async function fetchProjectControl(projectId: string, signal?: AbortSignal): Promise<ProjectControl> {
	const { data, error } = await apiClient.GET("/api/v1/projects/{id}/control", {
		params: { path: { id: projectId } },
		signal,
	});
	if (error) throw new Error(apiErrorMessage(error, "Could not load project control"));
	if (!data) throw new Error("Project control response was empty");
	return data;
}

export async function setProjectOutcome(
	projectId: string,
	request: SetProjectOutcomeRequest,
): Promise<ProjectControl> {
	const { data, error } = await apiClient.PUT("/api/v1/projects/{id}/outcome", {
		params: { path: { id: projectId } },
		body: request,
	});
	if (error) {
		if (apiErrorCode(error) === "PROJECT_CONTROL_REVISION_CONFLICT") {
			const revision = error.details?.currentRevision;
			throw new ProjectControlRevisionConflict(typeof revision === "number" ? revision : undefined);
		}
		throw new Error(apiErrorMessage(error, "Could not save project control"));
	}
	if (!data) throw new Error("Project control response was empty");
	return data;
}

export function newProjectControlIdempotencyKey(): string {
	return `desktop-${globalThis.crypto.randomUUID()}`;
}
