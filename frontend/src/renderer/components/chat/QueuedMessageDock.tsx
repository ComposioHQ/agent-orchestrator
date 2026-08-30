import { useCallback, useState } from "react";
import { ChevronDown, Circle, Command, CornerDownLeft, Pencil, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";
import type { ConversationMessage } from "../../types/conversation";

export type QueuedMessage = { turnId: string; message: ConversationMessage };

export function QueuedMessageDock({
	messages,
	editingTurnId,
	canSteer,
	onPromoteQueuedTurn,
	onBeginQueuedEdit,
	onCancelQueuedTurn,
	promotePendingTurnId,
	cancelPendingTurnId,
}: {
	messages: QueuedMessage[];
	editingTurnId?: string;
	canSteer?: boolean;
	onPromoteQueuedTurn?: (turnId: string) => Promise<unknown>;
	onBeginQueuedEdit?: (turnId: string, text: string) => void;
	onCancelQueuedTurn?: (turnId: string) => Promise<unknown>;
	promotePendingTurnId?: string;
	cancelPendingTurnId?: string;
}) {
	const [expanded, setExpanded] = useState(true);
	const [errors, setErrors] = useState<Record<string, string>>({});

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

	const count = messages.length;

	return (
		<div
			className="overflow-hidden rounded-[var(--radius-chat-composer)] border border-border-strong bg-surface shadow-sm"
			data-testid="queued-message-dock"
		>
			<button
				type="button"
				onClick={() => setExpanded((open) => !open)}
				className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors duration-150 ease-out hover:bg-interactive-hover motion-reduce:transition-none"
				aria-expanded={expanded}
			>
				<ChevronDown
					aria-hidden="true"
					className={cn(
						"size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none",
						expanded ? "rotate-0" : "-rotate-90",
					)}
				/>
				<span className="text-xs font-medium text-muted-foreground">
					{count} Queued {count === 1 ? "Message" : "Messages"}
					{editingTurnId ? " · editing" : ""}
				</span>
			</button>
			<div
				className={cn(
					"grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
					expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
				)}
			>
				<div className="min-h-0 overflow-hidden">
					{messages.length > 0 ? (
						<div className="max-h-40 overflow-y-auto">
							{messages.map(({ turnId, message }) => {
								const busy =
									promotePendingTurnId === turnId || cancelPendingTurnId === turnId;
								return (
									<div key={turnId} data-testid={`queued-message-${turnId}`}>
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
											<div className="flex shrink-0 items-center gap-0.5">
												{canSteer && onPromoteQueuedTurn ? (
													<button
														type="button"
														disabled={busy}
														onClick={() => {
															void runAction(turnId, () => onPromoteQueuedTurn(turnId));
														}}
														className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[11px] leading-none text-muted-foreground transition-[scale,background-color,color] duration-150 ease-out hover:bg-interactive-hover hover:text-foreground active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100"
														aria-label="Steer this queued message into the running turn"
														title="Steer into running turn"
													>
														<span className="inline-flex items-center gap-1 text-muted-foreground">
															<Command aria-hidden="true" className="size-2.5" />
															<CornerDownLeft aria-hidden="true" className="size-3" />
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
														<Pencil aria-hidden="true" className="size-3" />
													</button>
												) : null}
												{onCancelQueuedTurn ? (
													<button
														type="button"
														disabled={busy}
														onClick={() => {
															void runAction(turnId, () => onCancelQueuedTurn(turnId));
														}}
														className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-[scale,background-color,color] duration-150 ease-out hover:bg-interactive-hover hover:text-destructive active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100"
														aria-label="Delete queued message"
														title="Delete"
													>
														<Trash2 aria-hidden="true" className="size-3" />
													</button>
												) : null}
											</div>
										</div>
										{errors[turnId] ? (
											<p role="status" className="px-3 pb-2 text-[11px] text-warning">
												{errors[turnId]}
											</p>
										) : null}
									</div>
								);
							})}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
