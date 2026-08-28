import { useQuery } from "@tanstack/react-query";
import type { components } from "../../api/schema";
import { apiClient } from "../lib/api-client";

export type DetectedPreviewPort = components["schemas"]["DetectedPreviewPort"];

export const detectedPreviewPortsQueryKey = (sessionId: string) => ["session-preview-ports", sessionId] as const;

// Detected ports have no change feed to subscribe to. Nothing in the daemon is
// told when an agent starts a dev server, and no OS AO ships to reports "a port
// opened" without root, so the panel asks on a timer instead — and only while
// it is on screen, since an unwatched panel would be scanning process trees for
// nobody. The scan itself is cheap by design (see internal/portscan).
export const DETECTED_PORTS_POLL_MS = 5_000;

const NO_PORTS: DetectedPreviewPort[] = [];

/**
 * Ports the session's own processes are listening on, offered as preview
 * suggestions. Never throws and never surfaces an error: a daemon without the
 * route, a terminated session, and a machine that cannot enumerate sockets all
 * mean "nothing detected", which the panel renders as no list at all.
 */
export function useDetectedPreviewPorts(sessionId: string, enabled: boolean): DetectedPreviewPort[] {
	const query = useQuery({
		queryKey: detectedPreviewPortsQueryKey(sessionId),
		queryFn: async (): Promise<DetectedPreviewPort[]> => {
			const { data, error } = await apiClient.GET("/api/v1/sessions/{sessionId}/preview/ports", {
				params: { path: { sessionId } },
			});
			if (error || !data) return NO_PORTS;
			return data.ports ?? NO_PORTS;
		},
		enabled: enabled && sessionId !== "",
		refetchInterval: DETECTED_PORTS_POLL_MS,
	});
	return query.data ?? NO_PORTS;
}
