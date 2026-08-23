import { createFileRoute, Navigate } from "@tanstack/react-router";
import { SessionView } from "../components/SessionView";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import { orchestratorProjectIdForSession } from "../lib/orchestrator-state";

export const Route = createFileRoute("/_shell/projects/$projectId_/sessions/$sessionId")({
	component: ProjectSessionRoute,
});

function ProjectSessionRoute() {
	const { projectId, sessionId } = Route.useParams();
	const workspaces = useWorkspaceQuery().data ?? [];
	if (orchestratorProjectIdForSession(workspaces, sessionId) === projectId) {
		return <Navigate to="/projects/$projectId/orchestrator" params={{ projectId }} replace />;
	}
	return <SessionView sessionId={sessionId} />;
}
