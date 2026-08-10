import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Repeat2, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	findActiveAgentSwitch,
	findRecoveryRequiredAgentSwitch,
	useAgentSwitches,
} from "../hooks/useAgentSwitches";
import { clearSwitchAgentState, useSwitchAgentState } from "../hooks/useSwitchAgent";
import { agentLabel } from "../lib/agent-options";
import { cn } from "../lib/utils";
import { sessionIsActive, type WorkspaceSession } from "../types/workspace";
import { canSwitchAgentHarness, SwitchAgentDialog } from "./SwitchAgentDialog";
import { TopbarButton } from "./TopbarButton";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type TerminalSwitchAgentButtonProps = {
	session: WorkspaceSession;
};

export function TerminalSwitchAgentButton({ session }: TerminalSwitchAgentButtonProps) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const switches = useAgentSwitches(session.id).data ?? [];
	const activeSwitch = findActiveAgentSwitch(switches);
	const recoverySwitch = findRecoveryRequiredAgentSwitch(switches);
	const switchMutation = useSwitchAgentState(session.id);
	const targetHarness = activeSwitch?.targetHarness ?? switchMutation.input?.targetHarness;
	const switching = Boolean(!recoverySwitch && (activeSwitch || (switchMutation.isPending && targetHarness)));

	useEffect(() => {
		if (switchMutation.error) setOpen(true);
	}, [switchMutation.error]);

	if (
		session.kind !== "worker" ||
		session.isTerminated ||
		!canSwitchAgentHarness(session.provider) ||
		(!recoverySwitch && !switching && !sessionIsActive(session))
	) {
		return null;
	}

	const label = recoverySwitch
		? t("switchAgent.recovery.action")
		: switching && targetHarness
			? t("switchAgent.inProgress", { target: agentLabel(targetHarness) })
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
					<span className="inline-flex shrink-0">
						<TopbarButton
							aria-busy={switching ? true : undefined}
							aria-label={label}
							className={cn(
								recoverySwitch && "text-warning hover:bg-warning/10 hover:text-warning",
							)}
							onClick={() => setOpen(true)}
							type="button"
							variant="icon"
						>
							{recoverySwitch ? (
								<TriangleAlert aria-hidden="true" className="size-icon-sm" />
							) : switching ? (
								<LoaderCircle aria-hidden="true" className="size-icon-sm animate-spin" />
							) : (
								<Repeat2 aria-hidden="true" className="size-icon-md stroke-[1.8]" />
							)}
						</TopbarButton>
					</span>
				</TooltipTrigger>
				<TooltipContent>{label}</TooltipContent>
			</Tooltip>
			{open ? (
				<SwitchAgentDialog onOpenChange={handleOpenChange} open session={session} />
			) : null}
		</>
	);
}
