import { useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { clientFor } from "../lib/host-clients";
import { refKey, type Ref } from "../lib/hosts";
import { mockSessionScmSummaries } from "../lib/mock-data";

export type SessionPRSummary = components["schemas"]["SessionPRSummary"];

export const sessionScmSummaryQueryKey = (session?: Ref) =>
	session ? (["session-scm-summary", refKey(session)] as const) : (["session-scm-summary"] as const);

const usePreviewData = import.meta.env.VITE_NO_ELECTRON === "1";

export async function fetchSessionScmSummary(session: Ref): Promise<SessionPRSummary[]> {
	const { data, error } = await clientFor(session.host).GET("/api/v1/sessions/{sessionId}/pr", {
		params: { path: { sessionId: session.id } },
	});
	if (error) throw error;
	return data?.prs ?? [];
}

export function sessionScmSummaryQueryOptions(session: Ref) {
	return {
		queryKey: sessionScmSummaryQueryKey(session),
		enabled: Boolean(session.id),
		queryFn: () =>
			usePreviewData ? Promise.resolve(mockSessionScmSummaries[session.id] ?? []) : fetchSessionScmSummary(session),
		retry: 1,
	};
}

export function useSessionScmSummary(session?: Ref) {
	return useQuery({
		queryKey: sessionScmSummaryQueryKey(session),
		enabled: Boolean(session),
		queryFn: () =>
			usePreviewData ? Promise.resolve(mockSessionScmSummaries[session!.id] ?? []) : fetchSessionScmSummary(session!),
		retry: 1,
	});
}
