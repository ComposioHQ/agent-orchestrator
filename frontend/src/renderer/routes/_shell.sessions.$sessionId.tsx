import { createFileRoute, redirect } from "@tanstack/react-router";
import { LOCAL_HOST } from "../lib/hosts";

// Sessions became host-qualified. Every link, bookmark and deep link minted
// before that points here, so this path keeps working and resolves to the
// local host — the only host those URLs could ever have meant.
export const Route = createFileRoute("/_shell/sessions/$sessionId")({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: "/host/$hostId/session/$sessionId",
			params: { hostId: LOCAL_HOST, sessionId: params.sessionId },
			replace: true,
		});
	},
});
