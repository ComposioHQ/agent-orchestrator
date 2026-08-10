import { ChevronLeft, ChevronRight } from "lucide-react";
import { Reorder, useDragControls } from "motion/react";
import { useEffect, type PointerEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ShellTerminal } from "../hooks/useShellTerminals";
import { useOverflowScroll } from "../hooks/useOverflowScroll";
import { handleTerminalTabListKeyDown } from "../lib/terminal-tabs";
import {
	resolveTerminalTabLayout,
	type ReorderableTerminalTabKey,
	type TerminalBarLayout,
	type TerminalTabGroup,
	type TerminalTabKey,
} from "../lib/terminal-tab-state";
import type { WorkspaceSession } from "../types/workspace";
import { ShellTerminalTab } from "./ShellTerminalTab";
import { SessionTerminalTab } from "./SessionTerminalTabs";

export type ReviewerTerminalTab = { handleId: string; harness: string; label?: string };

export type TerminalTabStripProps = {
	activeKey: TerminalTabKey;
	ariaLabel?: string;
	layout: TerminalBarLayout;
	ownerSession: WorkspaceSession;
	shellTerminals: ShellTerminal[];
	reviewerTerminal?: ReviewerTerminalTab;
	onClose: (key: ReorderableTerminalTabKey) => void;
	onPinnedChange: (key: ReorderableTerminalTabKey, pinned: boolean) => void;
	onRenameShell?: (handleId: string, title: string) => void;
	onReorder: (group: TerminalTabGroup, keys: ReorderableTerminalTabKey[]) => void;
	onSelect: (key: TerminalTabKey) => void;
};

function DraggableTab({ children, value }: { children: ReactNode; value: ReorderableTerminalTabKey }) {
	const controls = useDragControls();
	const startDrag = (event: PointerEvent<HTMLDivElement>) => {
		if ((event.target as HTMLElement).closest("[data-terminal-tab-action],input,a")) return;
		controls.start(event);
	};
	return (
		<Reorder.Item
			as="div"
			className="flex shrink-0 self-stretch touch-pan-y"
			data-terminal-tab-key={value}
			drag="x"
			dragControls={controls}
			dragListener={false}
			onPointerDown={startDrag}
			value={value}
		>
			{children}
		</Reorder.Item>
	);
}

function ScrollTabsButton({
	direction,
	label,
	onClick,
}: {
	direction: -1 | 1;
	label: string;
	onClick: () => void;
}) {
	const Icon = direction === -1 ? ChevronLeft : ChevronRight;
	return (
		<button
			aria-label={label}
			className="inline-flex size-control-sm shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent/50"
			onClick={onClick}
			title={label}
			type="button"
		>
			<Icon aria-hidden="true" className="size-icon-md" />
		</button>
	);
}

export function TerminalTabStrip({
	activeKey,
	ariaLabel,
	layout,
	ownerSession,
	shellTerminals,
	reviewerTerminal,
	onClose,
	onPinnedChange,
	onRenameShell,
	onReorder,
	onSelect,
}: TerminalTabStripProps) {
	const { t } = useTranslation();
	const ownerKey = `session:${ownerSession.id}` as const;
	const shells = new Map<ReorderableTerminalTabKey, ShellTerminal>(
		shellTerminals.map((shell) => [`shell:${shell.handleId}` as const, shell]),
	);
	const reviewerKey = reviewerTerminal ? (`reviewer:${reviewerTerminal.handleId}` as const) : undefined;
	const availableKeys: TerminalTabKey[] = [ownerKey, ...shells.keys()];
	if (reviewerKey) availableKeys.push(reviewerKey);
	const resolved = resolveTerminalTabLayout(layout, availableKeys);
	const overflowWatch = [activeKey, ...resolved.pinned, ...resolved.unpinned, reviewerKey ?? ""].join("|");
	const overflow = useOverflowScroll<HTMLDivElement>(overflowWatch);

	useEffect(() => {
		if (activeKey === ownerKey) return;
		const activeTab = Array.from(
			overflow.ref.current?.querySelectorAll<HTMLElement>("[data-terminal-tab-key]") ?? [],
		).find((element) => element.dataset.terminalTabKey === activeKey);
		activeTab?.scrollIntoView?.({ behavior: "smooth", block: "nearest", inline: "nearest" });
	}, [activeKey, overflow.ref, ownerKey]);

	const renderTab = (key: ReorderableTerminalTabKey, pinned: boolean) => {
		const shell = shells.get(key);
		if (!shell) return null;
		return (
			<ShellTerminalTab
				appearance="connected"
				isActive={activeKey === key}
				isPinned={pinned}
				onClose={() => onClose(key)}
				onPinnedChange={(next) => onPinnedChange(key, next)}
				onRename={onRenameShell ? (title) => onRenameShell(shell.handleId, title) : undefined}
				onSelect={() => onSelect(key)}
				shell={shell}
			/>
		);
	};

	const group = (name: TerminalTabGroup, keys: ReorderableTerminalTabKey[]) => (
		<Reorder.Group
			as="div"
			axis="x"
			className="flex self-stretch"
			onReorder={(next) => onReorder(name, next)}
			values={keys}
		>
			{keys.map((key) => (
				<DraggableTab key={key} value={key}>
					{renderTab(key, name === "pinned")}
				</DraggableTab>
			))}
		</Reorder.Group>
	);

	return (
		<div
			aria-label={ariaLabel ?? t("terminal.tabsAria")}
			className="flex min-w-0 flex-1 self-stretch items-center"
			onKeyDown={handleTerminalTabListKeyDown}
			role="tablist"
		>
			<SessionTerminalTab
				isActive={activeKey === ownerKey}
				onSelect={() => onSelect(ownerKey)}
				session={ownerSession}
			/>
			{overflow.canScrollLeft ? (
				<ScrollTabsButton
					direction={-1}
					label={t("terminal.scrollTabsLeft")}
					onClick={() => overflow.scrollByDirection(-1)}
				/>
			) : null}
			<div
				ref={overflow.ref}
				className="scrollbar-none flex min-w-0 flex-1 self-stretch items-center overflow-x-auto"
			>
				{group("pinned", resolved.pinned)}
				{group("unpinned", resolved.unpinned)}
				{reviewerTerminal && reviewerKey ? (
					<span className="inline-flex shrink-0 self-stretch" data-terminal-tab-key={reviewerKey}>
						<SessionTerminalTab
							isActive={activeKey === reviewerKey}
							labelOverride={reviewerTerminal.label ?? "Reviewer"}
							onSelect={() => onSelect(reviewerKey)}
							session={{
								...ownerSession,
								id: reviewerTerminal.handleId,
								provider: reviewerTerminal.harness as WorkspaceSession["provider"],
								title: reviewerTerminal.label ?? "Reviewer",
							}}
						/>
					</span>
				) : null}
			</div>
			{overflow.canScrollRight ? (
				<ScrollTabsButton
					direction={1}
					label={t("terminal.scrollTabsRight")}
					onClick={() => overflow.scrollByDirection(1)}
				/>
			) : null}
		</div>
	);
}
