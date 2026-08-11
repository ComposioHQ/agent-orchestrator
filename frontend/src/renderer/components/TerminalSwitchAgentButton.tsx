import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Repeat2, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { clearSwitchAgentState } from "../hooks/useSwitchAgent";
import type { AgentSwitchPresentation } from "../lib/agent-switch-presentation";
import { cn } from "../lib/utils";
import { sessionIsActive, type WorkspaceSession } from "../types/workspace";
import { canSwitchAgentHarness, SwitchAgentDialog } from "./SwitchAgentDialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

type TerminalSwitchAgentButtonProps = {
	container: HTMLElement | null | undefined;
	onOpenChange: ((open: boolean) => void) | undefined;
	open: boolean;
	presentation?: AgentSwitchPresentation;
	session: WorkspaceSession;
	switchError: string | null;
};

export function TerminalSwitchAgentButton({
	container,
	onOpenChange,
	open,
	presentation,
	session,
	switchError,
}: TerminalSwitchAgentButtonProps) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const controlPresentation = presentation?.outcome === "success" ? undefined : presentation;
	const switching = controlPresentation?.outcome === "in_progress";
	const warning = controlPresentation?.outcome === "failure" || controlPresentation?.outcome === "recovery";
	const blocksNewSwitch = switching;

	useEffect(() => {
		if (switchError) onOpenChange?.(true);
	}, [onOpenChange, switchError]);

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
		onOpenChange?.(nextOpen);
		if (!nextOpen && switchError) {
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
						disabled={blocksNewSwitch}
						onClick={() => handleOpenChange(true)}
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
			{open && container ? (
				<SwitchAgentDialog container={container} onOpenChange={handleOpenChange} open session={session} />
			) : null}
		</>
	);
}
