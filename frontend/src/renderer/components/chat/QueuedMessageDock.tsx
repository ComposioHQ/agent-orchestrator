import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { ChevronDown, Circle, CornerDownLeft, Pencil, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";
import type { ConversationMessage } from "../../types/conversation";

export type QueuedMessage = { turnId: string; message: ConversationMessage };

const QUEUE_DOCK_VISIBLE_ROWS = 5;

function QueuedMessageRow({
	turnId,
	message,
	hiddenFromView,
	showHoverSteer,
	canSteer,
	onPromoteQueuedTurn,
	onBeginQueuedEdit,
	onCancelQueuedTurn,
	busy,
	error,
	onRunAction,
}: {
	turnId: string;
	message: ConversationMessage;
	hiddenFromView?: boolean;
	showHoverSteer?: boolean;
	canSteer?: boolean;
	onPromoteQueuedTurn?: (turnId: string) => Promise<unknown>;
	onBeginQueuedEdit?: (turnId: string, text: string) => void;
	onCancelQueuedTurn?: (turnId: string) => Promise<unknown>;
	busy?: boolean;
	error?: string;
	onRunAction: (turnId: string, action: () => Promise<unknown>) => void;
}) {
	return (
		<div
			className="queue-dock-row group/queued-row"
			data-testid={`queued-message-${turnId}`}
			aria-hidden={hiddenFromView ? true : undefined}
			inert={hiddenFromView ? true : undefined}
		>
			<div className="flex min-h-9 min-w-0 items-center gap-2.5 px-3 py-1.5">
				<Circle
					aria-hidden="true"
					className="size-3 shrink-0 text-muted-foreground/60"
					strokeWidth={1.5}
				/>
				<p
					className="min-w-0 flex-1 truncate text-xs leading-relaxed text-foreground"
					title={message.text}
				>
					{message.text}
				</p>
				<div className="queue-dock-actions flex shrink-0 items-center gap-0.5 whitespace-nowrap">
					{showHoverSteer && onPromoteQueuedTurn ? (
						<button
							type="button"
							disabled={busy}
							onClick={() => {
								void onRunAction(turnId, () => onPromoteQueuedTurn(turnId));
							}}
							className="inline-flex h-7 items-center rounded-lg px-2 text-[11px] leading-none text-muted-foreground opacity-0 pointer-events-none transition-[background-color,color] duration-150 ease-out hover:bg-interactive-hover hover:text-foreground group-hover/queued-row:pointer-events-auto group-hover/queued-row:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100 disabled:opacity-50 motion-reduce:transition-none"
							aria-label="Steer this queued message into the running turn"
							title="Steer into running turn"
						>
							Steer
						</button>
					) : null}
					{canSteer && onPromoteQueuedTurn ? (
						<button
							type="button"
							disabled={busy}
							onClick={() => {
								void onRunAction(turnId, () => onPromoteQueuedTurn(turnId));
							}}
							className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] leading-none text-muted-foreground transition-[scale,background-color,color] duration-150 ease-out hover:bg-interactive-hover hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100"
							aria-label="Steer this queued message into the running turn"
							title="Steer into running turn"
						>
							<span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
								<CornerDownLeft aria-hidden="true" className="shrink-0" width={12} height={12} strokeWidth={2} />
							</span>
							Steer
						</button>
					) : null}
					{onBeginQueuedEdit ? (
						<button
							type="button"
							disabled={busy}
							onClick={() => onBeginQueuedEdit(turnId, message.text)}
							className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-[scale,background-color,color] duration-150 ease-out hover:bg-interactive-hover hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100"
							aria-label="Edit queued message"
							title="Edit"
						>
							<Pencil aria-hidden="true" className="shrink-0" width={12} height={12} strokeWidth={2} />
						</button>
					) : null}
					{onCancelQueuedTurn ? (
						<button
							type="button"
							disabled={busy}
							onClick={() => {
								void onRunAction(turnId, () => onCancelQueuedTurn(turnId));
							}}
							className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-[scale,background-color,color] duration-150 ease-out hover:bg-interactive-hover hover:text-destructive active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100"
							aria-label="Delete queued message"
							title="Delete"
						>
							<Trash2 aria-hidden="true" className="shrink-0" width={12} height={12} strokeWidth={2} />
						</button>
					) : null}
				</div>
			</div>
			{error ? (
				<p role="status" className="px-3 pb-2 text-[11px] text-warning">
					{error}
				</p>
			) : null}
		</div>
	);
}

