import { useNavigate } from "@tanstack/react-router";
import { CircleDashed, Loader2 } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import aoLogo from "../../../assets/ao-logo.svg";
import feedbackBackground from "../../landing/public/optimized/feature4.webp";
import visibilityBackground from "../../landing/public/optimized/feature.webp";
import { FeedbackLoopDemo } from "../../landing/src/app/components/FeaturesSection/components/FeedbackLoopDemo/FeedbackLoopDemo";
import { FleetBoardDemo, type FleetBoardAssets } from "../../landing/src/app/components/FeaturesSection/components/FleetBoardDemo/FleetBoardDemo";
import { refreshAgentsIfStale, useAgentsQuery, type AgentCatalog } from "../hooks/useAgentsQuery";
import { AGENT_OPTIONS, agentLabel } from "../lib/agent-options";
import { buildRankedAgentOptions, DEFAULT_AGENT_PRIORITY_RANK } from "../lib/agent-select-options";
import { aoBridge } from "../lib/bridge";
import { cn } from "../lib/utils";
import { applyDocumentTheme, applyDocumentThemeStyle, readStoredThemeStyle, resolveTheme } from "../lib/theme";
import claudeCodeLogo from "../assets/agents/claude-code.svg";
import codexLogo from "../assets/agents/codex.svg";
import cursorLogo from "../assets/agents/cursor.svg";
import opencodeLogo from "../assets/agents/opencode.svg";

type Step = "welcome" | "feedback" | "orchestrator" | "workers" | "project";

type StepDetails = {
	title: string;
	subtitle: string;
	nextLabel: string;
};

const STEPS: Step[] = ["welcome", "feedback", "orchestrator", "workers", "project"];

const STEP_DETAILS: Record<Step, StepDetails> = {
	welcome: {
		title: "Stop babysitting agents.",
		subtitle: "Run coding agents in parallel without losing track.",
		nextLabel: "Continue",
	},
	feedback: {
		title: "Keep the loop moving.",
		subtitle: "CI and review feedback return to the right agent.",
		nextLabel: "Choose agents",
	},
	orchestrator: {
		title: "Pick your orchestrator agent.",
		subtitle: "It turns your goal into a plan, coordinates workers, and keeps the project moving.",
		nextLabel: "Choose workers",
	},
	workers: {
		title: "Pick your worker agents.",
		subtitle: "Workers carry out the tasks your orchestrator delegates to them.",
		nextLabel: "Add a project",
	},
	project: {
		title: "Add your first project.",
		subtitle: "AO keeps each worker in its own worktree.",
		nextLabel: "Open AO",
	},
};

const ALL_IMAGES = [visibilityBackground, feedbackBackground];
const INSTALL_GUIDE_URL = "https://aoagents.dev/docs/plugins/agents";
// Availability is helpful context, never a gate for setup. A daemon that is
// still booting (or a stalled local probe) must not leave every choice looking
// perpetually busy.
const AGENT_CHECK_INDICATOR_TIMEOUT_MS = 2_500;
const AGENT_ICON_URLS = import.meta.glob<string>("../assets/agents/*.{png,svg}", {
	eager: true,
	import: "default",
	query: "?url",
});
const LANDING_PREVIEW_ASSETS: FleetBoardAssets = {
	"/app-icons/coverage-claude-code.svg": claudeCodeLogo,
	"/app-icons/coverage-codex.svg": codexLogo,
	"/app-icons/cursor.svg": cursorLogo,
	"/app-icons/opencode.svg": opencodeLogo,
};

function agentIcon(agentId: string) {
	const suffixes = [`/${agentId}.svg`, `/${agentId}.png`];
	return Object.entries(AGENT_ICON_URLS).find(([path]) => suffixes.some((suffix) => path.endsWith(suffix)))?.[1];
}

