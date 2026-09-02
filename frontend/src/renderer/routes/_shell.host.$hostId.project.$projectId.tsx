import { createFileRoute } from "@tanstack/react-router";
import { SessionsBoard } from "../components/SessionsBoard";

export const Route = createFileRoute("/_shell/host/$hostId/project/$projectId")({
	component: ProjectBoardRoute,
});

function ProjectBoardRoute() {
	const { hostId, projectId } = Route.useParams();
	return <SessionsBoard project={{ host: hostId, id: projectId }} />;
}