export function QueuedMessageDock({
	messages,
	editingTurnId,
	canSteer,
	canSteerNext,
	steerNextRequest,
	onPromoteQueuedTurn,
	onBeginQueuedEdit,
	onCancelQueuedTurn,
	promotePendingTurnId,
	cancelPendingTurnId,
}: {
	messages: QueuedMessage[];
	editingTurnId?: string;
	canSteer?: boolean;
	canSteerNext?: boolean;
	steerNextRequest?: number;
	onPromoteQueuedTurn?: (turnId: string) => Promise<unknown>;
	onBeginQueuedEdit?: (turnId: string, text: string) => void;
	onCancelQueuedTurn?: (turnId: string) => Promise<unknown>;
	promotePendingTurnId?: string;
	cancelPendingTurnId?: string;
}) {
	const [expanded, setExpanded] = useState(true);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [optimisticallySteeredTurnIds, setOptimisticallySteeredTurnIds] = useState<Set<string>>(
		() => new Set(),
	);
	const scrollRef = useRef<HTMLDivElement>(null);
	const [handledSteerNextRequest, setHandledSteerNextRequest] = useState(steerNextRequest ?? 0);
	const steerNextInFlight = useRef(false);

	const runAction = useCallback(
		async (turnId: string, action: () => Promise<unknown>) => {
			setErrors((current) => {
				if (!current[turnId]) return current;
				const next = { ...current };
				delete next[turnId];
				return next;
			});
			try {
				await action();
			} catch (error) {
				setErrors((current) => ({
					...current,
					[turnId]: error instanceof Error ? error.message : "That action failed.",
				}));
			}
		},
		[],
	);

	const visibleMessages = messages.filter(({ turnId }) => !optimisticallySteeredTurnIds.has(turnId));
	const count = visibleMessages.length;
	const hasMore = count > 1;
	const isOpen = !hasMore || expanded;
	const expandedRows = Math.min(count, QUEUE_DOCK_VISIBLE_ROWS);
	const displayMessages = [...visibleMessages].reverse();

	const promoteQueuedTurn = useCallback(
		async (turnId: string) => {
			setOptimisticallySteeredTurnIds((current) => new Set(current).add(turnId));
			try {
				if (!onPromoteQueuedTurn) return;
				await onPromoteQueuedTurn(turnId);
			} catch (error) {
				setOptimisticallySteeredTurnIds((current) => {
					const next = new Set(current);
					next.delete(turnId);
					return next;
				});
				throw error;
			}
		},
		[onPromoteQueuedTurn],
	);

	useEffect(() => {
		if (steerNextRequest === undefined || steerNextRequest <= handledSteerNextRequest) return;
		if (!canSteerNext || !onPromoteQueuedTurn) {
			setHandledSteerNextRequest(steerNextRequest);
			return;
		}
		if (steerNextInFlight.current) return;

		const next = displayMessages[displayMessages.length - 1];
		if (!next) {
			setHandledSteerNextRequest(steerNextRequest);
			return;
		}
		steerNextInFlight.current = true;
		void runAction(next.turnId, () => promoteQueuedTurn(next.turnId)).finally(() => {
			steerNextInFlight.current = false;
			setHandledSteerNextRequest((request) => request + 1);
		});
	}, [
		canSteerNext,
		displayMessages,
		handledSteerNextRequest,
		onPromoteQueuedTurn,
		promoteQueuedTurn,
		runAction,
		steerNextRequest,
	]);

	useEffect(() => {
		if (!isOpen || count <= QUEUE_DOCK_VISIBLE_ROWS) return;
		const scroll = scrollRef.current;
		if (scroll) scroll.scrollTop = scroll.scrollHeight;
	}, [count, isOpen]);

	const rowProps = {
		canSteer,
		onPromoteQueuedTurn: onPromoteQueuedTurn ? promoteQueuedTurn : undefined,
		onBeginQueuedEdit,
		onCancelQueuedTurn,
		onRunAction: runAction,
	};

	return (
		<div
			className="queue-dock overflow-hidden rounded-[var(--radius-chat-composer)] border border-border-strong bg-surface shadow-sm"
			data-testid="queued-message-dock"
			data-collapsible={hasMore ? "true" : "false"}
			data-expanded={isOpen ? "true" : "false"}
			style={{ "--queue-dock-expanded-rows": expandedRows } as CSSProperties}
		>
			<button
				type="button"
				onClick={() => hasMore && setExpanded((open) => !open)}
				disabled={!hasMore}
				className={cn(
					"queue-dock-toggle flex w-full items-center gap-2 px-3 py-2 text-left motion-reduce:transition-none",
					hasMore && "cursor-pointer",
					!hasMore && "cursor-default",
				)}
				aria-expanded={hasMore ? expanded : undefined}
				data-testid="queued-message-toggle"
			>
				<span
					aria-hidden="true"
					className={cn(
						"grid h-3.5 shrink-0 overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
						hasMore ? "w-3.5" : "w-0",
					)}
				>
					<ChevronDown
						className={cn(
							"size-3.5 shrink-0 text-muted-foreground transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none",
							expanded ? "rotate-0" : "-rotate-90",
						)}
					/>
				</span>
				<span className="queue-dock-label text-xs font-medium text-muted-foreground transition-colors duration-150">
					<span
						className="inline-block w-fit"
					>
						{count} Queued {count === 1 ? "Message" : "Messages"}
					</span>
					{editingTurnId ? " · editing" : ""}
				</span>
			</button>
			{count > 0 ? (
				<div
					className="queue-dock-body bg-surface"
					data-expanded={isOpen ? "true" : "false"}
					data-collapsible={hasMore ? "true" : "false"}
					style={
						{
							"--queue-dock-expanded-rows": expandedRows,
						} as CSSProperties
					}
				>
					<div
						ref={scrollRef}
						className={cn("queue-dock-scroll", isOpen && count > QUEUE_DOCK_VISIBLE_ROWS && "queue-dock-scroll-active")}
					>
						{displayMessages.map(({ turnId, message }, index) => {
							const busy =
								promotePendingTurnId === turnId || cancelPendingTurnId === turnId;
							return (
								<QueuedMessageRow
									key={turnId}
									turnId={turnId}
									message={message}
									hiddenFromView={!isOpen && index !== displayMessages.length - 1}
									showHoverSteer={canSteer && (index !== displayMessages.length - 1 || !canSteerNext)}
									busy={busy}
									error={errors[turnId]}
									{...rowProps}
									canSteer={canSteer && canSteerNext && index === displayMessages.length - 1}
								/>
							);
						})}
					</div>
				</div>
			) : null}
		</div>
	);
}
