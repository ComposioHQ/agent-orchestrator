import { createFileRoute } from "@tanstack/react-router";
import { ProjectControlCockpit } from "../components/ProjectControlCockpit";
import { SessionsBoard } from "../components/SessionsBoard";

export const Route = createFileRoute("/_shell/projects/$projectId")({
	component: ProjectBoardRoute,
});

function ProjectBoardRoute() {
	const { projectId } = Route.useParams();
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<ProjectControlCockpit projectId={projectId} />
			<div className="min-h-0 flex-1">
				<SessionsBoard projectId={projectId} />
			</div>
		</div>
	);
}
