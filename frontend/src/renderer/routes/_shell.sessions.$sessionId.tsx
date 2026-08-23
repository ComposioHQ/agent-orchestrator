import { createFileRoute, Navigate } from "@tanstack/react-router";
import { SessionView } from "../components/SessionView";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import { orchestratorProjectIdForSession } from "../lib/orchestrator-state";

export const Route = createFileRoute("/_shell/sessions/$sessionId")({
	component: SessionRoute,
});

function SessionRoute() {
	const { sessionId } = Route.useParams();
	const workspaces = useWorkspaceQuery().data ?? [];
	const projectId = orchestratorProjectIdForSession(workspaces, sessionId);
	if (projectId) {
		return <Navigate to="/projects/$projectId/orchestrator" params={{ projectId }} replace />;
	}
	return <SessionView sessionId={sessionId} />;
}
