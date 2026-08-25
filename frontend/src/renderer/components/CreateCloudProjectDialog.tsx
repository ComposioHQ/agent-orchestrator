import * as Dialog from "@radix-ui/react-dialog";
import { CheckCircle2, ChevronLeft, Cloud, LoaderCircle, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type {
	CloudBetaOverview,
	CloudHarness,
	CloudProject,
	CloudSessionSummary,
	CreateCloudProjectInput,
} from "../../shared/cloud-beta";
import { useCloudSession } from "../lib/cloud-session";
import { aoBridge } from "../lib/bridge";
import { Button } from "./ui/button";

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "AO Cloud could not complete that request.";
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
	const cloudSession = useCloudSession();
	const signInStarted = useRef(false);
	const nameTouched = useRef(false);
	const [overview, setOverview] = useState<CloudBetaOverview | null>(null);
	const [form, setForm] = useState<CreateCloudProjectInput>({
		displayName: "",
		repositoryUrl: "",
		defaultBranch: "main",
	});
	const [harness, setHarness] = useState<CloudHarness>("claude-code");
	const [loading, setLoading] = useState(false);
	const [creating, setCreating] = useState(false);
	const [disconnecting, setDisconnecting] = useState(false);
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
				if (active) setError(errorMessage(loadError));
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
			const connection = overview.harnesses.find((item) => item.harness === harness);
			if (!connection?.connected) await aoBridge.cloud.connectLocalHarness(harness);
			project = await aoBridge.cloud.createProject(overview.organization.id, {
				...form,
				workerAgent: harness,
				orchestratorAgent: harness,
			});
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
			setError(errorMessage(createError));
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
	const selectedConnection = overview?.harnesses.find((item) => item.harness === harness);
	const disconnect = async () => {
		setDisconnecting(true);
		setError(null);
		try {
			await aoBridge.cloud.disconnectHarness(harness);
			setOverview((current) =>
				current
					? {
							...current,
							harnesses: current.harnesses.map((item) =>
								item.harness === harness ? { ...item, connected: false, validationState: undefined } : item,
							),
						}
					: current,
			);
		} catch (disconnectError) {
			setError(errorMessage(disconnectError));
		} finally {
			setDisconnecting(false);
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={(next) => !creating && onOpenChange(next)}>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay w-[min(520px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-welcome-panel border border-[var(--color-border-import-modal)] bg-[var(--color-bg-import-modal)] p-0 text-[var(--color-text-import-title)] shadow-[var(--shadow-import-modal)] data-[state=open]:animate-modal-in">
					<div className="flex items-start gap-3 border-b border-[var(--color-border-import-modal)] p-(--size-import-dialog-padding)">
						<Button aria-label="Back to project type" disabled={creating} onClick={onBack} size="icon" type="button" variant="outline">
							<ChevronLeft className="size-4" aria-hidden="true" />
						</Button>
						<div className="min-w-0 flex-1">
							<Dialog.Title className="flex items-center gap-2 text-[18px] font-semibold">
								<Cloud className="size-5" aria-hidden="true" /> Create project in Cloud
							</Dialog.Title>
							<Dialog.Description className="mt-1 text-[13px] leading-5 text-[var(--color-text-import-muted)]">
								AO clones the repository and runs every session for this project in its own isolated sandbox.
							</Dialog.Description>
						</div>
						<Dialog.Close asChild>
							<button aria-label="Close Cloud project dialog" className="settings-close-button" disabled={creating} type="button">
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
								<h2 className="mt-4 text-base font-semibold">{created.project.displayName} is a Cloud project</h2>
								<p className="mt-2 max-w-sm text-sm leading-6 text-[var(--color-text-import-muted)]">
									{created.session
										? "Its orchestrator sandbox is provisioning now."
										: "The project was created, but its orchestrator did not start. You can retry after reopening this flow."}
								</p>
								<Button className="mt-5" onClick={() => onOpenChange(false)} type="button">Done</Button>
							</div>
						) : cloudSession.status === "loading" || loading ? (
							<div className="flex items-center justify-center gap-2 py-12 text-sm text-[var(--color-text-import-muted)]">
								<LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> Preparing AO Cloud…
							</div>
						) : !cloudSession.configured ? (
							<p className="py-8 text-center text-sm text-destructive">AO Cloud sign-in is not configured for this build.</p>
						) : !authenticated ? (
							<div className="py-8 text-center">
								<p className="text-sm text-[var(--color-text-import-muted)]">Finish signing in in your browser. This window will continue automatically.</p>
								<Button className="mt-4" onClick={() => cloudSession.signIn()} type="button" variant="outline">Open sign-in again</Button>
							</div>
						) : (
							<form className="space-y-4" onSubmit={(event) => void submit(event)}>
								<label className="block space-y-1.5 text-sm font-medium">
									Git repository
									<input
										className="h-10 w-full rounded-lg border border-border bg-background px-3 font-normal"
										onChange={(event) => {
											const repositoryUrl = event.target.value;
											setForm((current) => ({
												...current,
												repositoryUrl,
												displayName: nameTouched.current ? current.displayName : repositoryName(repositoryUrl),
											}));
										}}
										placeholder="https://github.com/org/repository.git"
										required
										type="url"
										value={form.repositoryUrl}
									/>
								</label>
								<div className="grid grid-cols-[minmax(0,1fr)_140px] gap-3">
									<label className="block space-y-1.5 text-sm font-medium">
										Project name
										<input className="h-10 w-full rounded-lg border border-border bg-background px-3 font-normal" onChange={(event) => { nameTouched.current = true; setForm((current) => ({ ...current, displayName: event.target.value })); }} required value={form.displayName} />
									</label>
									<label className="block space-y-1.5 text-sm font-medium">
										Default branch
										<input className="h-10 w-full rounded-lg border border-border bg-background px-3 font-normal" onChange={(event) => setForm((current) => ({ ...current, defaultBranch: event.target.value }))} required value={form.defaultBranch} />
									</label>
								</div>
								<label className="block space-y-1.5 text-sm font-medium">
									<span className="flex items-center justify-between gap-3">
										Agent subscription
										{selectedConnection?.connected ? (
											<button className="text-xs font-normal text-muted-foreground underline-offset-2 hover:underline" disabled={disconnecting || creating} onClick={() => void disconnect()} type="button">
												{disconnecting ? "Disconnecting…" : "Disconnect Cloud login"}
											</button>
										) : null}
									</span>
									<select className="h-10 w-full rounded-lg border border-border bg-background px-3 font-normal" onChange={(event) => setHarness(event.target.value as CloudHarness)} value={harness}>
										<option value="claude-code">Claude Code</option>
										<option value="codex">Codex</option>
									</select>
								</label>
								{error ? <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="status">{error}</p> : null}
								<div className="border-t border-border pt-4">
									<Button className="w-full" disabled={!canSubmit} type="submit">
										{creating ? <><LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> Creating Cloud project…</> : "Create project"}
									</Button>
									<p className="mt-2 text-center text-xs leading-5 text-[var(--color-text-import-muted)]">
										By creating, you allow AO to securely copy your local {harness === "claude-code" ? "Claude Code" : "Codex"} login to your Cloud account. The credential never enters the renderer.
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
