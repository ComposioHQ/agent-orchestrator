import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import {
	DndContext,
	PointerSensor,
	closestCenter,
	type DragEndEvent,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, Circle, CornerDownLeft, GripVertical, Pencil, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";
import type { ConversationMessage } from "../../types/conversation";

export type QueuedMessage = { turnId: string; message: ConversationMessage };

const QUEUE_DOCK_VISIBLE_ROWS = 5;
const REORDER_ACTIVATION_DISTANCE = 4;

function reorderById(ids: string[], activeId: string, overId: string): string[] | null {
	if (activeId === overId) return null;
	const from = ids.indexOf(activeId);
	const to = ids.indexOf(overId);
	if (from < 0 || to < 0) return null;
	const next = [...ids];
	const [moved] = next.splice(from, 1);
	next.splice(to, 0, moved);
	return next;
}

function SortableQueuedMessageRow({
	turnId,
	message,
	hiddenFromView,
	showPersistentSteer,
	canSteer,
	suppressHoverSteer,
	onPromoteQueuedTurn,
	onBeginQueuedEdit,
	onCancelQueuedTurn,
	busy,
	error,
	onRunAction,
	reorderEnabled,
}: {
	turnId: string;
	message: ConversationMessage;
	hiddenFromView?: boolean;
	showPersistentSteer?: boolean;
	canSteer?: boolean;
	suppressHoverSteer?: boolean;
	onPromoteQueuedTurn?: (turnId: string) => Promise<unknown>;
	onBeginQueuedEdit?: (turnId: string, text: string) => void;
	onCancelQueuedTurn?: (turnId: string) => Promise<unknown>;
	busy?: boolean;
	error?: string;
	onRunAction: (turnId: string, action: () => Promise<unknown>) => void;
	reorderEnabled?: boolean;
}) {
	const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform, transition, isDragging } =
		useSortable({
			id: turnId,
			disabled: !reorderEnabled,
		});

	return (
		<div
			ref={setNodeRef}
			className={cn("queue-dock-row group/queued-row", isDragging && "relative z-[1]")}
			style={{
				transform: transform ? CSS.Transform.toString({ ...transform, x: 0, scaleX: 1, scaleY: 1 }) : undefined,
				transition,
			}}
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
					{onPromoteQueuedTurn && canSteer && !showPersistentSteer && !suppressHoverSteer ? (
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
					{showPersistentSteer && onPromoteQueuedTurn ? (
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
					{reorderEnabled ? (
						<button
							type="button"
							ref={setActivatorNodeRef}
							{...attributes}
							{...listeners}
							disabled={busy}
							className="flex size-7 cursor-grab items-center justify-center rounded-md text-muted-foreground touch-none active:cursor-grabbing disabled:pointer-events-none disabled:opacity-50"
							aria-label="Drag to reorder queued message"
							title="Drag to reorder"
						>
							<GripVertical aria-hidden="true" className="shrink-0" width={12} height={12} strokeWidth={2} />
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
	onReorderQueuedTurns,
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
	onReorderQueuedTurns?: (turnIds: string[]) => Promise<unknown>;
	promotePendingTurnId?: string;
	cancelPendingTurnId?: string;
}) {
	const [expanded, setExpanded] = useState(true);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [optimisticallySteeredTurnIds, setOptimisticallySteeredTurnIds] = useState<Set<string>>(
		() => new Set(),
	);
	const [displayOrder, setDisplayOrder] = useState<string[] | null>(null);
	const [hoverSteerSuppressed, setHoverSteerSuppressed] = useState(false);
	const [reorderError, setReorderError] = useState<string | undefined>();
	const scrollRef = useRef<HTMLDivElement>(null);
	const hoverSteerSuppressTimer = useRef<number | undefined>(undefined);
	const [handledSteerNextRequest, setHandledSteerNextRequest] = useState(steerNextRequest ?? 0);
	const steerNextInFlight = useRef(false);
	const reorderSensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: { distance: REORDER_ACTIVATION_DISTANCE },
		}),
	);

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
	const messagesByTurnId = useMemo(
		() => new Map(visibleMessages.map((message) => [message.turnId, message])),
		[visibleMessages],
	);
	const fifoTurnIds = useMemo(() => visibleMessages.map(({ turnId }) => turnId), [visibleMessages]);
	const defaultDisplayTurnIds = useMemo(() => [...fifoTurnIds].reverse(), [fifoTurnIds]);
	const displayTurnIds = useMemo(() => {
		if (!displayOrder) return defaultDisplayTurnIds;
		const known = new Set(fifoTurnIds);
		const ordered = displayOrder.filter((turnId) => known.has(turnId));
		const missing = fifoTurnIds.filter((turnId) => !ordered.includes(turnId));
		return [...ordered, ...missing];
	}, [defaultDisplayTurnIds, displayOrder, fifoTurnIds]);
	const displayMessages = useMemo(
		() =>
			displayTurnIds.flatMap((turnId) => {
				const message = messagesByTurnId.get(turnId);
				return message ? [message] : [];
			}),
		[displayTurnIds, messagesByTurnId],
	);
	const reorderEnabled =
		Boolean(onReorderQueuedTurns) && count > 1 && isOpen;
	const nextQueuedTurnId = fifoTurnIds[0];

	const suppressHoverSteer = useCallback(() => {
		setHoverSteerSuppressed(true);
		if (hoverSteerSuppressTimer.current !== undefined) {
			window.clearTimeout(hoverSteerSuppressTimer.current);
		}
		hoverSteerSuppressTimer.current = window.setTimeout(() => {
			setHoverSteerSuppressed(false);
			hoverSteerSuppressTimer.current = undefined;
		}, 200);
	}, []);

	useEffect(
		() => () => {
			if (hoverSteerSuppressTimer.current !== undefined) {
				window.clearTimeout(hoverSteerSuppressTimer.current);
			}
		},
		[],
	);

	const fifoTurnIdSetKey = useMemo(
		() => [...fifoTurnIds].sort().join("\0"),
		[fifoTurnIds],
	);

	useEffect(() => {
		setDisplayOrder(null);
	}, [fifoTurnIdSetKey]);

	useEffect(() => {
		if (!displayOrder) return;
		const expectedFifo = [...displayOrder].reverse();
		if (
			expectedFifo.length === fifoTurnIds.length &&
			expectedFifo.every((turnId, index) => turnId === fifoTurnIds[index])
		) {
			setDisplayOrder(null);
		}
	}, [displayOrder, fifoTurnIds]);

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

		const next = displayMessages.find((message) => message.turnId === nextQueuedTurnId);
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
		nextQueuedTurnId,
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

	const onDragEnd = useCallback(
		({ active, over }: DragEndEvent) => {
			suppressHoverSteer();
			if (!over || !onReorderQueuedTurns) return;
			const nextDisplay = reorderById(displayTurnIds, String(active.id), String(over.id));
			if (!nextDisplay) return;
			const fifoOrder = [...nextDisplay].reverse();
			setReorderError(undefined);
			flushSync(() => setDisplayOrder(nextDisplay));
			void onReorderQueuedTurns(fifoOrder).catch((error) => {
				setDisplayOrder(null);
				setReorderError(
					error instanceof Error ? error.message : "Could not reorder queued messages.",
				);
			});
		},
		[displayTurnIds, onReorderQueuedTurns, suppressHoverSteer],
	);

	const rowProps = {
		canSteer,
		onPromoteQueuedTurn: onPromoteQueuedTurn ? promoteQueuedTurn : undefined,
		onBeginQueuedEdit,
		onCancelQueuedTurn,
		onRunAction: runAction,
		suppressHoverSteer: hoverSteerSuppressed,
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
					<DndContext
						collisionDetection={closestCenter}
						onDragEnd={onDragEnd}
						onDragStart={suppressHoverSteer}
						sensors={reorderSensors}
					>
						<SortableContext items={displayTurnIds} strategy={verticalListSortingStrategy}>
							<div
								ref={scrollRef}
								className={cn(
									"queue-dock-scroll",
									isOpen && count > QUEUE_DOCK_VISIBLE_ROWS && "queue-dock-scroll-active",
								)}
							>
								{displayMessages.map(({ turnId, message }, index) => {
									const busy =
										promotePendingTurnId === turnId || cancelPendingTurnId === turnId;
									const isNextQueuedTurn = turnId === nextQueuedTurnId;
									return (
										<SortableQueuedMessageRow
											key={turnId}
											turnId={turnId}
											message={message}
											hiddenFromView={!isOpen && index !== displayMessages.length - 1}
											showPersistentSteer={Boolean(canSteer && canSteerNext && isNextQueuedTurn)}
											busy={busy}
											error={errors[turnId]}
											reorderEnabled={reorderEnabled && !busy}
											{...rowProps}
										/>
									);
								})}
							</div>
						</SortableContext>
					</DndContext>
					{reorderError ? (
						<p role="status" className="px-3 pb-2 text-[11px] text-warning">
							{reorderError}
						</p>
					) : null}
				</div>
			) : null}
		</div>
	);
}
