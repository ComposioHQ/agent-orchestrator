import { createFileRoute } from "@tanstack/react-router";
import { SessionsBoard } from "../components/SessionsBoard";
import { RenderProfiler } from "../components/RenderProfiler";

export const Route = createFileRoute("/_shell/projects/$projectId")({
	component: ProjectBoardRoute,
});

function ProjectBoardRoute() {
	const { projectId } = Route.useParams();
	return (
		<RenderProfiler id="board">
			<SessionsBoard projectId={projectId} />
		</RenderProfiler>
	);
}
