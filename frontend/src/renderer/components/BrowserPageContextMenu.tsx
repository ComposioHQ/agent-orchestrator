import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import type {
	BrowserContextMenuAction,
	BrowserContextMenuRequest,
} from "../../shared/browser-context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

type BrowserPageContextMenuProps = {
	request: BrowserContextMenuRequest | null;
	canAnnotate: boolean;
	onAnnotate: () => void;
	onAction: (action: BrowserContextMenuAction) => void;
	onDismiss: (restoreFocus: boolean) => void;
};

export function BrowserPageContextMenu({
	request,
	canAnnotate,
	onAnnotate,
	onAction,
	onDismiss,
}: BrowserPageContextMenuProps) {
	const { t } = useTranslation();
	const selectedRef = useRef(false);
	useEffect(() => {
		selectedRef.current = false;
	}, [request?.requestId]);
	if (!request) return null;
	const hasLinkActions = request.actions.some((action) =>
		["open-link-tab", "open-link-external", "copy-link"].includes(action),
	);
	const hasSelection = request.actions.includes("copy-selection");
	const select = (action: BrowserContextMenuAction) => {
		selectedRef.current = true;
		onAction(action);
	};

	return (
		<DropdownMenu
			open
			onOpenChange={(open) => {
				if (open) return;
				if (selectedRef.current) {
					selectedRef.current = false;
					return;
				}
				onDismiss(true);
			}}
		>
			<DropdownMenuTrigger asChild>
				<button
					aria-hidden="true"
					className="pointer-events-none fixed size-px opacity-0"
					data-testid="browser-context-menu-anchor"
					style={{ left: request.position.x, top: request.position.y }}
					tabIndex={-1}
					type="button"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				align="start"
				className="min-w-52"
				data-browser-native-overlay="true"
				side="bottom"
				sideOffset={0}
			>
				<DropdownMenuItem
					disabled={!canAnnotate}
					onSelect={() => {
						selectedRef.current = true;
						onAnnotate();
					}}
				>
					{t("browser.contextMenu.annotate")}
				</DropdownMenuItem>
				{hasLinkActions ? <DropdownMenuSeparator /> : null}
				{request.actions.includes("open-link-tab") ? (
					<DropdownMenuItem onSelect={() => select("open-link-tab")}>
						{t("browser.contextMenu.openLinkTab")}
					</DropdownMenuItem>
				) : null}
				{request.actions.includes("open-link-external") ? (
					<DropdownMenuItem onSelect={() => select("open-link-external")}>
						{t("browser.contextMenu.openExternal")}
					</DropdownMenuItem>
				) : null}
				{request.actions.includes("copy-link") ? (
					<DropdownMenuItem onSelect={() => select("copy-link")}>
						{t("browser.contextMenu.copyLink")}
					</DropdownMenuItem>
				) : null}
				{hasSelection ? <DropdownMenuSeparator /> : null}
				{hasSelection ? (
					<DropdownMenuItem onSelect={() => select("copy-selection")}>
						{t("browser.contextMenu.copy")}
					</DropdownMenuItem>
				) : null}
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={() => select("inspect")}>
					{t("browser.contextMenu.inspect")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
