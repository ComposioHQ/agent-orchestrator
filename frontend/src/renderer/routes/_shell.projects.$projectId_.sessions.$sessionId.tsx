import { createFileRoute } from "@tanstack/react-router";
import { SessionView } from "../components/SessionView";
import { validateSessionRouteSearch } from "./-session-route-search";

export const Route = createFileRoute("/_shell/projects/$projectId_/sessions/$sessionId")({
	component: ProjectSessionRoute,
	validateSearch: validateSessionRouteSearch,
});

function ProjectSessionRoute() {
	const { sessionId } = Route.useParams();
	const { tabOwner } = Route.useSearch();
	return <SessionView sessionId={sessionId} tabOwnerSessionId={tabOwner} />;
}
