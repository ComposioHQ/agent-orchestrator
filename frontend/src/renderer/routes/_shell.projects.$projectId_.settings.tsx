import { createFileRoute, redirect } from "@tanstack/react-router";
import { LOCAL_HOST } from "../lib/hosts";

export const Route = createFileRoute("/_shell/projects/$projectId_/settings")({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: "/host/$hostId/project/$projectId/settings",
			params: { hostId: LOCAL_HOST, projectId: params.projectId },
			replace: true,
		});
	},
});