export function OnboardingPage() {
	const navigate = useNavigate();
	const agentsQuery = useAgentsQuery();
	const [freshAgentCatalog, setFreshAgentCatalog] = useState<AgentCatalog | null>(null);
	const [step, setStep] = useState<Step>("welcome");
	const [orchestratorAgent, setOrchestratorAgent] = useState<string | null>(null);
	const [workerAgent, setWorkerAgent] = useState<string | null>(null);
	const [hoveredOrchestrator, setHoveredOrchestrator] = useState<string | null>(null);
	const [hoveredWorker, setHoveredWorker] = useState<string | null>(null);
	const [projectPath, setProjectPath] = useState("");
	const [projectMode, setProjectMode] = useState<"folder" | "git">("folder");
	const [agentCheckIndicatorTimedOut, setAgentCheckIndicatorTimedOut] = useState(false);
	const stepIndex = STEPS.indexOf(step);
	const details = STEP_DETAILS[step];
	const agentCatalog = freshAgentCatalog ?? agentsQuery.data;
	const agents = useMemo(() => {
		const fallbackAgents = AGENT_OPTIONS.map((id) => ({ id, label: agentLabel(id) }));
		const isCatalogKnown = Boolean(agentCatalog);
		const isCheckingCatalog = !isCatalogKnown && (agentsQuery.isLoading || agentsQuery.isFetching) && !agentCheckIndicatorTimedOut;
		const installedIds = new Set(agentCatalog?.installed.map((agent) => agent.id));
		return buildRankedAgentOptions({
			supported: agentCatalog?.supported,
			installed: agentCatalog?.installed,
			authorized: agentCatalog?.authorized,
			priorityRank: DEFAULT_AGENT_PRIORITY_RANK,
			fallbackAgents,
		}).map((agent) => {
			const indicator: OnboardingAgent["indicator"] = isCheckingCatalog
				? "checking"
				: isCatalogKnown && agent.status
					? "auth"
					: "none";
			return {
				id: agent.id,
				// Until probing completes, do not claim a harness is absent. Let the
				// user continue with a pick and update to Install only after a real
				// catalog confirms it is missing.
				installed: !isCatalogKnown || installedIds.has(agent.id),
				name: agent.label,
				indicator,
			};
		});
	}, [agentCatalog, agentCheckIndicatorTimedOut, agentsQuery.isFetching, agentsQuery.isLoading]);

	useEffect(() => {
		if (agentCatalog || (!agentsQuery.isLoading && !agentsQuery.isFetching)) {
			setAgentCheckIndicatorTimedOut(false);
			return;
		}
		const timeout = window.setTimeout(() => setAgentCheckIndicatorTimedOut(true), AGENT_CHECK_INDICATOR_TIMEOUT_MS);
		return () => window.clearTimeout(timeout);
	}, [agentCatalog, agentsQuery.isFetching, agentsQuery.isLoading]);

	useEffect(() => {
		for (const src of ALL_IMAGES) {
			const image = new Image();
			image.src = src;
		}
	}, []);

	useEffect(() => {
		// Match the task composer: probe when this agent-picking surface opens so
		// a newly installed or authenticated harness is reflected immediately.
		void refreshAgentsIfStale().then((catalog) => {
			if (catalog) setFreshAgentCatalog(catalog);
		});
	}, []);

	const goToStep = useCallback((index: number) => {
		if (index >= 0 && index < STEPS.length) setStep(STEPS[index]);
	}, []);

	const next = useCallback(() => {
		if (step === "project") {
			void navigate({ to: "/" });
			return;
		}
		goToStep(stepIndex + 1);
	}, [goToStep, navigate, step, stepIndex]);

	const handleSelectFolder = useCallback(async () => {
		const result = await aoBridge.app.chooseDirectory("Choose a project repository");
		if (result) setProjectPath(result);
	}, []);

	const handleInstallAgent = useCallback(async () => {
		await aoBridge.app.openExternal(INSTALL_GUIDE_URL);
	}, []);

	const isProjectStep = step === "project";
	const isAgentStep = step === "orchestrator" || step === "workers";

	useLayoutEffect(() => {
		// Onboarding is a branded first-run surface: keep it dark and on the
		// default Orchestrate palette even when the app was previously themed.
		applyDocumentTheme("dark");
		applyDocumentThemeStyle("orchestrate");

		return () => {
			applyDocumentTheme(resolveTheme());
			applyDocumentThemeStyle(readStoredThemeStyle());
		};
	}, []);

	return (
		<main className="relative h-[100dvh] min-h-[640px] w-screen overflow-hidden bg-background text-foreground">
			<div
				className="fixed inset-x-0 top-0 z-titlebar h-8"
				style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
			/>

			<div className="mx-auto grid h-full w-full max-w-[1240px] grid-rows-[80px_minmax(0,1fr)_88px] px-8 max-[1040px]:px-6">
				<header className="flex items-end justify-between pb-3" aria-label="Onboarding progress">
					<img src={aoLogo} alt="Agent Orchestrator" className="h-6 w-7 object-contain" />
					<div className="flex gap-1.5" aria-label={`Step ${stepIndex + 1} of ${STEPS.length}`}>
						{STEPS.map((item, index) => (
							<span
								key={item}
								className={cn("h-1 w-4 rounded-full", index <= stepIndex ? "bg-foreground/70" : "bg-foreground/15")}
							/>
						))}
					</div>
				</header>

				<div className={cn(
					"min-h-0",
					isProjectStep
						? "grid place-items-center"
						: isAgentStep
							? "grid grid-cols-[minmax(360px,1.1fr)_minmax(300px,0.9fr)] items-center gap-10 max-[1040px]:grid-cols-[minmax(340px,1.15fr)_minmax(240px,0.85fr)] max-[1040px]:gap-6"
						: "grid grid-cols-[minmax(280px,0.72fr)_minmax(520px,1.35fr)] items-center gap-14 max-[1040px]:grid-cols-[minmax(270px,0.75fr)_minmax(0,1.25fr)] max-[1040px]:gap-8",
				)}>
					<section
						key={step}
						className={cn(
							"grid h-[360px] grid-rows-[180px_180px]",
							isAgentStep && "h-[480px] grid-rows-[210px_minmax(0,1fr)]",
							isProjectStep && "w-full max-w-[520px] text-center",
						)}
						aria-labelledby={`onboarding-title-${step}`}
					>
						<div className={cn("flex flex-col justify-end pb-7", isAgentStep && "justify-center pb-5")}>
							<h1 id={`onboarding-title-${step}`} className={cn(isAgentStep ? "max-w-[500px]" : "max-w-[410px]", "text-[clamp(2rem,3.2vw,3.15rem)] font-normal leading-[1.02] tracking-[-0.045em] text-balance", isProjectStep && "mx-auto")}>
								{details.title}
							</h1>
							<p className={cn("mt-5 max-w-[350px] text-[15px] leading-6 text-muted-foreground text-pretty", isAgentStep && "max-w-[430px]", isProjectStep && "mx-auto")}>{details.subtitle}</p>
						</div>
						<div className={cn("min-h-0 pt-2", isProjectStep && "flex justify-center")}>
							{isAgentStep && (
								<AgentPicker
									role={step === "orchestrator" ? "orchestrator" : "worker"}
									agents={agents}
									orchestratorAgent={orchestratorAgent}
									workerAgent={workerAgent}
									hoveredOrchestrator={hoveredOrchestrator}
									hoveredWorker={hoveredWorker}
									onInstall={handleInstallAgent}
								onOrchestratorHover={setHoveredOrchestrator}
								onWorkerHover={setHoveredWorker}
								onOrchestratorSelect={setOrchestratorAgent}
								onWorkerSelect={setWorkerAgent}
								/>
							)}
							{step === "project" && (
								<ProjectPicker
									path={projectPath}
									mode={projectMode}
									onModeChange={setProjectMode}
									onPathChange={setProjectPath}
									onSelectFolder={handleSelectFolder}
								/>
							)}
						</div>
					</section>

					{isAgentStep ? (
						<AgentTopologyPreview
							orchestratorAgent={orchestratorAgent}
							workerAgent={workerAgent}
							hoveredOrchestrator={hoveredOrchestrator}
							hoveredWorker={hoveredWorker}
						/>
					) : !isProjectStep ? <PreviewStage step={step} /> : null}
				</div>

				<footer className="flex items-start justify-between pt-4">
					<button
						type="button"
						onClick={() => goToStep(stepIndex - 1)}
						disabled={stepIndex === 0}
						className="h-10 px-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-0"
					>
						Back
					</button>
					<button
						type="button"
						onClick={next}
						disabled={(step === "orchestrator" && !orchestratorAgent) || (step === "workers" && !workerAgent)}
						className="inline-flex h-10 w-auto items-center justify-center whitespace-nowrap rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-30"
					>
						{details.nextLabel}
					</button>
				</footer>
			</div>
		</main>
	);
}

