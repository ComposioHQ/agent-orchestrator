import { Reorder, useDragControls } from "motion/react";
import { type PointerEvent, type ReactNode } from "react";
import type { ShellTerminal } from "../hooks/useShellTerminals";
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
	layout: TerminalBarLayout;
	ownerSession: WorkspaceSession;
	shellTerminals: ShellTerminal[];
	reviewerTerminal?: ReviewerTerminalTab;
	renderSessionAction?: (session: WorkspaceSession) => ReactNode;
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
			className="flex self-stretch touch-pan-y"
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

export function TerminalTabStrip({
	activeKey,
	layout,
	ownerSession,
	shellTerminals,
	reviewerTerminal,
	renderSessionAction,
	onClose,
	onPinnedChange,
	onRenameShell,
	onReorder,
	onSelect,
}: TerminalTabStripProps) {
	const ownerKey = `session:${ownerSession.id}` as const;
	const shells = new Map<TerminalTabKey, ShellTerminal>(
		shellTerminals.map((shell) => [`shell:${shell.handleId}` as const, shell]),
	);
	const reviewerKey = reviewerTerminal ? (`reviewer:${reviewerTerminal.handleId}` as const) : undefined;
	const availableKeys: TerminalTabKey[] = [ownerKey, ...shells.keys()];
	if (reviewerKey) availableKeys.push(reviewerKey);
	const resolved = resolveTerminalTabLayout(layout, availableKeys, ownerKey);

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
		<>
			<SessionTerminalTab
				action={renderSessionAction?.(ownerSession)}
				isActive={activeKey === ownerKey}
				onSelect={() => onSelect(ownerKey)}
				session={ownerSession}
			/>
			{group("pinned", resolved.pinned)}
			{group("unpinned", resolved.unpinned)}
			{reviewerTerminal && reviewerKey ? (
				<SessionTerminalTab
					isActive={activeKey === reviewerKey}
					labelOverride={reviewerTerminal.label ?? "Reviewer"}
					onSelect={() => onSelect(reviewerKey)}
					session={{
						...ownerSession,
						id: reviewerKey,
						provider: reviewerTerminal.harness as WorkspaceSession["provider"],
						title: reviewerTerminal.label ?? "Reviewer",
					}}
				/>
			) : null}
		</>
	);
}
