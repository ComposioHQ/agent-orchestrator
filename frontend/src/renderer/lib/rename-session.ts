import { apiErrorMessage } from "./api-client";
import { clientFor } from "./host-clients";
import type { Ref } from "./hosts";

/** Update a session's display name via the daemon (PATCH /sessions/{id}). The
 *  daemon enforces the same 20-character limit as the spawn `--name` flag. */
export async function renameSession(ref: Ref, displayName: string): Promise<void> {
	const { error, response } = await clientFor(ref.host).PATCH("/api/v1/sessions/{sessionId}", {
		params: { path: { sessionId: ref.id } },
		body: { displayName },
	});

	if (error) {
		throw new Error(apiErrorMessage(error, `Failed to rename session (${response.status})`));
	}
}