type OnboardingAgent = {
	id: string;
	installed: boolean;
	name: string;
	indicator: "auth" | "checking" | "none";
};

function AgentPicker({
	role,
	agents,
	orchestratorAgent,
	workerAgent,
	hoveredOrchestrator,
	hoveredWorker,
	onInstall,
	onOrchestratorHover,
	onWorkerHover,
	onOrchestratorSelect,
	onWorkerSelect,
}: {
	role: "orchestrator" | "worker";
	agents: OnboardingAgent[];
	orchestratorAgent: string | null;
	workerAgent: string | null;
	hoveredOrchestrator: string | null;
	hoveredWorker: string | null;
	onInstall: (id: string) => void;
	onOrchestratorHover: (id: string | null) => void;
	onWorkerHover: (id: string | null) => void;
	onOrchestratorSelect: (id: string) => void;
	onWorkerSelect: (id: string) => void;
}) {
	const isOrchestrator = role === "orchestrator";
	return (
		<div className="w-full max-w-[440px] text-left">
			<AgentRolePicker
				label={isOrchestrator ? "Orchestrator agent" : "Worker agents"}
				showLabel={!isOrchestrator}
				agents={agents}
				value={isOrchestrator ? orchestratorAgent : workerAgent}
				hovered={isOrchestrator ? hoveredOrchestrator : hoveredWorker}
				onHover={isOrchestrator ? onOrchestratorHover : onWorkerHover}
				onSelect={isOrchestrator ? onOrchestratorSelect : onWorkerSelect}
				onInstall={onInstall}
			/>
		</div>
	);
}

