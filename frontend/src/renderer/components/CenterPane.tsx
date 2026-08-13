import { ArrowRight, Plus, TriangleAlert } from "lucide-react";
import { Reorder, useDragControls } from "motion/react";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type PointerEvent,
	type ReactNode,
	type WheelEvent as ReactWheelEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { defaultShortcutBindings, shortcutBindingLabel } from "../../shared/shortcuts";
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

type AuxiliaryTerminal =
	| { key: string; kind: "reviewer"; terminal: NonNullable<CenterPaneProps["reviewerTerminal"]> }
	| { key: string; kind: "shell"; terminal: ShellTerminal };

type TerminalOrder = { sessionId: string; keys: string[] };

const terminalFontSizeStorageKey = "ao.terminal.fontSize";
const WHEEL_ZOOM_THRESHOLD = 80;
const WHEEL_ZOOM_RESET_MS = 250;
const isMac = isMacPlatform();
const isLinux = isLinuxPlatform();
const newTerminalShortcutLabel = shortcutBindingLabel(defaultShortcutBindings("new-shell-terminal", isMac)[0], isMac);

function DraggableTerminalTab({ children, value }: { children: ReactNode; value: string }) {
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
	const tabsOverflowRef = useRef<HTMLDivElement | null>(null);
	const wheelZoomRemainderRef = useRef(0);
	const lastWheelZoomAtRef = useRef(0);
	const [fontSize, setFontSize] = useState(initialTerminalFontSize);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [terminalBounds, setTerminalBounds] = useState({ leftInset: 0, rightInset: 0, width: 0 });
	const [terminalOrder, setTerminalOrder] = useState<TerminalOrder | null>(null);
	const isSidebarOpen = useUiStore((state) => state.isSidebarOpen);
	const sessionId = session?.id;
	const auxiliaryTerminals = useMemo<AuxiliaryTerminal[]>(
		() => [
			...(reviewerTerminal
				? [
						{
							key: `reviewer:${reviewerTerminal.handleId}`,
							kind: "reviewer" as const,
							terminal: reviewerTerminal,
						},
					]
				: []),
			...shellTerminals.map((terminal) => ({ key: terminal.handleId, kind: "shell" as const, terminal })),
		],
		[reviewerTerminal, shellTerminals],
	);
	const availableAuxiliaryKeys = useMemo(() => auxiliaryTerminals.map((terminal) => terminal.key), [auxiliaryTerminals]);
	const orderedAuxiliaryTerminals = useMemo(() => {
		const preferred = terminalOrder && terminalOrder.sessionId === sessionId ? terminalOrder.keys : [];
		const byKey = new Map(auxiliaryTerminals.map((terminal) => [terminal.key, terminal]));
		const ordered = preferred.flatMap((key) => {
			const terminal = byKey.get(key);
			if (!terminal) return [];
			byKey.delete(key);
			return [terminal];
		});
		return [...ordered, ...byKey.values()];
	}, [auxiliaryTerminals, sessionId, terminalOrder]);
	const tabOverflowWatch = `${sessionId ?? ""}|${availableAuxiliaryKeys.join("|")}`;
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
	const reorderAuxiliaryTerminals = useCallback(
		(nextKeys: string[]) => {
			if (!sessionId) return;
			const available = new Set(availableAuxiliaryKeys);
			const next = nextKeys.filter((key, index) => available.has(key) && nextKeys.indexOf(key) === index);
			for (const key of availableAuxiliaryKeys) {
				if (!next.includes(key)) next.push(key);
			}
			setTerminalOrder({ keys: next, sessionId });
		},
		[availableAuxiliaryKeys, sessionId],
	);
	const selectAdjacentTab = useCallback(
		(direction: -1 | 1) => {
			const activeKey =
				target.kind === "shell"
					? target.handleId
					: target.kind === "reviewer"
						? `reviewer:${target.handleId}`
						: "worker";
			const tabKeys = ["worker", ...orderedAuxiliaryTerminals.map((terminal) => terminal.key)];
			const activeIndex = Math.max(0, tabKeys.indexOf(activeKey));
			const nextIndex = (activeIndex + direction + tabKeys.length) % tabKeys.length;
			if (nextIndex === 0) {
				onSelectSessionTerminal?.();
				return;
			}
			const nextTerminal = orderedAuxiliaryTerminals[nextIndex - 1];
			if (nextTerminal?.kind === "reviewer") onSelectReviewerTerminal?.(nextTerminal.terminal);
			if (nextTerminal?.kind === "shell") onSelectShellTerminal?.(nextTerminal.terminal.handleId);
		},
		[
			onSelectReviewerTerminal,
			onSelectSessionTerminal,
			onSelectShellTerminal,
			orderedAuxiliaryTerminals,
			target,
		],
	);

	useEffect(() => {
		setTerminalOrder((current) => {
			if (!current) return current;
			if (!sessionId || current.sessionId !== sessionId) return null;
			const available = new Set(availableAuxiliaryKeys);
			const keys = current.keys.filter((key) => available.has(key));
			if (keys.length === current.keys.length) return current;
			return keys.length > 0 ? { ...current, keys } : null;
		});
	}, [availableAuxiliaryKeys, sessionId]);

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
		const element = tabsOverflowRef.current;
		if (!element) return;
		const handleWheel = (event: globalThis.WheelEvent) => {
			if (event.ctrlKey || event.metaKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
			if (event.deltaY === 0 || element.scrollWidth <= element.clientWidth) return;
			event.preventDefault();
			element.scrollBy({ left: event.deltaY });
		};
		element.addEventListener("wheel", handleWheel, { passive: false });
		return () => element.removeEventListener("wheel", handleWheel);
	}, [isFullscreen, tabOverflowWatch]);

	useEffect(() => {
		const activeKey =
			target.kind === "shell"
				? target.handleId
				: target.kind === "reviewer"
					? `reviewer:${target.handleId}`
					: undefined;
		if (!activeKey) return;
		const scrollRegion = tabsOverflowRef.current;
		if (!scrollRegion) return;
		const activeTab = Array.from(
			scrollRegion.querySelectorAll<HTMLElement>("[data-terminal-tab-key]"),
		).find((element) => element.dataset.terminalTabKey === activeKey);
		if (!activeTab) return;
		const scrollRect = scrollRegion.getBoundingClientRect();
		const tabRect = activeTab.getBoundingClientRect();
		let nextScrollLeft = scrollRegion.scrollLeft;
		if (tabRect.left < scrollRect.left) nextScrollLeft -= scrollRect.left - tabRect.left;
		if (tabRect.right > scrollRect.right) nextScrollLeft += tabRect.right - scrollRect.right;
		if (nextScrollLeft === scrollRegion.scrollLeft) return;
		scrollRegion.scrollTo({ behavior: "smooth", left: Math.max(0, nextScrollLeft) });
	}, [orderedAuxiliaryTerminals, target]);

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
		(event: ReactWheelEvent<HTMLDivElement>) => {
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
								ref={tabsOverflowRef}
								className="scrollbar-none flex min-w-flex-min flex-1 self-stretch items-center overflow-x-auto"
							>
								<Reorder.Group
									as="div"
									axis="x"
									className="flex self-stretch"
									onReorder={reorderAuxiliaryTerminals}
									values={orderedAuxiliaryTerminals.map((terminal) => terminal.key)}
								>
									{orderedAuxiliaryTerminals.map((terminal) => (
										<DraggableTerminalTab key={terminal.key} value={terminal.key}>
											{terminal.kind === "reviewer" ? (
												<SessionPaneTab
													appearance="connected"
													icon={
														<AgentAvatar
															provider={terminal.terminal.harness}
															className="size-terminal-agent-icon"
															decorative
														/>
													}
													isActive={target.kind === "reviewer"}
													label={t("terminal.reviewer")}
													onSelect={() => onSelectReviewerTerminal?.(terminal.terminal)}
													title={terminal.terminal.harness}
												/>
											) : (
												<ShellTerminalTab
													appearance="connected"
													isActive={target.kind === "shell" && target.handleId === terminal.terminal.handleId}
													onClose={() => onCloseShellTerminal?.(terminal.terminal.handleId)}
													onRename={
														onRenameShellTerminal
															? (title) => onRenameShellTerminal(terminal.terminal.handleId, title)
															: undefined
													}
													onSelect={() => onSelectShellTerminal?.(terminal.terminal.handleId)}
													shell={terminal.terminal}
												/>
											)}
										</DraggableTerminalTab>
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
						isFullscreen={isFullscreen}
						inputDisabled={agentInputDisabled && target.kind === "worker"}
						onChangeFontSize={updateFontSize}
						onToggleFullscreen={toggleFullscreen}
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
	appearance?: "primary" | "connected";
	onSelect?: () => void;
	session?: WorkspaceSession;
	icon?: ReactNode;
	title?: string;
};

// Shared tab chrome: the open tab is highlighted with the same rounded
// background as the inspector rail tabs (Summary · Reviews · Browser), and
// the full label only becomes the hover tooltip when the tab strip is
// crowded enough to truncate it.
function SessionPaneTab({
	label,
	isActive,
	appearance = "primary",
	onSelect,
	session,
	icon,
	title,
}: SessionPaneTabProps) {
	const { t } = useTranslation();
	const { ref, isTruncated } = useTruncatedText<HTMLButtonElement>(label);
	const activity = session ? getAgentActivityView(session.activity, t) : undefined;
	const tabIcon = session ? <AgentAvatar className="size-terminal-agent-icon" decorative provider={session.provider} /> : icon;
	const connected = appearance === "connected";
	return (
		<span
			data-terminal-role={connected ? undefined : "primary"}
			className={cn(
				"group relative inline-flex min-w-shell-tab-min shrink-0 self-stretch items-center gap-1.5 transition-colors",
				connected
					? "w-shell-tab-connected border-x border-transparent px-2"
					: "border-r border-border bg-surface px-3 text-foreground",
				connected
					? isActive
						? "border-border-strong bg-overlay text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-foreground/80"
						: "text-passive hover:bg-interactive-hover/60 hover:text-foreground"
					: isActive
						? "bg-overlay text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-foreground/80"
						: "text-muted-foreground hover:bg-raised hover:text-foreground",
			)}
		>
			<button
				ref={ref}
				aria-current={isActive}
				aria-label={activity ? `${label} · ${activity.label}` : label}
				aria-selected={isActive}
				className={cn(
					"inline-flex items-center gap-1.5 truncate text-control leading-none transition-colors",
					connected
						? "min-w-0 w-full text-left font-normal"
						: "min-w-flex-min max-w-shell-tab-max font-medium",
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
