import { createFileRoute, redirect } from "@tanstack/react-router";
import { LOCAL_HOST } from "../lib/hosts";

// A session is addressed by host and id alone, so the old nested
// project→session path has no host-qualified twin: it redirects to the
// session itself, dropping the project segment it never needed.
export const Route = createFileRoute("/_shell/projects/$projectId_/sessions/$sessionId")({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: "/host/$hostId/session/$sessionId",
			params: { hostId: LOCAL_HOST, sessionId: params.sessionId },
			replace: true,
		});
	},
});
