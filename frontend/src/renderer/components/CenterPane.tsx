import { ArrowRight, Maximize2, Minimize2, Minus, Plus, TriangleAlert } from "lucide-react";
import { Reorder, useDragControls } from "motion/react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type PointerEvent,
	type ReactNode,
	type WheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { defaultShortcutBindings, shortcutBindingLabel } from "../../shared/shortcuts";
import { useOverflowScroll } from "../hooks/useOverflowScroll";
import {
	findActiveAgentSwitch,
	findRecoveryRequiredAgentSwitch,
	useAgentSwitches,
} from "../hooks/useAgentSwitches";
import { useSwitchAgentState } from "../hooks/useSwitchAgent";
import { useTruncatedText } from "../hooks/useTruncatedText";
import type { ShellTerminal } from "../hooks/useShellTerminals";
import { TERMINAL_FONT_SIZE_DEFAULT, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from "../lib/design-tokens";
import { getAgentActivityView } from "../lib/session-presentation";
import { agentLabel } from "../lib/agent-options";
import { isLinuxPlatform, isMacPlatform } from "../lib/platform";
import { aoBridge } from "../lib/bridge";
import { handleTerminalTabListKeyDown } from "../lib/terminal-tabs";
import { cn } from "../lib/utils";
import { useUiStore, type Theme } from "../stores/ui-store";
import type { TerminalTarget } from "../types/terminal";
import { isOrchestratorSession, type WorkspaceSession } from "../types/workspace";
import { AgentAvatar } from "./AgentAvatar";
import { ShellTerminalTab } from "./ShellTerminalTab";
import { TerminalPane } from "./TerminalPane";
import { SessionTopbarPortal } from "./SessionTopbarPortal";
import { TerminalSwitchAgentButton } from "./TerminalSwitchAgentButton";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type CenterPaneProps = {
	session?: WorkspaceSession;
	theme: Theme;
	daemonReady: boolean;
	terminalTarget?: TerminalTarget;
	reviewerTerminal?: { handleId: string; harness: string };
	onSelectReviewerTerminal?: (target: { handleId: string; harness: string }) => void;
	/** Standalone shells to render as tabs beside the session's own pane. */
	shellTerminals?: ShellTerminal[];
	onSelectSessionTerminal?: () => void;
	onSelectShellTerminal?: (handleId: string) => void;
	onCloseShellTerminal?: (handleId: string) => void;
	onRenameShellTerminal?: (handleId: string, title: string) => void;
	/** Opens a new shell tab in this session's worktree (the button at the end of the tab bar). */
	onNewShellTerminal?: () => void;
	/** Session actions consolidated into the terminal bar by SessionView. */
	topbarActions?: ReactNode;
	/** Stop forwarding the agent pane's keystrokes while its controller drains. */
	agentInputDisabled?: boolean;
};

const terminalFontSizeStorageKey = "ao.terminal.fontSize";
const WHEEL_ZOOM_THRESHOLD = 80;
const WHEEL_ZOOM_RESET_MS = 250;
const isMac = isMacPlatform();
const isLinux = isLinuxPlatform();
const newTerminalShortcutLabel = shortcutBindingLabel(defaultShortcutBindings("new-shell-terminal", isMac)[0], isMac);

function DraggableShellTerminal({ children, value }: { children: ReactNode; value: string }) {
	const dragControls = useDragControls();
	const startDrag = (event: PointerEvent<HTMLDivElement>) => {
		if ((event.target as HTMLElement).closest("[data-terminal-tab-action],input,a")) return;
		dragControls.start(event);
	};

	return (
		<Reorder.Item
			as="div"
			className="flex shrink-0 self-stretch touch-pan-y"
			data-terminal-tab-key={value}
			drag="x"
			dragControls={dragControls}
			dragListener={false}
			onPointerDown={startDrag}
			value={value}
		>
			{children}
		</Reorder.Item>
	);
}

function clampTerminalFontSize(size: number): number {
	return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, size));
}

function initialTerminalFontSize(): number {
	if (typeof window === "undefined") return TERMINAL_FONT_SIZE_DEFAULT;
	const raw = window.localStorage?.getItem(terminalFontSizeStorageKey);
	const parsed = raw === null ? Number.NaN : Number(raw);
	if (!Number.isFinite(parsed)) return TERMINAL_FONT_SIZE_DEFAULT;
	return clampTerminalFontSize(parsed);
}

