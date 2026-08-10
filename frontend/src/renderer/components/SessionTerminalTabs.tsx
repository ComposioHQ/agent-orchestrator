import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { defaultShortcutBindings, shortcutBindingLabel } from "../../shared/shortcuts";
import { getAgentActivityView } from "../lib/session-presentation";
import { isMacPlatform } from "../lib/platform";
import { cn } from "../lib/utils";
import type { WorkspaceSession } from "../types/workspace";
import { AgentAvatar } from "./AgentAvatar";
import { TopbarButton } from "./TopbarButton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

const newTerminalShortcutLabel = shortcutBindingLabel(
	defaultShortcutBindings("new-shell-terminal", isMacPlatform())[0],
	isMacPlatform(),
);

export function SessionTerminalTab({
	isActive,
	labelOverride,
	onSelect,
	session,
}: {
	isActive: boolean;
	labelOverride?: string;
	onSelect?: () => void;
	session: WorkspaceSession;
}) {
	const { t } = useTranslation();
	const label = labelOverride ?? (session.kind === "orchestrator" ? t("shell.orchestrator") : session.title);
	const activity = session.activity ? getAgentActivityView(session.activity, t) : undefined;

	return (
		<span
			data-terminal-role="primary"
			className={cn(
				"group relative inline-flex min-w-shell-tab-min shrink-0 self-stretch items-center justify-center border-r border-border bg-surface px-3 text-foreground transition-colors",
				isActive
					? "bg-overlay text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-foreground/80"
					: "text-muted-foreground hover:bg-raised hover:text-foreground",
			)}
		>
			<button
				aria-current={isActive}
				aria-label={activity ? `${label} · ${activity.label}` : label}
				aria-selected={isActive}
				className={cn(
					"inline-flex min-w-flex-min flex-none items-center justify-center gap-1.5 whitespace-nowrap text-control font-medium leading-none transition-colors",
					isActive ? "text-foreground" : "text-passive group-hover:text-foreground",
				)}
				onClick={onSelect}
				role="tab"
				tabIndex={isActive ? 0 : -1}
				title={label}
				type="button"
			>
				<AgentAvatar className="size-terminal-agent-icon" decorative provider={session.provider} />
				<span>{label}</span>
				{activity ? (
					<span
						aria-hidden="true"
						className={cn("ml-0.5 size-dot-sm shrink-0 rounded-full", activity.indicatorClassName)}
						title={activity.label}
					/>
				) : null}
			</button>
		</span>
	);
}

export function NewTerminalButton({
	disabled,
	error,
	onClick,
}: {
	disabled?: boolean;
	error?: string;
	onClick?: () => void;
}) {
	const { t } = useTranslation();
	const label = t("shortcut.new-shell-terminal");
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>
					<span className="inline-flex shrink-0">
						<TopbarButton
							aria-label={label}
							disabled={!onClick || disabled}
							onClick={onClick}
							title={error}
							type="button"
							variant="icon"
						>
							<Plus aria-hidden="true" className="size-icon-md" />
						</TopbarButton>
					</span>
				</TooltipTrigger>
				<TooltipContent>
					{error ?? t("terminal.newWithShortcut", { shortcut: newTerminalShortcutLabel })}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
