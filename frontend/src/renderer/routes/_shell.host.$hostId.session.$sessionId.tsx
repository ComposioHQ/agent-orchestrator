import { createFileRoute } from "@tanstack/react-router";
import { SessionView } from "../components/SessionView";

export const Route = createFileRoute("/_shell/host/$hostId/session/$sessionId")({
	component: HostSessionRoute,
});

function HostSessionRoute() {
	const { hostId, sessionId } = Route.useParams();
	return <SessionView sessionRef={{ host: hostId, id: sessionId }} />;
}
