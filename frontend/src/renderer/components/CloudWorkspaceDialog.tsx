import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { aoBridge } from "../lib/bridge";
import { setCloudApiBaseUrl } from "../lib/api-client";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "./ui/dialog";

const DEFAULT_REPOSITORY =
	import.meta.env.VITE_AO_CLOUD_POC_REPOSITORY_URL ||
	"https://github.com/Untrivial-ai/agent-orchestrator.git";
const DEFAULT_REF = import.meta.env.VITE_AO_CLOUD_POC_REPOSITORY_REF || "main";

export function CloudWorkspaceDialog({
	open,
	onOpenChange,
	onConnected,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConnected: () => void;
}) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [repositoryUrl, setRepositoryUrl] = useState(DEFAULT_REPOSITORY);
	const [repositoryRef, setRepositoryRef] = useState(DEFAULT_REF);
	const [status, setStatus] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const createWorkspace = async () => {
		setBusy(true);
		setError("");
		setStatus("Requesting a Daytona workspace…");
		try {
			let response = await aoBridge.cloud.createWorkspace({
				repositoryUrl: repositoryUrl.trim(),
				repositoryRef: repositoryRef.trim() || undefined,
			});
			setStatus("Installing AO and Claude in Daytona…");
			const deadline = Date.now() + 20 * 60 * 1000;
			while (response.workspace.state !== "ready") {
				if (response.workspace.state === "failed") {
					throw new Error(response.workspace.error || "Cloud workspace provisioning failed.");
				}
				if (Date.now() >= deadline) throw new Error("Cloud workspace provisioning timed out.");
				await new Promise((resolve) => window.setTimeout(resolve, 3_000));
				response = await aoBridge.cloud.getWorkspace({
					orgId: response.workspace.orgId,
					workspaceId: response.workspace.id,
				});
			}
			if (!response.previewUrl) throw new Error("Cloud workspace returned no AO connection URL.");
			setCloudApiBaseUrl(response.previewUrl);
			queryClient.clear();
			onConnected();
			onOpenChange(false);
			await navigate({ to: "/" });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not create cloud workspace.");
			setStatus("");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
			<DialogContent className="w-[min(520px,calc(100vw-32px))]" showCloseButton={!busy}>
				<DialogHeader>
					<DialogTitle>Create cloud project</DialogTitle>
					<DialogDescription>
						AO will clone this repository into a Daytona sandbox and run the normal AO daemon and Claude Code there.
					</DialogDescription>
				</DialogHeader>
				<label className="grid gap-1.5 text-sm font-medium">
					Repository URL
					<input
						className="h-9 rounded-md border border-border bg-background px-3 font-normal outline-none focus:border-accent"
						disabled={busy}
						onChange={(event) => setRepositoryUrl(event.target.value)}
						value={repositoryUrl}
					/>
				</label>
				<label className="grid gap-1.5 text-sm font-medium">
					Branch or tag
					<input
						className="h-9 rounded-md border border-border bg-background px-3 font-normal outline-none focus:border-accent"
						disabled={busy}
						onChange={(event) => setRepositoryRef(event.target.value)}
						value={repositoryRef}
					/>
				</label>
				{status && <p className="text-sm text-muted-foreground">{status}</p>}
				{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
				<DialogFooter className="flex-row justify-end">
					<button
						className="h-9 rounded-md border border-border px-3 text-sm"
						disabled={busy}
						onClick={() => onOpenChange(false)}
						type="button"
					>
						Cancel
					</button>
					<button
						className="h-9 rounded-md bg-foreground px-3 text-sm text-background disabled:opacity-50"
						disabled={busy || !repositoryUrl.trim()}
						onClick={() => void createWorkspace()}
						type="button"
					>
						{busy ? "Creating…" : "Create in cloud"}
					</button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
