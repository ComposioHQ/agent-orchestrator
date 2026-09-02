import { MoreHorizontal, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SessionFileTabState } from "../lib/session-file-tabs";
import { TerminalTabFrame } from "./TerminalTabFrame";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { WorkspaceEntryIcon } from "./WorkspaceEntryIcon";

function basename(path: string): string {
	return path.split("/").pop() || path;
}

export function SessionFileTabs({
	state,
	onAddFeedback,
	onActivateFile,
	onCloseFile,
	onCloseAll,
}: {
	state: SessionFileTabState;
	onAddFeedback: (path: string) => void;
	onActivateFile: (path: string) => void;
	onCloseFile: (path: string) => void;
	onCloseAll: () => void;
}) {
	if (state.openPaths.length === 0) return null;
	return (
		<>
			{state.openPaths.map((path) => (
				<SessionFileTab
					active={state.activePath === path}
					key={path}
					onActivate={() => onActivateFile(path)}
					onAddFeedback={() => onAddFeedback(path)}
					onClose={() => onCloseFile(path)}
					path={path}
				/>
			))}
			<SessionFileTabActions onCloseAll={onCloseAll} />
		</>
	);
}

export function SessionFileTab({
	active,
	onActivate,
	onAddFeedback,
	onClose,
	path,
}: {
	active: boolean;
	onActivate: () => void;
	onAddFeedback: () => void;
	onClose: () => void;
	path: string;
}) {
	const { t } = useTranslation();
	const name = basename(path);
	const closeAction = (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					aria-label={t("files.closeTab", { name })}
					className="grid size-icon-sm place-items-center rounded-sm text-passive opacity-0 pointer-events-none hover:bg-interactive-hover hover:text-foreground group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50"
					onClick={(event) => {
						event.stopPropagation();
						onClose();
					}}
					type="button"
				>
					<X className="size-icon-sm" aria-hidden="true" />
				</button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{t("files.closeTab", { name })}</TooltipContent>
		</Tooltip>
	);
	const feedbackAction = active ? (
		<Tooltip>
			<TooltipTrigger asChild>
				<button
					aria-label={t("files.addFileFeedback", { file: path })}
					className="grid size-5 shrink-0 place-items-center rounded-sm text-passive hover:bg-interactive-hover hover:text-foreground"
					onClick={(event) => {
						event.stopPropagation();
						onAddFeedback();
					}}
					type="button"
				>
					<Plus className="size-3" aria-hidden="true" />
				</button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{t("files.addFileFeedback", { file: path })}</TooltipContent>
		</Tooltip>
	) : undefined;
	return (
		<TerminalTabFrame
			action={closeAction}
			actionPosition="leading"
			active={active}
			buttonProps={{
				"aria-label": name,
				"aria-selected": active,
				onClick: onActivate,
				role: "tab",
				tabIndex: active ? 0 : -1,
				title: path,
				type: "button",
			}}
			className="session-tab-icon-floor session-tab-icon-floor--closable max-w-shell-tab-max"
			contentClassName="font-medium"
			trailingAction={feedbackAction}
		>
			<WorkspaceEntryIcon
				className="size-icon-base shrink-0 group-hover:opacity-0 group-focus-within:opacity-0"
				kind="file"
				name={name}
			/>
			<span className="truncate">{name}</span>
		</TerminalTabFrame>
	);
}

export function SessionFileTabActions({ onCloseAll }: { onCloseAll: () => void }) {
	const { t } = useTranslation();
	return (
		<DropdownMenu>
			<Tooltip>
				<TooltipTrigger asChild>
					<DropdownMenuTrigger asChild>
						<Button aria-label={t("files.tabActions")} className="mx-1 self-center" size="icon-sm" type="button" variant="ghost">
							<MoreHorizontal className="size-icon-sm" aria-hidden="true" />
						</Button>
					</DropdownMenuTrigger>
				</TooltipTrigger>
				<TooltipContent side="bottom">{t("files.tabActions")}</TooltipContent>
			</Tooltip>
			<DropdownMenuContent align="end">
				<DropdownMenuItem onSelect={onCloseAll}>{t("files.closeAllTabs")}</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