export function CenterPane({
	session,
	theme,
	daemonReady,
	terminalTarget,
	reviewerTerminal,
	onSelectReviewerTerminal,
	shellTerminals = [],
	onSelectSessionTerminal,
	onSelectShellTerminal,
	onCloseShellTerminal,
	onRenameShellTerminal,
	onNewShellTerminal,
	topbarActions,
	agentInputDisabled = false,
}: CenterPaneProps) {
	const { t } = useTranslation();
	const paneRef = useRef<HTMLDivElement | null>(null);
	const wheelZoomRemainderRef = useRef(0);
	const lastWheelZoomAtRef = useRef(0);
	const [fontSize, setFontSize] = useState(initialTerminalFontSize);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [terminalBounds, setTerminalBounds] = useState({ leftInset: 0, rightInset: 0, width: 0 });
	const [shellOrderBySession, setShellOrderBySession] = useState<Record<string, string[]>>({});
	const isSidebarOpen = useUiStore((state) => state.isSidebarOpen);
	const orderedShellTerminals = useMemo(() => {
		const preferred = session ? (shellOrderBySession[session.id] ?? []) : [];
		const byHandle = new Map(shellTerminals.map((terminal) => [terminal.handleId, terminal]));
		const ordered = preferred.flatMap((handleId) => {
			const terminal = byHandle.get(handleId);
			if (!terminal) return [];
			byHandle.delete(handleId);
			return [terminal];
		});
		return [...ordered, ...byHandle.values()];
	}, [session, shellOrderBySession, shellTerminals]);
	const tabOverflowWatch = `${session?.id ?? ""}|${orderedShellTerminals.map((terminal) => terminal.handleId).join("|")}`;
	const tabsOverflow = useOverflowScroll<HTMLDivElement>(tabOverflowWatch);
	const agentSwitchesQuery = useAgentSwitches(session?.id ?? "");
	const agentSwitches = agentSwitchesQuery.data ?? [];
	const activeAgentSwitch = findActiveAgentSwitch(agentSwitches);
	const recoveryAgentSwitch = findRecoveryRequiredAgentSwitch(agentSwitches);
	const switchMutation = useSwitchAgentState(session?.id ?? "");
	const switchSource = recoveryAgentSwitch?.fromHarness ?? activeAgentSwitch?.fromHarness ?? switchMutation.input?.session.provider;
	const switchTarget = recoveryAgentSwitch?.targetHarness ?? activeAgentSwitch?.targetHarness ?? switchMutation.input?.targetHarness;
	const isSwitchingAgent = Boolean(
		!recoveryAgentSwitch && (activeAgentSwitch || switchMutation.isPending) && switchSource && switchTarget,
	);
	const switchNeedsRecovery = Boolean(recoveryAgentSwitch && switchSource && switchTarget);
	const switchPermissionRequired = Boolean(
		activeAgentSwitch?.state === "preparing_handoff" &&
			activeAgentSwitch.agentHandoffStatus === "requested" &&
			(session?.activity?.state === "blocked" || session?.activity?.state === "waiting_input"),
	);
	const target = terminalTarget ?? { kind: "worker" };
	const sessionTabLabel = session
		? isOrchestratorSession(session)
			? t("shell.orchestrator")
			: session.title
		: t("terminal.noSession");
	const activeTerminalLabel =
		target.kind === "shell"
			? (shellTerminals.find((shell) => shell.handleId === target.handleId)?.title ?? target.title)
			: target.kind === "reviewer"
				? `${t("terminal.reviewer")} · ${target.harness}`
				: sessionTabLabel;
	const reorderShellTerminals = useCallback(
		(nextHandles: string[]) => {
			if (!session) return;
			const available = new Set(shellTerminals.map((terminal) => terminal.handleId));
			const next = nextHandles.filter(
				(handleId, index) => available.has(handleId) && nextHandles.indexOf(handleId) === index,
			);
			for (const terminal of shellTerminals) {
				if (!next.includes(terminal.handleId)) next.push(terminal.handleId);
			}
			setShellOrderBySession((current) => ({ ...current, [session.id]: next }));
		},
		[session, shellTerminals],
	);
	const selectAdjacentTab = useCallback(
		(direction: -1 | 1) => {
			const activeIndex =
				target.kind === "shell"
					? orderedShellTerminals.findIndex((shell) => shell.handleId === target.handleId) + 1
					: 0;
			const nextIndex =
				(activeIndex + direction + orderedShellTerminals.length + 1) % (orderedShellTerminals.length + 1);
			if (nextIndex === 0) {
				onSelectSessionTerminal?.();
				return;
			}
			const nextShell = orderedShellTerminals[nextIndex - 1];
			if (nextShell) onSelectShellTerminal?.(nextShell.handleId);
		},
		[onSelectSessionTerminal, onSelectShellTerminal, orderedShellTerminals, target],
	);

	useEffect(() => {
		if (!switchMutation.isPending || activeAgentSwitch || recoveryAgentSwitch) return;
		void agentSwitchesQuery.refetch();
		const timer = window.setInterval(() => void agentSwitchesQuery.refetch(), 500);
		return () => window.clearInterval(timer);
	}, [activeAgentSwitch, agentSwitchesQuery.refetch, recoveryAgentSwitch, switchMutation.isPending]);

	useEffect(() => {
		const handleFullscreenChange = () => setIsFullscreen(document.fullscreenElement === paneRef.current);
		document.addEventListener("fullscreenchange", handleFullscreenChange);
		return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
	}, []);

	useEffect(
		() =>
			aoBridge.app.onCloseShellTerminalShortcut(() => {
				if (target.kind === "shell") onCloseShellTerminal?.(target.handleId);
			}),
		[target, onCloseShellTerminal],
	);

	useEffect(() => {
		const disposePrevious = aoBridge.app.onPreviousTabShortcut(() => selectAdjacentTab(-1));
		const disposeNext = aoBridge.app.onNextTabShortcut(() => selectAdjacentTab(1));
		return () => {
			disposePrevious();
			disposeNext();
		};
	}, [selectAdjacentTab]);

	useEffect(() => {
		aoBridge.app.setCloseShellTerminalShortcutEnabled(
			target.kind === "shell" && Boolean(onCloseShellTerminal),
		);
		return () => aoBridge.app.setCloseShellTerminalShortcutEnabled(false);
	}, [target.kind, onCloseShellTerminal]);

	useEffect(() => {
		const activeKey =
			target.kind === "shell"
				? target.handleId
				: target.kind === "reviewer"
					? `reviewer:${target.handleId}`
					: undefined;
		if (!activeKey) return;
		const activeTab = Array.from(
			tabsOverflow.ref.current?.querySelectorAll<HTMLElement>("[data-terminal-tab-key]") ?? [],
		).find((element) => element.dataset.terminalTabKey === activeKey);
		activeTab?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "nearest" });
	}, [orderedShellTerminals, tabsOverflow.ref, target]);

	useEffect(() => {
		const pane = paneRef.current;
		if (!pane) return;
		const workspaceSurface = pane.closest<HTMLElement>(".center-panel-surface");
		const measure = () => {
			const paneRect = pane.getBoundingClientRect();
			// leftInset/rightInset are kept for the terminal region width calculation
			// but no longer used for viewport-alignment padding (topbar is inside the surface).
			const workspaceRect = workspaceSurface?.getBoundingClientRect() ?? paneRect;
			const next = {
				leftInset: workspaceRect.left,
				rightInset: Math.max(0, window.innerWidth - workspaceRect.right),
				width: paneRect.width,
			};
			setTerminalBounds((current) =>
				current.leftInset === next.leftInset && current.rightInset === next.rightInset && current.width === next.width
					? current
					: next,
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(pane);
		if (workspaceSurface) observer.observe(workspaceSurface);
		return () => observer.disconnect();
	}, []);

	const updateFontSize = useCallback((delta: number) => {
		setFontSize((current) => {
			const next = clampTerminalFontSize(current + delta);
			window.localStorage?.setItem(terminalFontSizeStorageKey, String(next));
			return next;
		});
	}, []);

	const toggleFullscreen = useCallback(async () => {
		const pane = paneRef.current;
		if (!pane) return;
		try {
			if (document.fullscreenElement === pane) {
				await document.exitFullscreen();
				return;
			}
			await pane.requestFullscreen();
		} catch (error) {
			console.warn("Unable to toggle terminal fullscreen", error);
		}
	}, []);

	const handleWheelZoom = useCallback(
		(event: WheelEvent<HTMLDivElement>) => {
			if (!event.ctrlKey && !event.metaKey) return;
			event.preventDefault();
			event.stopPropagation();

			if (event.timeStamp - lastWheelZoomAtRef.current > WHEEL_ZOOM_RESET_MS) {
				wheelZoomRemainderRef.current = 0;
			}
			lastWheelZoomAtRef.current = event.timeStamp;
			wheelZoomRemainderRef.current += event.deltaY;

			const steps = Math.floor(Math.abs(wheelZoomRemainderRef.current) / WHEEL_ZOOM_THRESHOLD);
			if (steps === 0) return;

			const direction = wheelZoomRemainderRef.current > 0 ? -1 : 1;
			updateFontSize(direction * steps);
			wheelZoomRemainderRef.current -= Math.sign(wheelZoomRemainderRef.current) * steps * WHEEL_ZOOM_THRESHOLD;
		},
		[updateFontSize],
	);

	const terminalTopbar = (
		<div className="flex h-inspector-tabs w-full shrink-0 items-stretch bg-sidebar">

			<div className="session-topbar-surface flex min-w-0 flex-1" data-testid="session-workspace-topbar">
				<div
					className={cn(
						"flex min-w-0 shrink items-center pr-3",
						!isFullscreen && !isSidebarOpen && isMac && "session-topbar-titlebar-clearance-mac",
						!isFullscreen && !isSidebarOpen && isLinux && "session-topbar-titlebar-clearance-linux",
					)}
					data-testid="session-terminal-region"
					style={{
						width: terminalBounds.width > 0 ? terminalBounds.width : "100%",
					}}
				>
					<div
							aria-label={t("terminal.tabsAria")}
							className="flex h-full min-w-flex-min flex-1 items-center"
							onKeyDown={handleTerminalTabListKeyDown}
							role="tablist"
						>
							{/* The owning session is permanent and never participates in overflow or reordering. */}
							{session ? (
								<SessionPaneTab
									isActive={target.kind === "worker"}
									label={sessionTabLabel}
									onSelect={onSelectSessionTerminal}
									session={session}
								/>
							) : (
								<SessionPaneTab isActive={target.kind === "worker"} label={sessionTabLabel} />
							)}
							<div
								ref={tabsOverflow.ref}
								className="terminal-tabs-scrollbar flex min-w-flex-min flex-1 self-stretch items-center overflow-x-auto"
							>
								{reviewerTerminal ? (
									<span
										className="inline-flex shrink-0 self-stretch"
										data-terminal-tab-key={`reviewer:${reviewerTerminal.handleId}`}
									>
										<SessionPaneTab
											icon={<AgentAvatar provider={reviewerTerminal.harness} className="size-icon-base" decorative />}
											isActive={target.kind === "reviewer"}
											label={t("terminal.reviewer")}
											onSelect={() => onSelectReviewerTerminal?.(reviewerTerminal)}
											title={reviewerTerminal.harness}
										/>
									</span>
								) : null}
								<Reorder.Group
									as="div"
									axis="x"
									className="flex self-stretch"
									onReorder={reorderShellTerminals}
									values={orderedShellTerminals.map((shell) => shell.handleId)}
								>
									{orderedShellTerminals.map((shell) => (
										<DraggableShellTerminal key={shell.handleId} value={shell.handleId}>
											<ShellTerminalTab
												appearance="connected"
												isActive={target.kind === "shell" && target.handleId === shell.handleId}
												onClose={() => onCloseShellTerminal?.(shell.handleId)}
												onRename={
													onRenameShellTerminal
														? (title) => onRenameShellTerminal(shell.handleId, title)
														: undefined
												}
												onSelect={() => onSelectShellTerminal?.(shell.handleId)}
												shell={shell}
											/>
										</DraggableShellTerminal>
									))}
								</Reorder.Group>
							</div>
						{!session || !isOrchestratorSession(session) ? (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										aria-label={t("shortcut.new-shell-terminal")}
										className="shrink-0 text-muted-foreground"
										disabled={!onNewShellTerminal}
										onClick={onNewShellTerminal}
										size="icon-sm"
										type="button"
										variant="outline"
									>
										<Plus aria-hidden="true" className="size-icon-md" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>{t("terminal.newWithShortcut", { shortcut: newTerminalShortcutLabel })}</TooltipContent>
							</Tooltip>
						) : null}
					</div>
					<div
						aria-label={t("terminal.controlsAria")}
						className="ml-1.5 flex shrink-0 items-center gap-0.5 border-l border-border/70 pl-1.5"
						role="toolbar"
					>
						<TerminalControl
							disabled={fontSize <= TERMINAL_FONT_SIZE_MIN}
							label={t("terminal.decreaseFontSize")}
							onClick={() => updateFontSize(-1)}
						>
							<Minus aria-hidden="true" className="size-icon-sm" />
						</TerminalControl>
						<span
							aria-label={t("terminal.fontSizeAria", { size: fontSize })}
							className="w-font-size-label text-center font-mono text-micro tabular-nums text-muted-foreground"
						>
							{fontSize}px
						</span>
						<TerminalControl
							disabled={fontSize >= TERMINAL_FONT_SIZE_MAX}
							label={t("terminal.increaseFontSize")}
							onClick={() => updateFontSize(1)}
						>
							<Plus aria-hidden="true" className="size-icon-sm" />
						</TerminalControl>
						<div aria-hidden="true" className="mx-1 h-4 w-px bg-border/70" />
						<TerminalControl
							isPressed={isFullscreen}
							label={isFullscreen ? t("terminal.exitFullscreen") : t("terminal.fullscreen")}
							onClick={() => void toggleFullscreen()}
						>
							{isFullscreen ? (
								<Minimize2 aria-hidden="true" className="size-icon-md" />
							) : (
								<Maximize2 aria-hidden="true" className="size-icon-md" />
							)}
						</TerminalControl>
					</div>
				</div>
				{isFullscreen ? null : (
					<div
						className="ml-auto flex shrink-0 items-center px-3"
						data-testid="session-action-region"
					>
						{topbarActions}
					</div>
				)}
			</div>
		</div>
	);

	return (
		<div
			ref={paneRef}
			className="terminal-pane-frame flex h-full min-h-0 min-w-flex-min flex-col"
			onWheelCapture={handleWheelZoom}
		>
			{isFullscreen ? terminalTopbar : <SessionTopbarPortal>{terminalTopbar}</SessionTopbarPortal>}
			<div
				aria-label={t("terminal.panelAria", { title: activeTerminalLabel })}
				className="relative min-h-0 flex-1"
				role="tabpanel"
			>
				<div
					className="h-full min-h-0"
					data-testid="terminal-interaction-surface"
					inert={(isSwitchingAgent || switchNeedsRecovery) && !switchPermissionRequired ? true : undefined}
				>
					<TerminalPane
						daemonReady={daemonReady}
						fontSize={fontSize}
						focusRequested={switchPermissionRequired && target.kind === "worker"}
						inputDisabled={agentInputDisabled && target.kind === "worker"}
						session={session}
						terminalTarget={target}
						theme={theme}
					/>
				</div>
				{(isSwitchingAgent || switchNeedsRecovery) && switchSource && switchTarget ? (
					<AgentSwitchTerminalOverlay
						permissionRequired={switchPermissionRequired}
						recoveryRequired={switchNeedsRecovery}
						source={switchSource}
						target={switchTarget}
					/>
				) : null}
			</div>
		</div>
	);
}

type AgentSwitchTerminalOverlayProps = {
	permissionRequired: boolean;
	recoveryRequired: boolean;
	source: string;
	target: string;
};

function AgentSwitchTerminalOverlay({
	permissionRequired,
	recoveryRequired,
	source,
	target,
}: AgentSwitchTerminalOverlayProps) {
	const { t } = useTranslation();
	const overlayRef = useRef<HTMLDivElement | null>(null);
	const title = recoveryRequired
		? t("switchAgent.recovery.action")
		: t("switchAgent.progressTitle", {
				source: agentLabel(source),
				target: agentLabel(target),
			});

	useEffect(() => {
		if (!permissionRequired) overlayRef.current?.focus({ preventScroll: true });
	}, [permissionRequired, recoveryRequired, source, target]);

	return (
		<div
			ref={overlayRef}
			aria-label={title}
			className={cn(
				"absolute inset-0 z-20 flex items-center justify-center",
				recoveryRequired
					? "bg-terminal/95 backdrop-blur-[3px]"
					: permissionRequired
						? "pointer-events-none bg-terminal/25"
						: "cursor-wait bg-terminal/95 backdrop-blur-[3px]",
			)}
			data-testid="agent-switch-terminal-overlay"
			tabIndex={-1}
		>
			{recoveryRequired ? (
				<div
					aria-label={title}
					className="flex max-w-md flex-col items-center gap-2 rounded-lg border border-warning/40 bg-surface/95 px-5 py-4 text-center shadow-lg"
					role="alert"
				>
					<TriangleAlert aria-hidden="true" className="size-6 text-warning" />
					<p className="font-mono text-control font-medium text-foreground">
						{t("switchAgent.recovery.title")}
					</p>
					<p className="text-caption leading-4 text-muted-foreground">
						{t("switchAgent.recovery.shortDescription")}
					</p>
				</div>
			) : (
				<div
					aria-label={title}
					aria-live="polite"
					className={cn(
						"flex flex-col items-center gap-5 px-6 text-center",
						permissionRequired && "absolute inset-x-0 top-4 gap-2",
					)}
					role="status"
				>
					<div className="flex items-center gap-5 sm:gap-7">
						<SwitchingAgentMark harness={source} />
						<div aria-hidden="true" className="flex items-center gap-2 text-accent">
							<div className="relative h-1 w-20 overflow-hidden rounded-full bg-border-strong/70 sm:w-28">
								<span className="agent-switch-transfer-pulse absolute inset-y-0 w-10 rounded-full bg-gradient-to-r from-transparent via-accent to-transparent" />
							</div>
							<ArrowRight className="size-icon-lg shrink-0" />
						</div>
						<SwitchingAgentMark harness={target} />
					</div>
					<p className="font-mono text-control font-medium text-foreground">{title}</p>
					{permissionRequired ? (
						<p className="rounded-md border border-warning/40 bg-surface/95 px-3 py-2 text-caption text-foreground shadow-lg">
							{t("switchAgent.permissionRequired")}
						</p>
					) : null}
				</div>
			)}
		</div>
	);
}

function SwitchingAgentMark({ harness }: { harness: string }) {
	return (
		<div className="flex min-w-20 flex-col items-center gap-2">
			<span className="grid size-14 place-items-center rounded-xl border border-border-strong bg-surface/90 shadow-lg shadow-black/20">
				<AgentAvatar className="size-8" decorative provider={harness} />
			</span>
			<span className="text-caption font-medium text-muted-foreground">{agentLabel(harness)}</span>
		</div>
	);
}

type SessionPaneTabProps = {
	label: string;
	isActive: boolean;
	onSelect?: () => void;
	session?: WorkspaceSession;
	icon?: ReactNode;
	title?: string;
};

// Shared tab chrome: the open tab is highlighted with the same rounded
// background as the inspector rail tabs (Summary · Reviews · Browser), and
// the full label only becomes the hover tooltip when the tab strip is
// crowded enough to truncate it.
function SessionPaneTab({ label, isActive, onSelect, session, icon, title }: SessionPaneTabProps) {
	const { t } = useTranslation();
	const { ref, isTruncated } = useTruncatedText<HTMLButtonElement>(label);
	const activity = session ? getAgentActivityView(session.activity, t) : undefined;
	const tabIcon = session ? <AgentAvatar className="size-terminal-agent-icon" decorative provider={session.provider} /> : icon;
	return (
		<span
			data-terminal-role="primary"
			className={cn(
				"group relative inline-flex min-w-shell-tab-min shrink-0 self-stretch items-center gap-1.5 border-r border-border bg-surface px-3 text-foreground transition-colors",
				isActive
					? "bg-overlay text-foreground after:absolute after:inset-x-0 after:top-0 after:h-0.5 after:bg-foreground/80"
					: "text-muted-foreground hover:bg-raised hover:text-foreground",
			)}
		>
			<button
				ref={ref}
				aria-current={isActive}
				aria-label={activity ? `${label} · ${activity.label}` : label}
				aria-selected={isActive}
				className={cn(
					"inline-flex min-w-flex-min max-w-shell-tab-max items-center gap-1.5 text-control font-medium leading-none transition-colors",
					isActive ? "text-foreground" : "text-passive group-hover:text-foreground",
				)}
				onClick={onSelect}
				role="tab"
				tabIndex={isActive ? 0 : -1}
				title={title ?? (isTruncated ? label : t("terminal.sessionAria"))}
				type="button"
			>
				{tabIcon}
				<span className="truncate">{label}</span>
				{activity ? (
					<span
						aria-hidden="true"
						className="inline-flex shrink-0 self-center items-center"
						style={{ color: activity.tone }}
						title={activity.label}
					>
						<span
							className={cn("size-1.5 rounded-full", activity.breathe && "animate-status-pulse")}
							style={{ background: activity.tone }}
						/>
					</span>
				) : null}
			</button>
			{session ? <TerminalSwitchAgentButton key={session.id} session={session} /> : null}
		</span>
	);
}

type TerminalControlProps = {
	children: ReactNode;
	disabled?: boolean;
	isPressed?: boolean;
	label: string;
	onClick: () => void;
};

function TerminalControl({ children, disabled, isPressed, label, onClick }: TerminalControlProps) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					aria-label={label}
					aria-pressed={isPressed}
					className="size-control-sm p-0 text-passive"
					disabled={disabled}
					onClick={onClick}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}
