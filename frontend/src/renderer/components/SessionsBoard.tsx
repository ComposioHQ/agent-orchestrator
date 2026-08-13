import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { SessionsArchiveView, SessionsBoardGridView } from "@aoagents/product-ui";
import { AlertTriangle, Plus, RotateCw } from "lucide-react";
import {
	type WorkspaceSession,
	hasConfiguredOrchestratorAgent,
	newestActiveOrchestrator,
	orchestratorHealth,
	workerSessions,
} from "../types/workspace";
import {
	boardAttentionZoneOrder,
	getAgentActivityView,
	getAttentionZoneViewForZone,
	type AttentionZoneView,
} from "../lib/session-presentation";
import {
	useSessionUsageSummaries,
	type SessionUsageSummary,
} from "../hooks/useSessionUsageSummaries";
import { useRestoreSession } from "../hooks/useRestoreSession";
import { useTerminateSession } from "../hooks/useTerminateSession";
import { useWorkspaceQuery, workspaceQueryKey } from "../hooks/useWorkspaceQuery";
import { NotificationCenter } from "./NotificationCenter";
import { BoardWelcome, ProjectBoardEmpty } from "./BoardEmptyStates";
import { OrchestratorIcon } from "./icons";
import { OrchestratorActivityIndicator } from "./OrchestratorActivityIndicator";
import { TopbarButton, TopbarKillError, topbarProjectLabelClass } from "./TopbarButton";
import { isChatPreflightError, spawnOrchestrator } from "../lib/spawn-orchestrator";
import { restartProjectOrchestrator } from "../lib/restart-orchestrator";
import { usesPreviewWorkspaceData } from "../lib/preview-mode";
import { isLinuxPlatform, isMacPlatform, usesBoardActionsInPanel } from "../lib/platform";
import { useUiStore } from "../stores/ui-store";
import { RestoreUnavailableDialog } from "./RestoreUnavailableDialog";
import { DaemonStartupLoader } from "./DaemonStartupLoader";
import { useShellMaybe } from "../lib/shell-context";
import {
	ArchivedSessionCardAdapter,
	BoardSessionCardAdapter,
	sessionsBoardLabels,
} from "./SessionsBoardAdapters";

type SessionsBoardProps = {
	/** When set, the board shows only this project's sessions. */
	projectId?: string;
};

type UsageBySession = ReadonlyMap<string, SessionUsageSummary>;
const emptyUsageBySession: UsageBySession = new Map();

// Live merged sessions remain in-flow. A terminated runtime is archived even
// when its SCM outcome remains `merged`.
function isArchivedSession(session: WorkspaceSession): boolean {
	return session.isTerminated === true || session.status === "terminated";
}

const isMac = isMacPlatform();
const dragStyle = isMac ? ({ WebkitAppRegion: "drag" } as React.CSSProperties) : undefined;
const noDragStyle = isMac ? ({ WebkitAppRegion: "no-drag" } as React.CSSProperties) : undefined;

