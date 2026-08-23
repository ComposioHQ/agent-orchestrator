import { type FormEvent, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Cloud, GitBranch, Link2, LoaderCircle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { aoBridge } from "../lib/bridge";
import { setCloudApiBaseUrl } from "../lib/api-client";
import { Button } from "./ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

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
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [repositoryUrl, setRepositoryUrl] = useState(DEFAULT_REPOSITORY);
	const [repositoryRef, setRepositoryRef] = useState(DEFAULT_REF);
	const [status, setStatus] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);

	const createWorkspace = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setBusy(true);
		setError("");
		setStatus(t("cloudWorkspace.requesting"));
		try {
			let response = await aoBridge.cloud.createWorkspace({
				repositoryUrl: repositoryUrl.trim(),
				repositoryRef: repositoryRef.trim() || undefined,
			});
			setStatus(t("cloudWorkspace.installing"));
			const deadline = Date.now() + 20 * 60 * 1000;
			while (response.workspace.state !== "ready") {
				if (response.workspace.state === "failed") {
					throw new Error(response.workspace.error || t("cloudWorkspace.provisioningFailed"));
				}
				if (Date.now() >= deadline) throw new Error(t("cloudWorkspace.provisioningTimedOut"));
				await new Promise((resolve) => window.setTimeout(resolve, 3_000));
				response = await aoBridge.cloud.getWorkspace({
					orgId: response.workspace.orgId,
					workspaceId: response.workspace.id,
				});
			}
			if (!response.previewUrl) throw new Error(t("cloudWorkspace.missingConnectionUrl"));
			setCloudApiBaseUrl(response.previewUrl);
			queryClient.clear();
			onConnected();
			onOpenChange(false);
			await navigate({ to: "/" });
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : t("cloudWorkspace.createFailed"));
			setStatus("");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
			<DialogContent
				className="z-overlay flex max-h-[min(640px,calc(100svh-24px))] w-[min(var(--size-import-folder-dialog),calc(100vw-24px))] max-w-none flex-col gap-0 overflow-hidden rounded-welcome-panel border border-[var(--color-border-import-modal)] bg-[var(--color-bg-import-modal)] p-0 text-[var(--color-text-import-title)] shadow-[var(--shadow-import-modal)]"
				showCloseButton={false}
			>
				<div className="flex shrink-0 items-start gap-4 border-b border-[var(--color-border-import-modal)] p-(--size-import-dialog-padding)">
					<div className="grid size-9 shrink-0 place-items-center rounded-lg border border-[var(--color-border-import-modal)] bg-[var(--color-bg-import-card)] text-[var(--color-text-import-title)]">
						<Cloud className="size-4" aria-hidden="true" />
					</div>
					<div className="min-w-0 flex-1">
						<DialogTitle className="text-balance text-[18px] font-semibold text-[var(--color-text-import-title)]">
							{t("cloudWorkspace.title")}
						</DialogTitle>
						<DialogDescription className="mt-1 max-w-[520px] text-pretty text-[13px] font-medium leading-5 text-[var(--color-text-import-muted)]">
							{t("cloudWorkspace.description")}
						</DialogDescription>
					</div>
					<button
						aria-label={t("common.close")}
						className="settings-close-button"
						disabled={busy}
						onClick={() => onOpenChange(false)}
						type="button"
					>
						<X className="size-4" aria-hidden="true" />
					</button>
				</div>

				<form className="min-h-0 overflow-y-auto" onSubmit={(event) => void createWorkspace(event)}>
					<div className="space-y-5 p-(--size-import-dialog-padding)">
						{error ? (
							<p className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-pretty text-[12px] leading-5 text-destructive" role="alert">
								{error}
							</p>
						) : null}

						<div className="space-y-2">
							<Label htmlFor="cloudRepositoryUrl" className="text-[13px] font-semibold text-[var(--color-text-import-title)]">
								{t("cloudWorkspace.repositoryUrl")}
							</Label>
							<div className="relative">
								<span className="pointer-events-none absolute inset-y-0 left-3 flex w-4 items-center justify-center text-[var(--color-text-import-muted)]">
									<Link2 className="size-4" aria-hidden="true" />
								</span>
								<Input
									id="cloudRepositoryUrl"
									autoCapitalize="none"
									autoComplete="off"
									className="bg-[var(--color-bg-import-card)] pl-10 font-mono text-[13px]"
									disabled={busy}
									onChange={(event) => setRepositoryUrl(event.target.value)}
									spellCheck={false}
									value={repositoryUrl}
								/>
							</div>
						</div>

						<div className="space-y-2">
							<Label htmlFor="cloudRepositoryRef" className="text-[13px] font-semibold text-[var(--color-text-import-title)]">
								{t("cloudWorkspace.repositoryRef")}
							</Label>
							<div className="relative">
								<span className="pointer-events-none absolute inset-y-0 left-3 flex w-4 items-center justify-center text-[var(--color-text-import-muted)]">
									<GitBranch className="size-4" aria-hidden="true" />
								</span>
								<Input
									id="cloudRepositoryRef"
									autoCapitalize="none"
									autoComplete="off"
									className="bg-[var(--color-bg-import-card)] pl-10 font-mono text-[13px]"
									disabled={busy}
									onChange={(event) => setRepositoryRef(event.target.value)}
									spellCheck={false}
									value={repositoryRef}
								/>
							</div>
						</div>

						{status ? (
							<div aria-live="polite" className="flex items-center gap-3 rounded-lg border border-[var(--color-border-import-modal)] bg-[var(--color-bg-import-card)] px-4 py-3 text-[12px] font-medium leading-5 text-[var(--color-text-import-muted)]">
								<LoaderCircle className="size-4 shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
								<span>{status}</span>
							</div>
						) : null}
					</div>

					<div className="flex shrink-0 items-center justify-end gap-3 border-t border-[var(--color-border-import-modal)] p-(--size-import-dialog-padding)">
						<Button type="button" variant="footer" disabled={busy} onClick={() => onOpenChange(false)}>
							{t("createProject.cancel")}
						</Button>
						<Button type="submit" variant="footer-primary" disabled={busy || !repositoryUrl.trim()}>
							{busy ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : null}
							{busy ? t("cloudWorkspace.creating") : t("cloudWorkspace.create")}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	);
}
