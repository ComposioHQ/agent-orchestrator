import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import aoLogo from "../../../assets/ao-logo.svg";
import { useSystemRequirementsGate } from "../hooks/useSystemRequirementsGate";
import { InstallDependencyDialog } from "./InstallDependencyDialog";
import { SystemRequirementsChecklist } from "./SystemRequirementsChecklist";

const STARTUP_PHRASE_KEYS = [
	"startup.startingServices",
	"startup.connectingDaemon",
	"startup.loadingWorkspaces",
	"startup.preparingBoard",
] as const;

const PHRASE_INTERVAL_MS = 2_200;

// Beat the "All checks passed" state holds before handing off to the
// existing phrase-rotation presentation (brief: ~600-800ms).
const READY_HOLD_MS = 700;

export function DaemonStartupLoader() {
	const { t } = useTranslation();
	const [phase, setPhase] = useState<"requirements" | "phrases">("requirements");
	const [phraseIndex, setPhraseIndex] = useState(0);

	// Shared with SessionsBoard's showStartup gate (same react-query cache
	// entry) so this component and the mount decision that keeps it on screen
	// never disagree about whether the machine is actually ready.
	const { query: requirementsQuery, requirements, blocked, ready, probeFailed } = useSystemRequirementsGate();

	// Once every required check passes (or the probe itself failed), hold the
	// state briefly, then fall through to the pre-existing phrase-rotation loader.
	useEffect(() => {
		if (phase !== "requirements" || !(ready || probeFailed)) return;
		const timer = window.setTimeout(() => setPhase("phrases"), READY_HOLD_MS);
		return () => window.clearTimeout(timer);
	}, [phase, ready, probeFailed]);

	// Defensive: if a requirement regresses after we've already moved on to
	// the phrase-rotation phase (e.g. a stale refetch), fall back to showing
	// the checklist/dialog rather than silently staying on the wrong phase.
	useEffect(() => {
		if (blocked) setPhase("requirements");
	}, [blocked]);

	useEffect(() => {
		if (phase !== "phrases") return;
		const timer = window.setInterval(() => {
			setPhraseIndex((current) => (current + 1) % STARTUP_PHRASE_KEYS.length);
		}, PHRASE_INTERVAL_MS);
		return () => window.clearInterval(timer);
	}, [phase]);

	const phrase = t(STARTUP_PHRASE_KEYS[phraseIndex]);

	return (
		<div
			aria-busy="true"
			aria-label={t("startup.aria", { brand: "Agent Orchestrator" })}
			aria-live="polite"
			className="ao-startup-screen flex h-full w-full items-center justify-center bg-background text-foreground"
			data-testid="daemon-startup-loader"
			role="status"
		>
			<div className="ao-startup-content flex -translate-y-[3vh] flex-col items-center text-center">
				<div className="grid h-28 w-32 place-items-center" aria-hidden="true">
					<img className="ao-startup-logo h-22 w-25 object-contain" src={aoLogo} alt="" />
				</div>
				<p className="mt-5 text-base font-semibold tracking-tight text-foreground">Agent Orchestrator</p>
				{phase === "phrases" ? (
					<p className="mt-2 min-h-5 text-md-sm text-muted-foreground">
						<span aria-hidden="true" className="ao-startup-status" key={phrase}>
							{phrase}
						</span>
					</p>
				) : requirementsQuery.isSuccess ? (
					<SystemRequirementsChecklist requirements={requirements} ready={ready} />
				) : (
					<p className="mt-2 min-h-5 text-md-sm text-muted-foreground">{t("startup.checkingSetup")}</p>
				)}
				<div className="ao-startup-dots mt-3 flex h-4 items-center gap-1.5" aria-hidden="true">
					<span />
					<span />
					<span />
				</div>
			</div>
			{blocked ? (
				<InstallDependencyDialog requirements={requirements} onRefetchRequirements={() => void requirementsQuery.refetch()} />
			) : null}
		</div>
	);
}
