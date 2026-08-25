import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, ChevronLeft, Cloud, LoaderCircle, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
	CloudBetaOverview,
	CloudHarness,
	CloudProject,
	CloudSessionSummary,
	CreateCloudProjectInput,
} from "../../shared/cloud-beta";
import { useCloudSession } from "../lib/cloud-session";
import { aoBridge } from "../lib/bridge";
import { cloudWorkspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { Button } from "./ui/button";

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : fallback;
}

function repositoryName(repositoryUrl: string): string {
	const pathname = repositoryUrl.trim().replace(/\/+$/, "").split("/").pop() ?? "";
	return pathname.replace(/\.git$/i, "");
}

export function CreateCloudProjectDialog({
	onBack,
	onOpenChange,
	open,
}: {
	onBack: () => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
}) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const cloudSession = useCloudSession();
	const signInStarted = useRef(false);
	const [overview, setOverview] = useState<CloudBetaOverview | null>(null);
	const [form, setForm] = useState<CreateCloudProjectInput>({
		displayName: "",
		repositoryUrl: "",
		defaultBranch: "main",
	});
	const [loading, setLoading] = useState(false);
	const [creating, setCreating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [created, setCreated] = useState<{
		project: CloudProject;
		session: CloudSessionSummary | null;
	} | null>(null);

	useEffect(() => {
		if (!open) {
			signInStarted.current = false;
			setOverview(null);
			setError(null);
			setCreated(null);
			return;
		}
		if (cloudSession.status !== "unauthenticated" || !cloudSession.configured || signInStarted.current) return;
		signInStarted.current = true;
		cloudSession.signIn();
	}, [cloudSession, open]);

	useEffect(() => {
		if (!open || cloudSession.status !== "authenticated") return;
		let active = true;
		setLoading(true);
		setError(null);
		void aoBridge.cloud
			.getOverview()
			.then((next) => {
				if (active) setOverview(next);
			})
			.catch((loadError) => {
				if (active) setError(errorMessage(loadError, t("createProject.cloudRequestFailed")));
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		return () => {
			active = false;
		};
	}, [cloudSession.status, open]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (!overview) return;
		setCreating(true);
		setError(null);
		let project: CloudProject | null = null;
		try {
			const availableHarnesses = new Set<CloudHarness>(
				overview.harnesses
					.filter((item) => item.connected && !(item.harness === "codex" && item.credentialType === "access_token"))
					.map((item) => item.harness),
			);
			let connectionFailure: unknown = null;
			for (const candidate of ["claude-code", "codex"] as const) {
				if (availableHarnesses.has(candidate)) continue;
				try {
					await aoBridge.cloud.connectLocalHarness(candidate);
					availableHarnesses.add(candidate);
				} catch (connectError) {
					// A user may have only one harness installed or signed in. Connect as
					// many as are available and continue with the first usable one. Keep
					// provider errors so they are not misreported as a missing local login.
					if (!errorMessage(connectError, "").startsWith("No local ")) {
						connectionFailure = connectError;
					}
				}
			}
			const harness: CloudHarness | undefined = availableHarnesses.has("claude-code")
				? "claude-code"
				: availableHarnesses.has("codex")
					? "codex"
					: undefined;
			if (!harness) {
				if (connectionFailure) throw connectionFailure;
				throw new Error(t("createProject.cloudNoHarness"));
			}
			project = await aoBridge.cloud.createProject(overview.organization.id, {
				...form,
				workerAgent: harness,
				orchestratorAgent: harness,
			});
			// The project is durable before its initial orchestrator finishes
			// provisioning. Refresh the normal project list immediately so a slow or
			// interrupted sandbox create cannot leave a successfully created project
			// hidden from the user.
			await queryClient.invalidateQueries({ queryKey: cloudWorkspaceQueryKey });
			const session = await aoBridge.cloud.createSession({
				orgId: overview.organization.id,
				projectId: project.id,
				kind: "orchestrator",
				harness,
				displayName: `${form.displayName} orchestrator`,
				prompt: "",
			});
			setCreated({ project, session });
		} catch (createError) {
			if (project) setCreated({ project, session: null });
			setError(errorMessage(createError, t("createProject.cloudRequestFailed")));
		} finally {
			setCreating(false);
		}
	};

	const authenticated = cloudSession.status === "authenticated";
	const canSubmit =
		authenticated &&
		overview !== null &&
		form.displayName.trim() !== "" &&
		form.repositoryUrl.trim() !== "" &&
		form.defaultBranch.trim() !== "" &&
		!creating;

	return (
		<Dialog.Root open={open} onOpenChange={(next) => !creating && onOpenChange(next)}>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay w-[min(520px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-welcome-panel border border-[var(--color-border-import-modal)] bg-[var(--color-bg-import-modal)] p-0 text-[var(--color-text-import-title)] shadow-[var(--shadow-import-modal)] data-[state=open]:animate-modal-in">
					<div className="flex items-start gap-3 border-b border-[var(--color-border-import-modal)] p-(--size-import-dialog-padding)">
						<Button aria-label={t("createProject.cloudBack")} disabled={creating} onClick={onBack} size="icon" type="button" variant="outline">
							<ChevronLeft className="size-4" aria-hidden="true" />
						</Button>
						<div className="min-w-0 flex-1">
							<Dialog.Title className="flex items-center gap-2 text-[18px] font-semibold">
								<Cloud className="size-5" aria-hidden="true" /> {t("createProject.cloud")}
							</Dialog.Title>
							<Dialog.Description className="mt-1 text-[13px] leading-5 text-[var(--color-text-import-muted)]">
								{t("createProject.cloudDescription")}
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button aria-label={t("createProject.cloudClose")} className="settings-close-button" disabled={creating} type="button">
								<X className="size-4" aria-hidden="true" />
							</button>
						</Dialog.Close>
					</div>

					<div className="p-(--size-import-dialog-padding)">
						{created ? (
							<div className="flex flex-col items-center py-5 text-center">
								<span className="grid size-11 place-items-center rounded-full bg-success/10 text-success">
									<CheckCircle2 className="size-6" aria-hidden="true" />
								</span>
								<h2 className="mt-4 text-base font-semibold">
									{t("createProject.cloudCreated", { name: created.project.displayName })}
								</h2>
								<p className="mt-2 max-w-sm text-sm leading-6 text-[var(--color-text-import-muted)]">
									{created.session
										? t("createProject.cloudProvisioning")
										: t("createProject.cloudOrchestratorFailed")}
								</p>
								<Button className="mt-5" onClick={() => onOpenChange(false)} type="button">
									{t("createProject.cloudDone")}
								</Button>
							</div>
						) : cloudSession.status === "loading" || loading ? (
							<div className="flex items-center justify-center gap-2 py-12 text-sm text-[var(--color-text-import-muted)]">
								<LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> {t("createProject.cloudPreparing")}
							</div>
						) : !cloudSession.configured ? (
							<p className="py-8 text-center text-sm text-destructive">{t("createProject.cloudNotConfigured")}</p>
						) : !authenticated ? (
							<div className="py-8 text-center">
								<p className="text-sm text-[var(--color-text-import-muted)]">{t("createProject.cloudFinishSignIn")}</p>
								<Button className="mt-4" onClick={() => cloudSession.signIn()} type="button" variant="outline">
									{t("createProject.cloudSignInAgain")}
								</Button>
							</div>
						) : (
							<form className="space-y-4" onSubmit={(event) => void submit(event)}>
								<label className="block space-y-1.5 text-sm font-medium">
									{t("createProject.cloudGitRepository")}
									<input
										className="h-10 w-full rounded-lg border border-border bg-background px-3 font-normal"
										onChange={(event) => {
											const repositoryUrl = event.target.value;
											setForm((current) => ({
												...current,
												repositoryUrl,
												displayName: repositoryName(repositoryUrl),
											}));
										}}
										placeholder={t("createProject.cloneRepositoryUrlPlaceholder")}
										required
										type="url"
										value={form.repositoryUrl}
									/>
								</label>
								<label className="block space-y-1.5 text-sm font-medium">
									{t("createProject.cloudDefaultBranch")}
									<input className="h-10 w-full rounded-lg border border-border bg-background px-3 font-normal" onChange={(event) => setForm((current) => ({ ...current, defaultBranch: event.target.value }))} required value={form.defaultBranch} />
								</label>
								{error ? <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="status">{error}</p> : null}
								<div className="border-t border-border pt-4">
									<Button className="w-full" disabled={!canSubmit} type="submit">
										{creating ? (
											<>
												<LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> {t("createProject.cloudCreating")}
											</>
										) : (
											t("createProject.cloud")
										)}
									</Button>
									<p className="mt-2 text-center text-xs leading-5 text-[var(--color-text-import-muted)]">
										{t("createProject.cloudConsent")}
									</p>
								</div>
							</form>
						)}
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
