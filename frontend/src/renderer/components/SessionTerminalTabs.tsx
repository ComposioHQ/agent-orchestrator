import { Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { defaultShortcutBindings, shortcutBindingLabel } from "../../shared/shortcuts";
import { isMacPlatform } from "../lib/platform";
import { cn } from "../lib/utils";
import type { WorkspaceSession } from "../types/workspace";
import { AgentAvatar } from "./AgentAvatar";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

const newTerminalShortcutLabel = shortcutBindingLabel(
	defaultShortcutBindings("new-shell-terminal", isMacPlatform())[0],
	isMacPlatform(),
);

export function SessionTerminalTab({
	action,
	isActive,
	labelOverride,
	onSelect,
	session,
}: {
	action?: ReactNode;
	isActive: boolean;
	labelOverride?: string;
	onSelect?: () => void;
	session: WorkspaceSession;
}) {
	const { t } = useTranslation();
	const label = labelOverride ?? (session.kind === "orchestrator" ? t("shell.orchestrator") : session.title);

	return (
		<span
			data-terminal-role="primary"
			className={cn(
				"group relative inline-flex min-w-shell-tab-min self-stretch items-center justify-center border-r border-border bg-surface px-3 text-foreground transition-colors",
				isActive
					? "bg-overlay text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-foreground/80"
					: "text-muted-foreground hover:bg-raised hover:text-foreground",
			)}
		>
			<button
				aria-current={isActive}
				aria-label={label}
				aria-selected={isActive}
				className={cn(
					"inline-flex min-w-flex-min max-w-shell-tab-max flex-1 items-center justify-center gap-1.5 text-control font-medium leading-none transition-colors",
					isActive ? "text-foreground" : "text-passive group-hover:text-foreground",
				)}
				onClick={onSelect}
				role="tab"
				tabIndex={isActive ? 0 : -1}
				title={label}
				type="button"
			>
				<AgentAvatar className="size-terminal-agent-icon" decorative provider={session.provider} />
				<span className="truncate">{label}</span>
			</button>
			{action}
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
					<Button
						aria-label={label}
						className="shrink-0 text-muted-foreground"
						disabled={!onClick || disabled}
						onClick={onClick}
						size="icon-sm"
						title={error}
						type="button"
						variant="outline"
					>
						<Plus aria-hidden="true" className="size-icon-md" />
					</Button>
				</TooltipTrigger>
				<TooltipContent>
					{error ?? t("terminal.newWithShortcut", { shortcut: newTerminalShortcutLabel })}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
}
