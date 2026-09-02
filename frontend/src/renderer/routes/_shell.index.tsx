import { createFileRoute } from "@tanstack/react-router";
import { HomePage } from "../components/HomePage";
import { MigrationPopup } from "../components/MigrationPopup";
import { workspaceQueryOptions } from "../hooks/useWorkspaceQuery";
import { hasTrustedApiBaseUrl } from "../lib/api-client";
import { refreshDaemonStatus } from "../lib/daemon-status";
import { usesPreviewWorkspaceData } from "../lib/preview-mode";

export const Route = createFileRoute("/_shell/")({
	loader: async ({ context }) => {
		await refreshDaemonStatus().catch(() => undefined);
		if (!usesPreviewWorkspaceData && !hasTrustedApiBaseUrl()) return;
		return context.queryClient.ensureQueryData(workspaceQueryOptions);
	},
	component: ShellIndex,
});

function ShellIndex() {
	return (
		<>
			<MigrationPopup />
			<HomePage />
		</>
	);
}
