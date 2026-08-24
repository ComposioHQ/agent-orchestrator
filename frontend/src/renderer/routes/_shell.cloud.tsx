import { createFileRoute } from "@tanstack/react-router";
import { Check, Cloud, LoaderCircle, RefreshCw, Server, Unplug } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import type {
	CloudBetaOverview,
	CloudHarness,
	CreateCloudProjectInput,
	CreateCloudSessionInput,
} from "../../shared/cloud-beta";
import { useCloudSession } from "../lib/cloud-session";
import { aoBridge } from "../lib/bridge";
import { cn } from "../lib/utils";

export const Route = createFileRoute("/_shell/cloud")({ component: CloudBetaPage });

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "AO Cloud could not complete that request.";
}

function CloudBetaPage() {
	const cloudSession = useCloudSession();
	const [enabled, setEnabled] = useState(false);
	const [overview, setOverview] = useState<CloudBetaOverview | null>(null);
	const [selectedProjectId, setSelectedProjectId] = useState("");
	const [loading, setLoading] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [projectForm, setProjectForm] = useState<CreateCloudProjectInput>({
		displayName: "",
		repositoryUrl: "",
		defaultBranch: "main",
	});
	const [sessionForm, setSessionForm] = useState<Omit<CreateCloudSessionInput, "orgId" | "projectId">>({
		kind: "orchestrator",
		harness: "claude-code",
		displayName: "Cloud orchestrator",
		prompt: "",
	});

	const refresh = useCallback(async () => {
		if (cloudSession.status !== "authenticated") return;
		setLoading(true);
		setError(null);
		try {
			const next = await aoBridge.cloud.getOverview();
			setOverview(next);
			setSelectedProjectId((current) =>
				current && next.projects.some((project) => project.id === current)
					? current
					: (next.projects[0]?.id ?? ""),
			);
		} catch (loadError) {
			setError(errorMessage(loadError));
		} finally {
			setLoading(false);
		}
	}, [cloudSession.status]);

	useEffect(() => {
		void aoBridge.cloud.isBetaEnabled().then(setEnabled);
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const selectedProject = overview?.projects.find((project) => project.id === selectedProjectId);
	const projectSessions = useMemo(
		() => overview?.sessions.filter((session) => session.projectId === selectedProjectId) ?? [],
		[overview?.sessions, selectedProjectId],
	);

	const connectHarness = async (harness: CloudHarness) => {
		setBusy(`connect-${harness}`);
		setError(null);
		try {
			await aoBridge.cloud.connectLocalHarness(harness);
			await refresh();
		} catch (connectError) {
			setError(errorMessage(connectError));
		} finally {
			setBusy(null);
		}
	};

	const disconnectHarness = async (harness: CloudHarness) => {
		setBusy(`disconnect-${harness}`);
		setError(null);
		try {
			await aoBridge.cloud.disconnectHarness(harness);
			await refresh();
		} catch (disconnectError) {
			setError(errorMessage(disconnectError));
		} finally {
			setBusy(null);
		}
	};

	const submitProject = async (event: FormEvent) => {
		event.preventDefault();
		if (!overview) return;
		setBusy("project");
		setError(null);
		try {
			const project = await aoBridge.cloud.createProject(overview.organization.id, projectForm);
			await refresh();
			setSelectedProjectId(project.id);
			setProjectForm({ displayName: "", repositoryUrl: "", defaultBranch: "main" });
		} catch (createError) {
			setError(errorMessage(createError));
		} finally {
			setBusy(null);
		}
	};

	const submitSession = async (event: FormEvent) => {
		event.preventDefault();
		if (!overview || !selectedProject) return;
		setBusy("session");
		setError(null);
		try {
			await aoBridge.cloud.createSession({
				...sessionForm,
				orgId: overview.organization.id,
				projectId: selectedProject.id,
			});
			setSessionForm((current) => ({ ...current, prompt: "" }));
			await refresh();
		} catch (createError) {
			setError(errorMessage(createError));
		} finally {
			setBusy(null);
		}
	};

	if (!enabled) {
		return <div className="p-8 text-sm text-muted-foreground">AO Cloud beta is disabled for this build.</div>;
	}

	if (cloudSession.status !== "authenticated") {
		return (
			<div className="flex h-full items-center justify-center p-8">
				<div className="w-full max-w-md rounded-xl border border-border bg-surface p-6 shadow-sm">
					<div className="mb-4 grid size-10 place-items-center rounded-lg bg-accent/10 text-accent"><Cloud /></div>
					<h1 className="text-xl font-semibold">AO Cloud beta</h1>
					<p className="mt-2 text-sm leading-6 text-muted-foreground">
						Sign in once. AO will reuse your local Claude Code or Codex subscription and run each session in its own Cloud sandbox.
					</p>
					<button className="mt-5 h-9 rounded-lg bg-foreground px-4 text-sm font-medium text-background" onClick={() => cloudSession.signIn()} type="button">
						Sign in to AO Cloud
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="h-full overflow-y-auto bg-background">
			<div className="mx-auto flex max-w-6xl flex-col gap-6 p-7">
				<header className="flex items-start justify-between gap-4 border-b border-border pb-5">
					<div>
						<div className="flex items-center gap-2"><Cloud className="size-5" /><h1 className="text-xl font-semibold">AO Cloud <span className="rounded bg-accent/10 px-1.5 py-0.5 text-xs font-medium text-accent">Beta</span></h1></div>
					<p className="mt-1 text-sm text-muted-foreground">{overview?.organization.displayName ?? "Loading organization…"} · projects are entirely Cloud or entirely local</p>
				</div>
				<div className="flex gap-2">
					<button className="grid size-9 place-items-center rounded-lg border border-border hover:bg-interactive-hover" disabled={loading} onClick={() => void refresh()} type="button" aria-label="Refresh Cloud projects"><RefreshCw className={cn("size-4", loading && "animate-spin")} /></button>
					<button className="h-9 rounded-lg border border-border px-3 text-sm hover:bg-interactive-hover" onClick={() => void cloudSession.signOut()} type="button">Sign out</button>
				</div>
			</header>

			{error ? <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{error}</div> : null}

			<section>
				<h2 className="text-sm font-semibold">1. Connect your local subscription</h2>
				<p className="mt-1 text-sm text-muted-foreground">One click securely copies the credential from the local harness auth store to your user-scoped encrypted AO Cloud connection.</p>
				<div className="mt-3 grid gap-3 sm:grid-cols-2">
					{(["claude-code", "codex"] as const).map((harness) => {
						const connection = overview?.harnesses.find((item) => item.harness === harness);
						const label = harness === "claude-code" ? "Claude Code" : "Codex";
						return <div className="flex items-center justify-between rounded-xl border border-border bg-surface p-4" key={harness}>
							<div><div className="flex items-center gap-2 text-sm font-medium">{connection?.connected ? <Check className="size-4 text-success" /> : <Unplug className="size-4 text-muted-foreground" />}{label}</div><p className="mt-1 text-xs text-muted-foreground">{connection?.connected ? `Connected · ${connection.credentialType ?? "subscription"}` : "Not connected"}</p></div>
							<button className="h-8 rounded-lg border border-border px-3 text-xs font-medium hover:bg-interactive-hover disabled:opacity-50" disabled={busy !== null} onClick={() => void (connection?.connected ? disconnectHarness(harness) : connectHarness(harness))} type="button">{busy === `connect-${harness}` ? "Connecting…" : busy === `disconnect-${harness}` ? "Disconnecting…" : connection?.connected ? "Disconnect" : "Use local login"}</button>
						</div>;
					})}
				</div>
			</section>

			<section className="grid gap-5 lg:grid-cols-[minmax(260px,0.8fr)_minmax(420px,1.5fr)]">
				<div className="rounded-xl border border-border bg-surface p-4">
					<h2 className="text-sm font-semibold">2. Cloud projects</h2>
					<div className="mt-3 space-y-2">
						{overview?.projects.map((project) => <button className={cn("w-full rounded-lg border px-3 py-2.5 text-left", selectedProjectId === project.id ? "border-accent bg-accent/5" : "border-border hover:bg-interactive-hover")} key={project.id} onClick={() => setSelectedProjectId(project.id)} type="button"><span className="flex items-center gap-2 text-sm font-medium"><Server className="size-4" />{project.displayName}</span><span className="mt-1 block truncate text-xs text-muted-foreground">Cloud · {project.repositoryUrl}</span></button>)}
						{overview && overview.projects.length === 0 ? <p className="text-sm text-muted-foreground">No Cloud projects yet.</p> : null}
					</div>
					<form className="mt-4 space-y-2 border-t border-border pt-4" onSubmit={(event) => void submitProject(event)}>
						<input className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm" onChange={(event) => setProjectForm((form) => ({ ...form, displayName: event.target.value }))} placeholder="Project name" required value={projectForm.displayName} />
						<input className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm" onChange={(event) => setProjectForm((form) => ({ ...form, repositoryUrl: event.target.value }))} placeholder="https://github.com/org/repo.git" required type="url" value={projectForm.repositoryUrl} />
						<input className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm" onChange={(event) => setProjectForm((form) => ({ ...form, defaultBranch: event.target.value }))} placeholder="Default branch" required value={projectForm.defaultBranch} />
						<button className="h-9 w-full rounded-lg bg-foreground text-sm font-medium text-background disabled:opacity-50" disabled={busy !== null} type="submit">{busy === "project" ? "Creating…" : "Create Cloud project"}</button>
					</form>
				</div>

				<div className="rounded-xl border border-border bg-surface p-4">
					<h2 className="text-sm font-semibold">3. Sessions{selectedProject ? ` · ${selectedProject.displayName}` : ""}</h2>
					<div className="mt-3 space-y-2">
						{projectSessions.map((session) => <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5" key={session.id}><div><p className="text-sm font-medium">{session.displayName}</p><p className="mt-1 text-xs text-muted-foreground">{session.kind} · {session.harness} · one isolated Cloud sandbox</p></div><span className={cn("rounded-full px-2 py-1 text-xs", session.runtimeConnected ? "bg-success/10 text-success" : "bg-muted text-muted-foreground")}>{session.runtimeConnected ? "ready" : session.runtimeState || session.status}</span></div>)}
						{selectedProject && projectSessions.length === 0 ? <p className="text-sm text-muted-foreground">No sessions in this Cloud project yet.</p> : null}
					</div>
					<form className="mt-4 grid gap-2 border-t border-border pt-4" onSubmit={(event) => void submitSession(event)}>
						<div className="grid grid-cols-2 gap-2"><select className="h-9 rounded-lg border border-border bg-background px-3 text-sm" onChange={(event) => setSessionForm((form) => ({ ...form, kind: event.target.value as "worker" | "orchestrator" }))} value={sessionForm.kind}><option value="orchestrator">Orchestrator</option><option value="worker">Worker</option></select><select className="h-9 rounded-lg border border-border bg-background px-3 text-sm" onChange={(event) => setSessionForm((form) => ({ ...form, harness: event.target.value as CloudHarness }))} value={sessionForm.harness}><option value="claude-code">Claude Code</option><option value="codex">Codex</option></select></div>
						<input className="h-9 rounded-lg border border-border bg-background px-3 text-sm" onChange={(event) => setSessionForm((form) => ({ ...form, displayName: event.target.value }))} placeholder="Session name" required value={sessionForm.displayName} />
						<textarea className="min-h-28 resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm" onChange={(event) => setSessionForm((form) => ({ ...form, prompt: event.target.value }))} placeholder="What should this session do?" required value={sessionForm.prompt} />
						<button className="flex h-9 items-center justify-center gap-2 rounded-lg bg-foreground text-sm font-medium text-background disabled:opacity-50" disabled={busy !== null || !selectedProject} type="submit">{busy === "session" ? <><LoaderCircle className="size-4 animate-spin" />Provisioning sandbox…</> : "Create session in Cloud"}</button>
						<p className="text-xs text-muted-foreground">The create request waits for the sandbox worker to be ready. No background reconciler is used in this beta.</p>
					</form>
				</div>
			</section>
		</div>
	</div>
);
}
