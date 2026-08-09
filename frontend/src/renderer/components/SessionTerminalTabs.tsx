import { Plus, Terminal, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { defaultShortcutBindings, shortcutBindingLabel } from "../../shared/shortcuts";
import { isMacPlatform } from "../lib/platform";
import { cn } from "../lib/utils";
import type { WorkspaceSession } from "../types/workspace";
import { AgentAvatar } from "./AgentAvatar";
import { Button } from "./ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuShortcut,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

const newTerminalShortcutLabel = shortcutBindingLabel(
	defaultShortcutBindings("new-shell-terminal", isMacPlatform())[0],
	isMacPlatform(),
);

type SessionTerminalTabsProps = {
	activeSessionId?: string;
	isSessionSurfaceActive: boolean;
	onCloseProjectSession?: (session: WorkspaceSession) => void;
	onSelectProjectSession?: (session: WorkspaceSession) => void;
	projectSessions: WorkspaceSession[];
};

export function SessionTerminalTabs({
	activeSessionId,
	isSessionSurfaceActive,
	onCloseProjectSession,
	onSelectProjectSession,
	projectSessions,
}: SessionTerminalTabsProps) {
	const ownerSessionId = projectSessions[0]?.id;

	return projectSessions.map((session) => (
		<SessionTerminalTab
			key={session.id}
			isActive={isSessionSurfaceActive && session.id === activeSessionId}
			isCloseable={session.id !== ownerSessionId}
			onClose={onCloseProjectSession ? () => onCloseProjectSession(session) : undefined}
			onSelect={onSelectProjectSession ? () => onSelectProjectSession(session) : undefined}
			session={session}
		/>
	));
}

function SessionTerminalTab({
	isActive,
	isCloseable,
	onClose,
	onSelect,
	session,
}: {
	isActive: boolean;
	isCloseable: boolean;
	onClose?: () => void;
	onSelect?: () => void;
	session: WorkspaceSession;
}) {
	const { t } = useTranslation();
	const label = session.kind === "orchestrator" ? t("shell.orchestrator") : session.title;

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
			{isCloseable && onClose ? (
				<button
					aria-label={t("terminal.closeSessionTab", { label })}
					className="ml-1 inline-flex size-icon-xl shrink-0 items-center justify-center rounded-sm text-passive transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50"
					onClick={onClose}
					type="button"
				>
					<X aria-hidden="true" className="size-icon-sm" />
				</button>
			) : null}
		</span>
	);
}

export function SessionTerminalPicker({
	availableProjectSessions,
	openProjectSessionIds = [],
	newTerminalDisabled,
	newTerminalError,
	onAddProjectSession,
	onNewTerminal,
}: {
	availableProjectSessions: WorkspaceSession[];
	openProjectSessionIds?: string[];
	newTerminalDisabled?: boolean;
	newTerminalError?: string;
	onAddProjectSession?: (session: WorkspaceSession) => void;
	onNewTerminal?: () => void;
}) {
	const { t } = useTranslation();
	const openSessionIds = new Set(openProjectSessionIds);
	const sessionsToAdd = availableProjectSessions.filter((session) => !openSessionIds.has(session.id));
	const disabled = (!onNewTerminal || newTerminalDisabled) && sessionsToAdd.length === 0;
	const pickerLabel = t("terminal.addTerminalOrSession");
	return (
		<DropdownMenu modal={false}>
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<Button
								aria-label={pickerLabel}
								className="shrink-0 text-muted-foreground"
								disabled={disabled}
								size="icon-sm"
								type="button"
								variant="outline"
							>
								<Plus aria-hidden="true" className="size-icon-md" />
							</Button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent>{pickerLabel}</TooltipContent>
				</Tooltip>
			</TooltipProvider>
			<DropdownMenuContent align="start" className="w-64">
				<DropdownMenuItem
					disabled={!onNewTerminal || newTerminalDisabled}
					onSelect={onNewTerminal}
					title={newTerminalError}
				>
					<Terminal aria-hidden="true" />
					<span>{t("shortcut.new-shell-terminal")}</span>
					<DropdownMenuShortcut>{newTerminalShortcutLabel}</DropdownMenuShortcut>
				</DropdownMenuItem>
				{sessionsToAdd.length > 0 ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuLabel>{t("command.group.sessions")}</DropdownMenuLabel>
						{sessionsToAdd.map((session) => (
							<DropdownMenuItem key={session.id} onSelect={() => onAddProjectSession?.(session)}>
								<AgentAvatar className="size-terminal-agent-icon" decorative provider={session.provider} />
								<span className="truncate">{session.title}</span>
							</DropdownMenuItem>
						))}
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
