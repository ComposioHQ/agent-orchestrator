import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Repeat2, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	findActiveAgentSwitch,
	findRecoveryRequiredAgentSwitch,
	isTerminalAgentSwitch,
	useAgentSwitches,
} from "../hooks/useAgentSwitches";
import { clearSwitchAgentState, useSwitchAgentState } from "../hooks/useSwitchAgent";
import { deriveAgentSwitchPresentation } from "../lib/agent-switch-presentation";
import { cn } from "../lib/utils";
import {
	sessionIsActive,
	type AgentSwitchSummary,
	type WorkspaceSession,
} from "../types/workspace";
import { canSwitchAgentHarness, SwitchAgentDialog } from "./SwitchAgentDialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type TerminalSwitchAgentButtonProps = {
	session: WorkspaceSession;
};

export function TerminalSwitchAgentButton({ session }: TerminalSwitchAgentButtonProps) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const switches = useAgentSwitches(session.id).data ?? [];
	const switchMutation = useSwitchAgentState(session.id);
	const observedNonterminalSwitchIdsRef = useRef(new Set<string>());
	const sessionSwitch = session.activeAgentSwitch;
	const detailedSessionSwitch = sessionSwitch
		? switches.find((entry) => entry.id === sessionSwitch.id)
		: undefined;
	const activeHistorySwitch = findActiveAgentSwitch(switches);
	const recoveryHistorySwitch = findRecoveryRequiredAgentSwitch(switches);
	const latestCompletedSwitch = switches[0]?.state === "completed" ? switches[0] : undefined;
	if (sessionSwitch && !isTerminalAgentSwitch(sessionSwitch)) {
		observedNonterminalSwitchIdsRef.current.add(sessionSwitch.id);
	}
	if (activeHistorySwitch) observedNonterminalSwitchIdsRef.current.add(activeHistorySwitch.id);
	const observedTerminalSwitch = switches.find(
		(entry) =>
			isTerminalAgentSwitch(entry) && observedNonterminalSwitchIdsRef.current.has(entry.id),
	);
	const currentSwitch =
		detailedSessionSwitch ??
		sessionSwitch ??
		recoveryHistorySwitch ??
		activeHistorySwitch;
	const admissionSwitch: AgentSwitchSummary<string> | undefined =
		!currentSwitch && switchMutation.isPending && switchMutation.input
			? {
				agentHandoffStatus: "not_attempted",
				fromHarness: switchMutation.input.session.provider,
				id: `admission:${switchMutation.input.idempotencyKey}`,
				requestedAt: "",
				semanticHandoffIncluded: true,
				sessionId: switchMutation.input.session.id,
				state: "preparing_handoff",
				targetHarness: switchMutation.input.targetHarness,
				updatedAt: "",
			}
			: undefined;
	const agentSwitch =
		currentSwitch ??
		admissionSwitch ??
		latestCompletedSwitch ??
		observedTerminalSwitch;
	if (agentSwitch && !isTerminalAgentSwitch(agentSwitch)) {
		observedNonterminalSwitchIdsRef.current.add(agentSwitch.id);
	}
	const presentation = agentSwitch
		? deriveAgentSwitchPresentation({
			agentSwitch,
			activityState: session.activity?.state,
			currentHarness: session.provider,
			isTerminated: Boolean(session.isTerminated),
			terminalHandleId: session.terminalHandleId,
		})
		: undefined;
	const controlPresentation = presentation?.outcome === "success" ? undefined : presentation;
	const switching = controlPresentation?.outcome === "in_progress";
	const warning = controlPresentation?.outcome === "failure" || controlPresentation?.outcome === "recovery";

	useEffect(() => {
		if (switchMutation.error) setOpen(true);
	}, [switchMutation.error]);

	if (
		session.kind !== "worker" ||
		session.isTerminated ||
		!canSwitchAgentHarness(session.provider) ||
		(!controlPresentation && !sessionIsActive(session))
	) {
		return null;
	}

	const label = controlPresentation
		? t(controlPresentation.compactLabelKey, controlPresentation.values)
		: t("switchAgent.action");
	const handleOpenChange = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen && switchMutation.error) {
			clearSwitchAgentState(queryClient, session.id);
		}
	};

	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						aria-busy={switching && controlPresentation?.animate ? true : undefined}
						aria-label={label}
						className={cn(
							"ml-1 grid size-6 shrink-0 place-items-center rounded-full border border-border/70 bg-background/45 text-muted-foreground transition-colors hover:border-border-strong hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50",
							warning && "border-warning/50 text-warning hover:border-warning/70 hover:text-warning",
						)}
						onClick={() => setOpen(true)}
						type="button"
					>
						{warning ? (
							<TriangleAlert aria-hidden="true" className="size-icon-sm" />
						) : switching ? (
							<LoaderCircle aria-hidden="true" className="agent-switch-toolbar-spinner size-icon-sm animate-spin" />
						) : (
							<Repeat2 aria-hidden="true" className="size-4 stroke-[1.8]" />
						)}
					</button>
				</TooltipTrigger>
				<TooltipContent>{label}</TooltipContent>
			</Tooltip>
			{open ? (
				<SwitchAgentDialog onOpenChange={handleOpenChange} open session={session} />
			) : null}
		</>
	);
}
