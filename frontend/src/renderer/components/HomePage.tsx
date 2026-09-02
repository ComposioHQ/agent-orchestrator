import type { ProjectSource } from "@aoagents/product-ui";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Folder, Folders, FolderOpen, GitFork, Star } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { aoBridge } from "../lib/bridge";
import { useShell } from "../lib/shell-context";
import { useWorkspaceQuery } from "../hooks/useWorkspaceQuery";
import type { WorkspaceSummary } from "../types/workspace";
import { BoardWelcome } from "./BoardEmptyStates";
import { CreateProjectFlow } from "./CreateProjectFlow";
import { TopbarButton } from "./TopbarButton";

const GITHUB_REPOSITORY_URL = "https://github.com/Untrivial-ai/agent-orchestrator";
const RECENT_PROJECT_LIMIT = 3;

function latestProjectTimestamp(project: WorkspaceSummary): string {
	return project.sessions.reduce((latest, session) => (session.updatedAt > latest ? session.updatedAt : latest), "");
}

function sortProjectsByActivity(projects: WorkspaceSummary[]): WorkspaceSummary[] {
	return projects
		.slice()
		.sort((left, right) => latestProjectTimestamp(right).localeCompare(latestProjectTimestamp(left)));
}

function ProjectRow({ project, onClick }: { project: WorkspaceSummary; onClick: () => void }) {
	return (
		<button
			className="group flex w-full items-center gap-3 rounded-md p-3 text-left text-foreground/75 hover:bg-interactive-hover hover:text-foreground"
			onClick={onClick}
			type="button"
		>
			<span className="grid size-6 shrink-0 place-items-center text-foreground/65 group-hover:text-foreground" aria-hidden="true">
				<Folder className="size-5" strokeWidth={1.8} />
			</span>
			<span className="min-w-0 text-[16px] leading-tight tracking-[-0.01em]">
				<span className="block truncate text-foreground">{project.name}</span>
				<span className="mt-1 block truncate text-sm text-muted-foreground">{project.path}</span>
			</span>
			<span className="ml-auto shrink-0 self-center text-sm text-muted-foreground">
				{project.sessions.length} {project.sessions.length === 1 ? "session" : "sessions"}
			</span>
		</button>
	);
}

function HomeActionCard({
	ariaLabel,
	disabled,
	icon,
	label,
	onClick,
}: {
	ariaLabel: string;
	disabled?: boolean;
	icon: ReactNode;
	label: string;
	onClick?: () => void;
}) {
	return (
		<button
			aria-label={ariaLabel}
			className="flex w-full items-center gap-3 rounded-welcome-panel bg-[var(--color-bg-import-card)] px-4 py-3 text-left transition-colors hover:bg-[var(--color-bg-import-card-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50"
			disabled={disabled}
			onClick={onClick}
			type="button"
		>
			<span className="grid size-8 shrink-0 place-items-center rounded-lg bg-[color-mix(in_srgb,var(--color-bg-import-chip)_60%,transparent)] text-[var(--color-text-import-muted)]">
				{icon}
			</span>
			<span className="min-w-0 text-[14px] font-medium leading-5 text-[var(--color-text-import-title)]">{label}</span>
		</button>
	);
}

function HomeProjectSection({
	label,
	projects,
	onOpenProject,
}: {
	label: string;
	projects: WorkspaceSummary[];
	onOpenProject: (projectId: string) => void;
}) {
	if (projects.length === 0) return null;

	return (
		<section className="space-y-1">
			<h2 className="px-3 text-sm font-medium text-muted-foreground">{label}</h2>
			<div className="space-y-1">
				{projects.map((project) => (
					<ProjectRow
						key={project.id}
						project={project}
						onClick={() => onOpenProject(project.id)}
					/>
				))}
			</div>
		</section>
	);
}

export function HomePage() {
	const navigate = useNavigate();
	const { t } = useTranslation();
	const { cloneProject, createProject, initializeProjectRepository } = useShell();
	const workspaceQuery = useWorkspaceQuery();
	const [sourceSignal, setSourceSignal] = useState<{ source: ProjectSource; nonce: number } | null>(null);

	const projects = workspaceQuery.data ?? [];
	const { recentProjects, currentProjects } = useMemo(() => {
		const sortedByActivity = sortProjectsByActivity(projects);
		const recent = sortedByActivity.slice(0, RECENT_PROJECT_LIMIT);
		const recentIds = new Set(recent.map((project) => project.id));
		const current = projects
			.filter((project) => !recentIds.has(project.id))
			.sort((left, right) => left.name.localeCompare(right.name));
		return { recentProjects: recent, currentProjects: current };
	}, [projects]);

	const requestSource = (source: ProjectSource) => {
		setSourceSignal({ source, nonce: Date.now() });
	};

	const openProject = (projectId: string) => {
		void navigate({ to: "/projects/$projectId", params: { projectId } });
	};

	if (workspaceQuery.isSuccess && projects.length === 0) return <BoardWelcome />;

	return (
		<div className="flex min-h-full items-center justify-center px-6 py-16">
			<div className="w-full max-w-[640px] -translate-y-3">
				<div className="space-y-6">
					<div className="flex items-center justify-between gap-4 px-3">
						<h1 className="text-[17px] font-medium tracking-[-0.01em] text-foreground/80">{t("home.jumpBack")}</h1>
						<TopbarButton
							className="shrink-0 font-mono text-[15px] tracking-[0.03em] transition-[transform,filter,background,color,border-color] duration-150 ease-out active:scale-[0.96] motion-reduce:transform-none"
							onClick={() => void aoBridge.app.openExternal(`${GITHUB_REPOSITORY_URL}/stargazers`)}
							variant="accent"
						>
							<Star className="size-4" strokeWidth={1.8} aria-hidden="true" />
							{t("home.starUs")}
						</TopbarButton>
					</div>

					<div className="grid grid-cols-2 gap-3 px-3">
						<HomeActionCard
							ariaLabel={t("createProject.cloneFromGit")}
							icon={<GitFork className="size-4" aria-hidden="true" />}
							label={t("createProject.cloneFromGit")}
							onClick={() => requestSource("clone")}
						/>
						<HomeActionCard
							ariaLabel={t("createProject.openLocal")}
							icon={<FolderOpen className="size-4" aria-hidden="true" />}
							label={t("createProject.openLocal")}
							onClick={() => requestSource("local")}
						/>
						<HomeActionCard
							ariaLabel={t("createProject.addWorkspace")}
							icon={<Folders className="size-4" aria-hidden="true" />}
							label={t("createProject.addWorkspace")}
							onClick={() => requestSource("workspace")}
						/>
						<div
							aria-hidden="true"
							className="rounded-welcome-panel bg-[var(--color-bg-import-card)] px-4 py-3 opacity-50"
						/>
					</div>

					<HomeProjectSection label={t("home.recentProjects")} projects={recentProjects} onOpenProject={openProject} />
					<HomeProjectSection label={t("home.currentProjects")} projects={currentProjects} onOpenProject={openProject} />
				</div>

				<CreateProjectFlow
					mode="choose"
					onCloneProject={cloneProject}
					onCreateProject={createProject}
					onInitializeProject={initializeProjectRepository}
					sourceSignal={sourceSignal}
				/>
			</div>
		</div>
	);
}
