import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import type { Ref } from "./hosts";
export function useNavigateToSession(): (session: Ref) => void {
	const navigate = useNavigate();
	return useCallback(
		(session: Ref) => {
			if (!session.id) return;
			void navigate({
				to: "/host/$hostId/session/$sessionId",
				params: { hostId: session.host, sessionId: session.id },
			});
		},
		[navigate],
	);
}
