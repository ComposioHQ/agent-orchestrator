import * as Dialog from "@radix-ui/react-dialog";
import { Cloud, LoaderCircle, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type {
	CloudProjectOperation,
	CloudProjectSessionResult,
	CloudProjectSnapshot,
} from "../../shared/cloud-projects";
import { aoBridge } from "../lib/bridge";
import { useCloudSession } from "../lib/cloud-session";
import { Button } from "./ui/button";

const INITIAL_POLL_DELAY_MS = 500;
const MAX_POLL_DELAY_MS = 4_000;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "AO Cloud could not complete the request.";
}

export function CloudProjectFlow({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const cloud = useCloudSession();
	const [snapshot, setSnapshot] = useState<CloudProjectSnapshot | null>(null);
	const [listError, setListError] = useState<string | null>(null);
	const [createError, setCreateError] = useState<string | null>(null);
	const [pollError, setPollError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [creating, setCreating] = useState(false);
	const [startingSession, setStartingSession] = useState(false);
	const [sessionError, setSessionError] = useState<string | null>(null);
	const [sessionResult, setSessionResult] = useState<CloudProjectSessionResult | null>(null);
	const [watchPaused, setWatchPaused] = useState(false);
	const [operation, setOperation] = useState<CloudProjectOperation | null>(null);
	const [organizationId, setOrganizationId] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [repositoryUrl, setRepositoryUrl] = useState("");
	const [defaultBranch, setDefaultBranch] = useState("");
	const requestGeneration = useRef(0);

	const loadProjects = useCallback(async () => {
		const generation = ++requestGeneration.current;
		setLoading(true);
		setListError(null);
		try {
			const next = await aoBridge.cloud.listProjects();
			if (generation !== requestGeneration.current) return;
			setSnapshot(next);
			setOrganizationId((current) => current || next.groups[0]?.organization.id || "");
		} catch (error) {
			if (generation === requestGeneration.current) setListError(errorMessage(error));
		} finally {
			if (generation === requestGeneration.current) setLoading(false);
		}
	}, []);

	useEffect(() => {
		if (!open || cloud.status !== "authenticated") return;
		void loadProjects();
		return () => {
			requestGeneration.current += 1;
		};
	}, [cloud.status, loadProjects, open]);

	useEffect(() => {
		if (!open || operation?.state !== "pending" || watchPaused) return;
		let cancelled = false;
		let timer: number | undefined;
		let delay = INITIAL_POLL_DELAY_MS;
		const schedule = () => {
			timer = window.setTimeout(async () => {
				try {
					const next = await aoBridge.cloud.getProjectOperation({
						organizationId: operation.orgId,
						operationId: operation.operationId,
					});
					if (cancelled) return;
					setOperation(next);
					setPollError(null);
					if (next.state === "ready") {
						await loadProjects();
						return;
					}
					if (next.state === "failed") return;
					delay = Math.min(delay * 2, MAX_POLL_DELAY_MS);
					schedule();
				} catch (error) {
					if (cancelled) return;
					setPollError(errorMessage(error));
					setWatchPaused(true);
				}
			}, delay);
		};
		schedule();
		return () => {
			cancelled = true;
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [loadProjects, open, operation?.operationId, operation?.orgId, operation?.state, watchPaused]);

	const projects = useMemo(() => snapshot?.groups.flatMap((group) => group.projects) ?? [], [snapshot]);
	const readyProject = operation?.projectId ? projects.find((project) => project.id === operation.projectId) : undefined;

	const createProject = async (event: FormEvent) => {
		event.preventDefault();
		setCreateError(null);
		setPollError(null);
		setCreating(true);
		try {
			const next = await aoBridge.cloud.createProject({
				organizationId,
				displayName,
				repositoryUrl,
				defaultBranch,
			});
			setOperation(next);
			setWatchPaused(false);
			if (next.state === "ready") await loadProjects();
		} catch (error) {
			setCreateError(errorMessage(error));
		} finally {
			setCreating(false);
		}
	};

	const resetCreate = () => {
		setOperation(null);
		setCreateError(null);
		setPollError(null);
		setWatchPaused(false);
		setSessionError(null);
		setSessionResult(null);
	};

	const startSession = async () => {
		if (!operation?.projectId) return;
		setStartingSession(true);
		setSessionError(null);
		try {
			setSessionResult(await aoBridge.cloud.startProjectSession({
				organizationId: operation.orgId,
				projectId: operation.projectId,
			}));
		} catch (error) {
			setSessionError(errorMessage(error));
		} finally {
			setStartingSession(false);
		}
	};

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Overlay className="dialog-overlay data-[state=open]:animate-overlay-in" />
				<Dialog.Content className="fixed left-1/2 top-1/2 z-overlay flex max-h-[min(760px,calc(100svh-24px))] w-[min(680px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-welcome-panel border border-[var(--color-border-import-modal)] bg-[var(--color-bg-import-modal)] text-[var(--color-text-import-title)] shadow-[var(--shadow-import-modal)] data-[state=open]:animate-modal-in">
					<header className="flex items-start gap-3 border-b border-[var(--color-border-import-modal)] p-(--size-import-dialog-padding)">
						<span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent/15 text-accent-strong"><Cloud aria-hidden="true" className="size-5" /></span>
						<div className="min-w-0 flex-1">
							<Dialog.Title className="text-subtitle font-semibold">AO Cloud project</Dialog.Title>
							<Dialog.Description className="mt-1 text-sm text-muted-foreground">Create once, then access the project from any signed-in device.</Dialog.Description>
						</div>
						<Dialog.Close asChild><button type="button" aria-label="Close cloud project dialog" className="import-close-button"><X className="size-5" /></button></Dialog.Close>
					</header>

					<div className="min-h-0 overflow-y-auto p-(--size-import-dialog-padding)">
						{cloud.status !== "authenticated" ? (
							<div className="rounded-lg border border-[var(--color-border-import-modal)] bg-[var(--color-bg-import-card)] p-5">
								<p className="font-medium">Sign in to create an AO Cloud project.</p>
								<Button className="mt-4" type="button" onClick={cloud.signIn}>Sign in with Google</Button>
							</div>
						) : (
							<div className="space-y-6">
								<section aria-label="Cloud projects">
									<div className="flex items-center justify-between gap-3">
										<h3 className="text-sm font-semibold">Your cloud projects</h3>
										<Button type="button" variant="ghost" size="sm" disabled={loading} onClick={() => void loadProjects()}>
											<RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} /> Refresh
										</Button>
									</div>
									{listError ? <ActionError message={listError} action="Retry list" onAction={() => void loadProjects()} /> : null}
									{!listError && !loading && projects.length === 0 ? <p className="mt-3 text-sm text-muted-foreground">No cloud projects yet.</p> : null}
									{projects.length > 0 ? <ul className="mt-3 grid gap-2">{projects.map((project) => <li key={project.id} className="rounded-lg border border-[var(--color-border-import-modal)] bg-[var(--color-bg-import-card)] px-3 py-2"><span className="font-medium">{project.name}</span><span className="ml-2 text-xs text-muted-foreground">{project.kind}</span></li>)}</ul> : null}
								</section>

								{operation ? (
									<section className="rounded-lg border border-[var(--color-border-import-modal)] bg-[var(--color-bg-import-card)] p-4" aria-live="polite">
										{operation.state === "pending" ? <p className="flex items-center gap-2 font-medium"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />Provisioning {displayName || "project"} on <code>{operation.defaultBranch}</code>…</p> : null}
										{operation.state === "failed" ? <ActionError message={operation.failure?.message || "AO Cloud could not provision this project."} action="Try again" onAction={resetCreate} /> : null}
										{operation.state === "ready" ? <div><p className="font-medium text-success">{readyProject?.name || displayName || "Project"} is ready.</p><p className="mt-1 text-sm text-muted-foreground">Default branch: <code>{operation.defaultBranch}</code>. The project is ready for a sandbox session.</p></div> : null}
										{pollError ? <ActionError message={pollError} action="Retry status" onAction={() => { setPollError(null); setWatchPaused(false); }} /> : null}
										{operation.state === "pending" && !pollError ? <Button className="mt-3" type="button" variant="ghost" size="sm" onClick={() => setWatchPaused((paused) => !paused)}>{watchPaused ? "Resume status checks" : "Stop waiting"}</Button> : null}
										{sessionError ? <ActionError message={sessionError} action="Retry session" onAction={() => void startSession()} /> : null}
										{sessionResult ? <p className="mt-3 text-sm font-medium text-success" role="status">Sandbox session {sessionResult.session.id} started.</p> : null}
										{operation.state === "ready" ? <div className="mt-3 flex flex-wrap gap-2"><Button type="button" disabled={startingSession || Boolean(sessionResult)} onClick={() => void startSession()}>{startingSession ? "Starting…" : sessionResult ? "Session started" : "Start sandbox session"}</Button><Button type="button" variant="ghost" onClick={resetCreate}>Create another</Button></div> : null}
									</section>
								) : (
									<form className="grid gap-4" onSubmit={createProject}>
										<label className="grid gap-1.5 text-sm font-medium">Organization<select aria-label="Organization" className="h-10 rounded-md border border-input bg-background px-3" required value={organizationId} onChange={(event) => setOrganizationId(event.target.value)}>{(cloud.session?.organizations ?? []).map((organization) => <option key={organization.id} value={organization.id}>{organization.displayName}</option>)}</select></label>
										<label className="grid gap-1.5 text-sm font-medium">Project name<input aria-label="Project name" className="h-10 rounded-md border border-input bg-background px-3" required value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
										<label className="grid gap-1.5 text-sm font-medium">Repository URL<input aria-label="Repository URL" className="h-10 rounded-md border border-input bg-background px-3 font-mono text-sm" type="url" required placeholder="https://github.com/acme/app.git" value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} /></label>
										<label className="grid gap-1.5 text-sm font-medium">Default branch<input aria-label="Default branch" className="h-10 rounded-md border border-input bg-background px-3 font-mono text-sm" required placeholder="release/2026" value={defaultBranch} onChange={(event) => setDefaultBranch(event.target.value)} /></label>
										{createError ? <ActionError message={createError} action="Retry create" onAction={() => setCreateError(null)} /> : null}
										<div className="flex justify-end"><Button type="submit" disabled={creating || loading || !organizationId}>{creating ? "Creating…" : "Create cloud project"}</Button></div>
									</form>
								)}
							</div>
						)}
					</div>
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

function ActionError({ message, action, onAction }: { message: string; action: string; onAction: () => void }) {
	return <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert"><span>{message}</span><button type="button" className="shrink-0 font-medium underline underline-offset-2" onClick={onAction}>{action}</button></div>;
}
