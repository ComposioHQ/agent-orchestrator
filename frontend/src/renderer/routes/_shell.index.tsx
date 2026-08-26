import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { MigrationPopup } from "../components/MigrationPopup";
import { SessionsBoard } from "../components/SessionsBoard";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";

export const Route = createFileRoute("/_shell/")({
	component: ShellIndex,
});

function ShellIndex() {
	const navigate = useNavigate();
	const workspaceQuery = useWorkspaceQuery();

	// TODO: remove — temporary redirect to preview onboarding prototype
	useEffect(() => {
		void navigate({ to: "/onboarding", replace: true });
	}, [navigate]);

	useEffect(() => {
		if (!workspaceQuery.isSuccess) return;
		const workspaces = workspaceQuery.data ?? [];
		if (workspaces.length !== 1) return;
		const [workspace] = workspaces;
		if (workspace.id !== "scratch" || workspace.kind !== "scratch") return;
		void navigate({
			to: "/projects/$projectId",
			params: { projectId: "scratch" },
			replace: true,
		});
	}, [navigate, workspaceQuery.data, workspaceQuery.isSuccess]);

	return (
		<>
			<MigrationPopup />
			<SessionsBoard />
		</>
	);
}
