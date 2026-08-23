import createClient from "openapi-fetch";
import type { components, paths } from "../api/schema";

type SpawnSessionRequest = components["schemas"]["SpawnSessionRequest"];

export type HostedAppClient = {
	listProjects: (organizationId: string) => Promise<components["schemas"]["ListProjectsResponse"]>;
	getProject: (organizationId: string, projectId: string) => Promise<components["schemas"]["ProjectGetResponse"]>;
	spawnSession: (
		organizationId: string,
		input: SpawnSessionRequest,
		idempotencyKey: string,
	) => Promise<components["schemas"]["SpawnSessionResponse"]>;
};

function requestError(error: unknown): Error {
	if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
		return Object.assign(new Error(error.message), error);
	}
	return new Error("AO Cloud application request failed.");
}

/** Typed canonical /api/v1 client owned exclusively by Electron main. */
export function createHostedAppClient(input: {
	baseUrl: string;
	getAccessToken: () => Promise<string>;
}): HostedAppClient {
	const client = createClient<paths>({ baseUrl: input.baseUrl });
	const headers = async (organizationId: string, idempotencyKey?: string) => ({
		Authorization: `Bearer ${await input.getAccessToken()}`,
		"X-AO-Org": organizationId,
		...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
	});

	return {
		async listProjects(organizationId) {
			const { data, error } = await client.GET("/api/v1/projects", {
				headers: await headers(organizationId),
			});
			if (!data) throw requestError(error);
			return data;
		},

		async getProject(organizationId, projectId) {
			const { data, error } = await client.GET("/api/v1/projects/{id}", {
				params: { path: { id: projectId } },
				headers: await headers(organizationId),
			});
			if (!data) throw requestError(error);
			return data;
		},

		async spawnSession(organizationId, body, idempotencyKey) {
			const { data, error } = await client.POST("/api/v1/sessions", {
				body,
				headers: await headers(organizationId, idempotencyKey),
			});
			if (!data) throw requestError(error);
			return data;
		},
	};
}