function AgentRolePicker({
	label,
	showLabel = true,
	agents,
	value,
	hovered,
	onHover,
	onSelect,
	onInstall,
}: {
	label: string;
	showLabel?: boolean;
	agents: OnboardingAgent[];
	value: string | null;
	hovered: string | null;
	onHover: (id: string | null) => void;
	onSelect: (id: string) => void;
	onInstall: (id: string) => void;
}) {
	const installed = agents.filter((agent) => agent.installed);
	const available = agents.filter((agent) => !agent.installed);
	const [showTopFade, setShowTopFade] = useState(false);
	return (
		<section aria-label={label}>
			{showLabel ? <p className="mb-1.5 text-xs font-medium text-muted-foreground">{label}</p> : null}
			<div className="relative">
				<div className="max-h-[240px] space-y-0.5 overflow-y-auto rounded-lg pb-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" onScroll={(event) => setShowTopFade(event.currentTarget.scrollTop > 0)}>
					{installed.map((agent) => (
						<button
							type="button"
							key={agent.id}
							onClick={() => onSelect(agent.id)}
							onMouseEnter={() => onHover(agent.id)}
							onMouseLeave={() => onHover(null)}
							aria-pressed={value === agent.id}
							aria-label={agent.name}
							className={cn(
								"flex h-10 w-full items-center gap-3 rounded-md px-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								value === agent.id && "bg-foreground/15",
								hovered === agent.id && value !== agent.id && "bg-foreground/[0.07] text-foreground",
							)}
						>
							<img src={agentIcon(agent.id)} alt="" className="size-5 shrink-0 object-contain" />
							<span className="min-w-0 flex-1 truncate">{agent.name}</span>
							{value === agent.id ? <CheckIcon className="text-status-ready" /> : <AgentAvailabilityIndicator indicator={agent.indicator} />}
						</button>
					))}
					{available.map((agent) => (
						<button
							type="button"
							key={agent.id}
							onClick={() => onInstall(agent.id)}
							onMouseEnter={() => onHover(agent.id)}
							onMouseLeave={() => onHover(null)}
							aria-label={`Install ${agent.name}`}
							className={cn(
								"flex h-10 w-full items-center gap-3 rounded-md px-2 text-left text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
								hovered === agent.id && "bg-foreground/[0.07] text-foreground",
							)}
						>
							<img src={agentIcon(agent.id)} alt="" className="size-5 shrink-0 object-contain opacity-65" />
							<span className="min-w-0 flex-1 truncate">{agent.name}</span>
							<span className="rounded-sm bg-foreground px-2 py-1 text-[10px] font-medium text-background">Install</span>
						</button>
					))}
				</div>
				{showTopFade ? <div className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-background via-background/80 to-transparent" aria-hidden="true" /> : null}
				<div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background via-background/80 to-transparent" aria-hidden="true" />
			</div>
		</section>
	);
}

function AgentAvailabilityIndicator({ indicator }: { indicator: OnboardingAgent["indicator"] }) {
	if (indicator === "checking") return <Loader2 aria-label="Checking availability" className="size-3.5 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />;
	if (indicator === "auth") return <CircleDashed aria-label="Authorization unavailable" className="size-3.5 shrink-0 text-muted-foreground" />;
	return null;
}

function AgentTopologyPreview({
	orchestratorAgent,
	workerAgent,
	hoveredOrchestrator,
	hoveredWorker,
}: {
	orchestratorAgent: string | null;
	workerAgent: string | null;
	hoveredOrchestrator: string | null;
	hoveredWorker: string | null;
}) {
	const reduceMotion = useReducedMotion();
	const signals = useTopologySignals(Boolean(reduceMotion));
	// Before a choice is made the illustration previews the hovered option. Once
	// selected, the committed choice is the source of truth and remains still.
	const orchestratorPreview = orchestratorAgent ?? hoveredOrchestrator;
	const workerPreview = workerAgent ?? hoveredWorker;
	const orchestratorSrc = (orchestratorPreview && agentIcon(orchestratorPreview)) || aoLogo;
	const workerSrc = workerPreview ? agentIcon(workerPreview) : undefined;
	const orchestratorName = "Orchestrator";
	const workerName = "Worker agents";

	return (
		<div className="relative mx-auto aspect-[560/430] w-full max-w-[400px] overflow-hidden rounded-2xl" aria-label="Agent hierarchy illustration">
			<svg viewBox="0 0 560 430" className="absolute inset-0 size-full text-foreground/20" fill="none" aria-hidden="true">
				<path d="M280 160v46M120 206h320M120 206v30M280 206v30M440 206v30" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
				{signals.map((signal) => <TopologySignal key={signal.id} signal={signal} />)}
			</svg>

			<div className="absolute left-1/2 top-[9.3%] -translate-x-1/2">
				<AgentIdentity iconClassName="size-12" name={orchestratorName} src={orchestratorSrc} textClassName="text-sm" />
			</div>

			{["left", "center", "right"].map((position) => (
				<div
					key={position}
					className={cn(
						"absolute top-[58.6%] flex -translate-x-1/2 flex-col items-center gap-2",
						position === "left" && "left-[21.43%]",
						position === "center" && "left-1/2 -translate-x-1/2",
						position === "right" && "left-[78.57%]",
					)}
				>
					<AgentIdentity iconClassName="size-8" name={workerName} src={workerSrc} textClassName="text-xs" />
				</div>
			))}
		</div>
	);
}

type TopologySignal = {
	id: number;
	workerIndex: 0 | 1 | 2;
	direction: "to-orchestrator" | "to-worker";
};

const WORKER_X = [120, 280, 440] as const;

function useTopologySignals(reduceMotion: boolean) {
	const [signals, setSignals] = useState<TopologySignal[]>([]);
	const nextId = useRef(0);

	useEffect(() => {
		if (reduceMotion) return;
		let signalTimer = 0;
		let scheduleTimer = 0;
		let active = true;

		const scheduleSignal = () => {
			scheduleTimer = window.setTimeout(() => {
				if (!active) return;
				const signal: TopologySignal = {
					id: nextId.current++,
					workerIndex: Math.floor(Math.random() * WORKER_X.length) as 0 | 1 | 2,
					direction: Math.random() > 0.5 ? "to-orchestrator" : "to-worker",
				};
				setSignals([signal]);
				signalTimer = window.setTimeout(() => setSignals([]), 920);
				scheduleSignal();
			}, 1800 + Math.random() * 2200);
		};

		scheduleSignal();
		return () => {
			active = false;
			window.clearTimeout(signalTimer);
			window.clearTimeout(scheduleTimer);
		};
	}, [reduceMotion]);

	return signals;
}

function TopologySignal({ signal }: { signal: TopologySignal }) {
	const workerX = WORKER_X[signal.workerIndex];
	const isUpstream = signal.direction === "to-orchestrator";
	const x = isUpstream ? [workerX, workerX, 280, 280] : [280, 280, workerX, workerX];
	const y = isUpstream ? [236, 206, 206, 160] : [160, 206, 206, 236];

	return (
		<motion.circle
			cx="0"
			cy="0"
			r="2.25"
			fill="currentColor"
			initial={{ opacity: 0, x: x[0], y: y[0] }}
			animate={{ opacity: [0, 0.85, 0.85, 0], x, y }}
			transition={{ duration: 0.86, ease: "easeInOut", times: [0, 0.12, 0.82, 1] }}
		/>
	);
}

function AgentIdentity({
	iconClassName,
	name,
	src,
	textClassName,
}: {
	iconClassName: string;
	name: string;
	src?: string;
	textClassName: string;
}) {
	const reduceMotion = useReducedMotion();
	return (
		<div className="flex flex-col items-center gap-2">
			<AnimatePresence initial={false} mode="wait">
				<motion.div
					key={src ?? "generic-worker"}
					initial={{ opacity: 0, filter: "blur(4px)" }}
					animate={{ opacity: 1, filter: "blur(0px)" }}
					exit={{ opacity: 0, filter: "blur(4px)" }}
					transition={{ duration: reduceMotion ? 0 : 0.14, ease: "easeOut" }}
				>
					{src ? <img src={src} alt="" className={cn(iconClassName, "object-contain")} /> : <GenericWorkerIcon />}
				</motion.div>
			</AnimatePresence>
			<span className={cn("whitespace-nowrap text-muted-foreground", textClassName)}>{name}</span>
		</div>
	);
}

function GenericWorkerIcon() {
	return (
		<svg viewBox="0 0 32 32" className="size-7 text-muted-foreground" fill="none" aria-hidden="true">
			<rect x="6" y="8" width="20" height="17" rx="4" stroke="currentColor" strokeWidth="1.5" />
			<path d="M16 4v4M11 15h.01M21 15h.01M11 20c2.7 2 7.3 2 10 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
		</svg>
	);
}

function ProjectPicker({
	path,
	mode,
	onModeChange,
	onPathChange,
	onSelectFolder,
}: {
	path: string;
	mode: "folder" | "git";
	onModeChange: (mode: "folder" | "git") => void;
	onPathChange: (path: string) => void;
	onSelectFolder: () => void;
}) {
	return (
		<div className="w-full max-w-[520px]">
			<div className="mb-3 inline-flex rounded-lg bg-card p-0.5">
				<ModeButton active={mode === "folder"} onClick={() => onModeChange("folder")}>Local folder</ModeButton>
				<ModeButton active={mode === "git"} onClick={() => onModeChange("git")}>Git repository</ModeButton>
			</div>
			{mode === "folder" ? (
				<button
					type="button"
					onClick={onSelectFolder}
					className="flex h-11 w-full items-center gap-2.5 rounded-lg bg-card px-3 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
				>
					<FolderIcon />
					<span className={cn("min-w-0 flex-1 truncate", path && "font-mono text-foreground")}>{path || "Choose a project folder"}</span>
				</button>
			) : (
				<label className="block">
					<span className="sr-only">Git repository URL</span>
					<input
						type="url"
						placeholder="https://github.com/you/project"
						value={path}
						onChange={(event) => onPathChange(event.target.value)}
						className="h-11 w-full rounded-lg bg-card px-3 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
					/>
				</label>
			)}
		</div>
	);
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"rounded-md px-3 py-1.5 text-[11px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				active ? "bg-foreground/15 text-foreground" : "text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

function PreviewStage({ step }: { step: Step }) {
	return (
		<div className="relative mx-auto aspect-[4/3] w-full max-w-[720px] overflow-hidden">
			<img
				src={step === "welcome" ? visibilityBackground : feedbackBackground}
				alt=""
				className="pointer-events-none absolute inset-0 size-full select-none object-cover"
			/>
			<div className="absolute inset-0 bg-background/35" />
			<div className="relative z-10 flex size-full items-center justify-center p-6">
				{step === "welcome" ? (
					<FleetBoardDemo assets={LANDING_PREVIEW_ASSETS} />
				) : (
					<div className="w-full [&_[class*='preview-terminal']]:font-mono [&_main]:font-mono">
						<FeedbackLoopDemo agentIcon={claudeCodeLogo} />
					</div>
				)}
			</div>
		</div>
	);
}

function FolderIcon() {
	return <svg viewBox="0 0 16 16" className="size-4 shrink-0 text-white/45" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><path d="M2.5 4.5A1.5 1.5 0 0 1 4 3h2l1.2 1.5H12A1.5 1.5 0 0 1 13.5 6v5A1.5 1.5 0 0 1 12 12.5H4A1.5 1.5 0 0 1 2.5 11V4.5Z" strokeLinejoin="round" /></svg>;
}

function CheckIcon({ className }: { className?: string }) {
	return <svg viewBox="0 0 16 16" className={cn("size-3 shrink-0", className)} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m4 8 2.5 2.5L12 5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