export function SessionsBoard({ projectId }: SessionsBoardProps) {
	const { t } = useTranslation();
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const columns: AttentionZoneView[] = boardAttentionZoneOrder.map((zone) => getAttentionZoneViewForZone(zone, t));
	const restoreSessionById = useRestoreSession();
	const workspaceQuery = useWorkspaceQuery();
	const shell = useShellMaybe();
	const usageBySession = useSessionUsageSummaries(projectId).data ?? emptyUsageBySession;
	// Evaluated at render so platform mocks in tests can flip the in-panel chrome.
	const boardActionsInPanel = usesBoardActionsInPanel();
	/** Bell lives in the board action row when the shell topbar does not host it. */
	const boardOwnsNotificationCenter = isLinuxPlatform() || boardActionsInPanel;
	const all = workspaceQuery.data ?? [];
	const workspaces = projectId ? all.filter((workspace) => workspace.id === projectId) : all;
	const workspace = projectId ? workspaces[0] : undefined;
	// Same crumb as ShellTopbar: project name in scope, else root-board "Board".
	const boardLabel = workspace?.name ?? (projectId ? "" : t("shell.board"));
	const sessions = workspaces.flatMap((workspace) => workerSessions(workspace.sessions));
	const orchestrator = projectId ? newestActiveOrchestrator(workspaces[0]?.sessions ?? []) : undefined;
	const orchestratorActivityLabel = orchestrator ? getAgentActivityView(orchestrator.activity, t).label : undefined;
	const [isSpawning, setIsSpawning] = useState(false);
	const [spawnError, setSpawnError] = useState<string | null>(null);
	const [canCreateAsTui, setCanCreateAsTui] = useState(false);
	const restartingProjectIds = useUiStore((state) => state.restartingProjectIds);
	const orchestratorStartupError = useUiStore((state) =>
		projectId ? (state.orchestratorStartupErrors[projectId] ?? null) : null,
	);
	const setProjectRestarting = useUiStore((state) => state.setProjectRestarting);
	const setOrchestratorReplacementError = useUiStore((state) => state.setOrchestratorReplacementError);
	const setOrchestratorStartupError = useUiStore((state) => state.setOrchestratorStartupError);
	const requestNewTask = useUiStore((state) => state.requestNewTask);
	const isProjectRestarting = projectId ? restartingProjectIds.has(projectId) : false;
	const health = workspace ? orchestratorHealth(workspace, isProjectRestarting) : { state: "ok" as const };
	const visibleSpawnError = spawnError ?? orchestratorStartupError;

	// The board instance survives project-to-project navigation (same route,
	// new param), so a spawn failure must not follow the user to another board.
	useEffect(() => {
		setSpawnError(null);
		setCanCreateAsTui(false);
	}, [projectId]);
	const previousProjectIdRef = useRef(projectId);
	useEffect(() => {
		const previousProjectId = previousProjectIdRef.current;
		if (previousProjectId && previousProjectId !== projectId) {
			setOrchestratorStartupError(previousProjectId, null);
		}
		previousProjectIdRef.current = projectId;
	}, [projectId, setOrchestratorStartupError]);
	useEffect(() => {
		if (projectId && orchestrator && orchestratorStartupError) {
			setOrchestratorStartupError(projectId, null);
		}
	}, [orchestrator, orchestratorStartupError, projectId, setOrchestratorStartupError]);

	const archived = sessions
		.filter(isArchivedSession)
		.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	const activeSessions = sessions.filter((candidate) => !isArchivedSession(candidate));
	const boardLabels = sessionsBoardLabels(t);
	// First-run orientation replaces the empty column shells (only once the
	// query has resolved, so the welcome never flashes over real data): the
	// global board teaches the app before any project exists, and a fresh
	// project board invites the first task instead of showing four zeros.
	const isDaemonReady = usesPreviewWorkspaceData || (shell ? shell.daemonStatus.state === "ready" : true);
	const daemonHasFailed = Boolean(shell?.daemonStatus.code);
	const workspaceStartupState = shell?.workspaceStartupState ?? "ready";
	const isLoaded = isDaemonReady && workspaceStartupState === "ready" && workspaceQuery.isSuccess;
	const showStartup =
		shell !== null &&
		!daemonHasFailed &&
		(!isDaemonReady || workspaceStartupState === "loading" || (!workspaceQuery.isSuccess && !workspaceQuery.isError));
	const showWelcome = !projectId && isLoaded && all.length === 0;
	const showProjectEmpty = projectId !== undefined && isLoaded && workspaces.length > 0 && sessions.length === 0;
	// Archived sessions cost one quiet line under the board until expanded.
	const [archiveExpanded, setArchiveExpanded] = useState(false);
	const [restoringSessionId, setRestoringSessionId] = useState<string | undefined>();
	const [restoreErrors, setRestoreErrors] = useState<Record<string, string>>({});
	const [restoreUnavailableSession, setRestoreUnavailableSession] = useState<WorkspaceSession | undefined>();
	const terminateSession = useTerminateSession();
	const activeProjectIdRef = useRef(projectId);
	activeProjectIdRef.current = projectId;
	useEffect(() => {
		setRestoringSessionId(undefined);
		setRestoreErrors({});
		setRestoreUnavailableSession(undefined);
	}, [projectId]);

	const openSession = (session: WorkspaceSession) =>
		void navigate({
			to: "/projects/$projectId/sessions/$sessionId",
			params: { projectId: session.workspaceId, sessionId: session.id },
		});

	const restoreArchivedSession = async (event: MouseEvent<HTMLButtonElement>, session: WorkspaceSession) => {
		event.stopPropagation();
		if (restoringSessionId) return;
		const restoreProjectId = projectId;
		const isStillActiveProject = () => !restoreProjectId || activeProjectIdRef.current === restoreProjectId;
		setRestoringSessionId(session.id);
		setRestoreErrors((current) => {
			const next = { ...current };
			delete next[session.id];
			return next;
		});
		try {
			const result = await restoreSessionById(session.id);
			if (!isStillActiveProject()) return;
			if (result.status === "success") {
				void navigate({
					to: "/projects/$projectId/sessions/$sessionId",
					params: { projectId: session.workspaceId, sessionId: session.id },
				});
				return;
			}
			if (result.status === "not_resumable") {
				setRestoreUnavailableSession(session);
				return;
			}
			setRestoreErrors((current) => ({ ...current, [session.id]: result.message }));
		} finally {
			if (isStillActiveProject()) {
				setRestoringSessionId(undefined);
			}
		}
	};

	const openOrchestrator = async (mode?: "tui") => {
		if (!projectId || isProjectRestarting) return;
		if (orchestrator) {
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId, sessionId: orchestrator.id },
			});
			return;
		}
		if (!hasConfiguredOrchestratorAgent(workspace)) {
			if (workspace) {
				useUiStore.getState().openProjectSettings(projectId);
			}
			return;
		}
		setSpawnError(null);
		setCanCreateAsTui(false);
		setOrchestratorStartupError(projectId, null);
		setIsSpawning(true);
		try {
			const sessionId = await spawnOrchestrator(projectId, "board", false, mode);
			await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
			setOrchestratorStartupError(projectId, null);
			void navigate({
				to: "/projects/$projectId/sessions/$sessionId",
				params: { projectId, sessionId },
			});
		} catch (error) {
			// Never fail silently: the daemon's message (e.g. a worktree/branch
			// conflict) is the only actionable signal the user gets.
			console.error("Failed to spawn orchestrator:", error);
			setSpawnError(error instanceof Error ? error.message : t("shell.couldNotSpawn"));
			setCanCreateAsTui(isChatPreflightError(error));
		} finally {
			setIsSpawning(false);
		}
	};

	const restartOrchestrator = async () => {
		if (!projectId) return;
		await restartProjectOrchestrator({
			projectId,
			queryClient,
			navigate,
			setProjectRestarting,
			setOrchestratorReplacementError,
		});
	};

	const actions = projectId ? (
		<>
			{visibleSpawnError && !showProjectEmpty && (
				<TopbarKillError className="max-w-content-max truncate" title={visibleSpawnError}>
					{visibleSpawnError}
				</TopbarKillError>
			)}
			{visibleSpawnError && canCreateAsTui && !showProjectEmpty ? (
				<TopbarButton disabled={isSpawning || isProjectRestarting} onClick={() => void openOrchestrator("tui")}>
					{t("newTask.createAsTui")}
				</TopbarButton>
			) : null}
			<TopbarButton
				aria-label={t("shell.newTask")}
				disabled={isProjectRestarting}
				onClick={() => projectId && requestNewTask(projectId)}
				variant="accent"
			>
				<Plus className="size-icon-md" aria-hidden="true" />
				{t("shell.newTask")}
			</TopbarButton>
			<TopbarButton
				aria-label={
					orchestratorActivityLabel
						? t("shell.orchestratorWithActivity", { activity: orchestratorActivityLabel })
						: t("shell.spawnOrchestrator")
				}
				disabled={isSpawning || isProjectRestarting}
				onClick={() => void openOrchestrator()}
				variant="primary"
			>
				<OrchestratorIcon className="size-icon-md" aria-hidden="true" />
				{orchestrator ? <OrchestratorActivityIndicator session={orchestrator} /> : null}
				{isProjectRestarting
					? t("shell.restartingDots")
					: isSpawning
						? t("shell.spawningDots")
						: orchestrator
							? t("shell.orchestrator")
							: t("shell.spawnOrchestrator")}
			</TopbarButton>
			{boardOwnsNotificationCenter ? <NotificationCenter /> : null}
		</>
	) : boardOwnsNotificationCenter ? (
		<NotificationCenter />
	) : undefined;

	return (
		<div className="flex h-full min-h-0 flex-col bg-background text-foreground" data-testid="board">
			{/* macOS: shell topbar is hidden on board routes, so the project/"Board"
			    crumb + New task / Orchestrator / bell live in this in-panel row.
			    Win/Linux keep the crumb and actions in the framed ShellTopbar.
			    Welcome skips the row — a dangling "Board" above the import
			    chooser was review feedback on #2432. */}
			{!showWelcome && !showStartup && boardActionsInPanel && (boardLabel || actions) ? (
				<div
					className="center-panel-titlebar flex h-toolbar shrink-0 items-center gap-2 border-b border-border-strong pr-4"
					style={dragStyle}
				>
					{boardLabel ? <span className={topbarProjectLabelClass}>{boardLabel}</span> : null}
					<div className="min-w-0 flex-1" />
					{actions ? (
						<div className="flex shrink-0 items-center gap-2" style={noDragStyle}>
							{actions}
						</div>
					) : null}
				</div>
			) : null}

			<div className="min-h-0 flex-1 overflow-hidden">
				{projectId && health.state !== "ok" ? (
					<div className="mx-3 my-3 flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-xs text-muted-foreground">
						<AlertTriangle className="size-icon-base shrink-0 text-warning" aria-hidden="true" />
						<span className="min-w-0 flex-1">{health.message}</span>
						{health.state === "restart_needed" || health.state === "duplicates" ? (
							<TopbarButton disabled={isProjectRestarting} onClick={() => void restartOrchestrator()} variant="primary">
								<RotateCw className="size-3.5" aria-hidden="true" />
								{t("shell.restart")}
							</TopbarButton>
						) : null}
					</div>
				) : null}
				{showStartup ? (
					<DaemonStartupLoader />
				) : workspaceStartupState === "error" || workspaceQuery.isError ? (
					<p className="py-10 text-center text-xs text-passive">{t("shell.couldNotLoadSessions")}</p>
				) : showWelcome ? (
					<BoardWelcome />
				) : showProjectEmpty ? (
					<ProjectBoardEmpty
						hasOrchestrator={orchestrator !== undefined}
						isSpawning={isSpawning}
						isProjectRestarting={isProjectRestarting}
						onNewTask={() => projectId && requestNewTask(projectId)}
						onOpenOrchestrator={() => void openOrchestrator()}
						onOpenOrchestratorAsTui={canCreateAsTui ? () => void openOrchestrator("tui") : undefined}
						spawnError={visibleSpawnError}
					/>
				) : (
					<SessionsBoardGridView
						columns={columns}
						key={projectId ?? "all"}
						labels={boardLabels}
						renderSessionCard={(session) => (
							<BoardSessionCardAdapter
								onOpen={() => openSession(session)}
								onTerminate={() => terminateSession.mutate(session)}
								session={session}
								usage={usageBySession.get(session.id)}
							/>
						)}
						sessions={activeSessions}
					/>
				)}
			</div>

			<SessionsArchiveView
				archiveExpanded={archiveExpanded}
				labels={{
					archive: t("shell.archive"),
					archiveAria: t("shell.archiveSessionsAria", { count: archived.length }),
					archivedSessions: t("shell.archivedSessions"),
				}}
				onArchiveExpandedChange={setArchiveExpanded}
				renderSessionCard={(session) => (
					<ArchivedSessionCardAdapter
						isRestoreDisabled={restoringSessionId !== undefined}
						isRestoring={restoringSessionId === session.id}
						restoreAction={(event) => void restoreArchivedSession(event, session)}
						restoreError={restoreErrors[session.id]}
						session={session}
						usage={usageBySession.get(session.id)}
					/>
				)}
				sessions={archived}
			/>
			{restoreUnavailableSession && (
				<RestoreUnavailableDialog
					open={true}
					session={restoreUnavailableSession}
					onOpenChange={(open) => {
						if (!open) setRestoreUnavailableSession(undefined);
					}}
					onRecreated={async () => {
						await queryClient.invalidateQueries({ queryKey: workspaceQueryKey });
					}}
				/>
			)}
		</div>
	);
}
