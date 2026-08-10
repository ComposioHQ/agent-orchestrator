import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import aoLogo from "../../../assets/ao-logo.svg";
import { apiClient } from "../lib/api-client";
import { InstallDependencyDialog } from "./InstallDependencyDialog";
import { SystemRequirementsChecklist, type SystemRequirement } from "./SystemRequirementsChecklist";

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

function isBlocked(requirements: SystemRequirement[]): boolean {
	return requirements.some((requirement) => requirement.required && !requirement.satisfied);
}

export function DaemonStartupLoader() {
	const { t } = useTranslation();
	const [phase, setPhase] = useState<"requirements" | "phrases">("requirements");
	const [phraseIndex, setPhraseIndex] = useState(0);

	const requirementsQuery = useQuery({
		queryKey: ["system-requirements"],
		queryFn: async () => {
			const { data, error } = await apiClient.GET("/api/v1/system/requirements");
			if (error || !data) throw new Error("Could not check local requirements.");
			return data;
		},
		refetchOnWindowFocus: false,
	});

	const requirements = requirementsQuery.data?.requirements ?? [];
	const blocked = requirementsQuery.isSuccess && isBlocked(requirements);
	const ready = requirementsQuery.isSuccess && !blocked;
	// The daemon is already confirmed reachable by the time this component
	// mounts (see SessionsBoard's showStartup gate) — if the readiness probe
	// itself errors out, fail open rather than stranding the user on
	// "Checking your setup" forever.
	const probeFailed = requirementsQuery.isError;

	// Once every required check passes (or the probe itself failed), hold the
	// state briefly, then fall through to the pre-existing phrase-rotation loader.
	useEffect(() => {
		if (phase !== "requirements" || !(ready || probeFailed)) return;
		const timer = window.setTimeout(() => setPhase("phrases"), READY_HOLD_MS);
		return () => window.clearTimeout(timer);
	}, [phase, ready, probeFailed]);

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
					<p className="mt-2 min-h-5 text-md-sm text-muted-foreground">Checking your setup</p>
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
