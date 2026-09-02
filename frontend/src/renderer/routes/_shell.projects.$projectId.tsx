import { createFileRoute, redirect } from "@tanstack/react-router";
import { LOCAL_HOST } from "../lib/hosts";

// See _shell.sessions.$sessionId.tsx: the old, unqualified project path is
// kept as a redirect so existing links survive the move to /host/$hostId/….
export const Route = createFileRoute("/_shell/projects/$projectId")({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: "/host/$hostId/project/$projectId",
			params: { hostId: LOCAL_HOST, projectId: params.projectId },
			replace: true,
		});
	},
});
