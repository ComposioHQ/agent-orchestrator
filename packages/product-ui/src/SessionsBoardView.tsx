import {
	Fragment,
	forwardRef,
	memo,
	startTransition,
	useEffect,
	useState,
	type CSSProperties,
	type HTMLAttributes,
	type ReactElement,
	type ReactNode,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import type { ExternalLinkComponent } from "./external-link";
import {
	ChevronIcon,
	GitBranchIcon,
	GitPullRequestIcon,
	MessageSquareIcon,
} from "./icons";
import {
	attentionZone,
	getDisplayStatusLabel,
	getKanbanColumnView,
	getSessionStatusView,
	toKanbanColumn,
	type KanbanColumnView,
	type ProductUITranslator,
} from "./session-presentation";
import type { KanbanColumn, SessionActivity, SessionStatus } from "./session-models";
import { cn } from "./utils";

export type BoardSessionPresentation = {
	activity?: SessionActivity;
	branch?: string;
	id: string;
	/**
	 * Daemon-derived lane placement. Absent only for fixtures and for a daemon
	 * too old to send one; {@link toKanbanColumn} then keeps the placement the
	 * session's status already implied.
	 */
	kanbanColumn?: KanbanColumn;
	/**
	 * Daemon-derived phrase for what is happening inside {@link kanbanColumn}
	 * ("Fixing CI failures", "Needs human review"), replacing {@link status} as
	 * the card's status text. Translated via `getDisplayStatusLabel` for known
	 * phrases (see {@link DisplayStatus}); an unrecognized one -- a newer
	 * daemon that shipped a phrase before this build -- renders as the raw,
	 * already-renderable English text the API guarantees. The card styles the
	 * phrase with its daemon-owned Kanban column, so presentation never has to
	 * infer lifecycle semantics from human-readable copy. A daemon too old to
	 * send one falls back to the translated {@link status} label.
	 */
	displayStatus?: string;
	provider: string;
	status: SessionStatus;
	statusPresentation?: BoardSessionStatusPresentation;
	title: string;
	trackerIssueId?: string;
	updatedAt: string;
};

export type BoardSessionStatusPresentation = {
	className: string;
	indicatorClassName: string;
	label: string;
	tone?: string;
};

export type BoardPullRequestState = "closed" | "open" | "draft" | "merged";

export type BoardPullRequestPresentation = {
	commentCount?: number;
	number: number;
	reviewerAvatars?: string[];
	state: BoardPullRequestState;
	url: string;
};

export type BoardUsagePresentation = {
	accessibleLabel: string;
	compactLabel: string;
};

export type BoardPullRequestLabels = {
	short: string;
	states: Record<BoardPullRequestState, string>;
};

export type BoardColumnLabels = {
	columnAria: (label: string) => string;
};

export type SessionsBoardGridViewProps<
	TSession extends BoardSessionPresentation = BoardSessionPresentation,
> = {
	columns: KanbanColumnView[];
	labels: BoardColumnLabels;
	renderSessionCard: (session: TSession) => ReactNode;
	sessions: TSession[];
};

export function SessionsBoardGridView<TSession extends BoardSessionPresentation>({
	columns,
	labels,
	renderSessionCard,
	sessions,
}: SessionsBoardGridViewProps<TSession>) {
	const byColumn = new Map<KanbanColumn, TSession[]>();
	for (const session of sessions) {
		const column = toKanbanColumn(session.kanbanColumn, session.status);
		const sessionsForColumn = byColumn.get(column);
		if (sessionsForColumn) sessionsForColumn.push(session);
		else byColumn.set(column, [session]);
	}

	return (
		<div
			className="board-horizontal-scrollbar h-full overflow-x-auto overflow-y-hidden"
			data-testid="board-horizontal-scroll"
		>
			<div className="relative grid h-full min-w-[64rem] grid-cols-4 divide-x divide-border-strong xl:min-w-0">
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-x-0 top-12 z-10 border-t border-border-strong"
				/>
				{columns.map((column) => (
					<BoardColumnView
						column={column}
						key={column.column}
						labels={labels}
						renderSessionCard={renderSessionCard}
						sessions={byColumn.get(column.column) ?? []}
					/>
				))}
			</div>
		</div>
	);
}

function BoardColumnView<TSession extends BoardSessionPresentation>({
	column,
	labels,
	renderSessionCard,
	sessions,
}: {
	column: KanbanColumnView;
	labels: BoardColumnLabels;
	renderSessionCard: (session: TSession) => ReactNode;
	sessions: TSession[];
}) {
	const ordered = [...sessions].sort((left, right) => {
		const attentionPriority =
			Number(attentionZone(right.status) === "action") -
			Number(attentionZone(left.status) === "action");
		return attentionPriority || right.updatedAt.localeCompare(left.updatedAt);
	});
	return (
		<section
			aria-label={labels.columnAria(column.label)}
			className="flex min-w-0 flex-col overflow-hidden"
			data-testid="board-column"
			data-column={column.column}
		>
			<div className="flex h-12 shrink-0 items-center gap-2.5 px-4">
				<span
					data-testid="board-column-swatch"
					className="size-[var(--size-swatch)] rounded-full"
					style={{ backgroundColor: column.dot }}
				/>
				<span className={cn("text-xs font-medium", column.titleClassName)}>
					{column.label}
				</span>
				<span className="ml-auto tabular-nums text-xs leading-none text-passive">{ordered.length}</span>
			</div>
			<div className="board-scrollbar min-h-0 flex-1 overflow-y-auto pl-3 pr-2 pb-3 pt-3">
				<div className="flex min-h-full flex-col gap-2.5">
					{ordered.map((session) => (
						<Fragment key={session.id}>{renderSessionCard(session)}</Fragment>
					))}
				</div>
			</div>
		</section>
	);
}

export type SessionCardViewProps = {
		action?: ReactNode;
	branchAction?: ReactNode;
	branchIcon?: ReactNode;
	error?: string;
	externalLink: ExternalLinkComponent;
	footer?: ReactNode;
	interactive?: boolean;
	labels: {
		formatTime: (timestamp: string) => string;
		intakeIssue: (id: string) => string;
		pr: BoardPullRequestLabels;
		updatedAt: (timestamp: string) => string;
	};
	onOpen?: () => void;
	overlay?: ReactNode;
	prs?: BoardPullRequestPresentation[];
	renderAvatar: (provider: string) => ReactNode;
	renderUsage?: (usage: BoardUsagePresentation) => ReactNode;
	session: BoardSessionPresentation;
	translate?: ProductUITranslator;
	usage?: BoardUsagePresentation;
};

export function SessionCardView({
	action,
	branchAction,
	branchIcon,
	error,
	externalLink,
	footer,
	interactive = true,
	labels,
	onOpen,
	overlay,
	prs = [],
	renderAvatar,
	renderUsage = (usage) => <SessionUsageMetricView usage={usage} />,
	session,
	translate,
	usage,
}: SessionCardViewProps) {
	const badge = getSessionStatusView(session.status, translate);
	const statusPresentation = session.statusPresentation;
	const needsAttention =
		(session.status === "ci_failed" && session.displayStatus !== "Fixing CI failures") ||
		(session.status === "changes_requested" && session.displayStatus !== "Addressing comments") ||
		session.displayStatus === "Needs human review" ||
		session.activity?.state === "blocked";
	const needsAttentionChip = needsAttention && !statusPresentation;
	const column = getKanbanColumnView(toKanbanColumn(session.kanbanColumn, session.status), translate);
	const statusTone = needsAttentionChip
		? "var(--color-status-needs-you)"
		: (statusPresentation?.tone ?? (!statusPresentation ? column.dot : undefined));
	const branch = session.branch ?? "";
	const showBranch = branch !== "" && !sameLabel(branch, session.title) && !sameLabel(branch, session.id);

	return (
		<div
			onClick={interactive ? onOpen : undefined}
			role={interactive ? undefined : "listitem"}
			className={cn(
				"group relative w-full rounded-lg border border-border text-left transition-[background-color,box-shadow,transform] duration-[120ms] ease-out",
				badge.cardClassName ?? "border-border bg-surface",
				interactive &&
					"cursor-pointer hover:bg-interactive-hover focus-within:bg-interactive-hover active:scale-[0.99]",
				needsAttention &&
					"animate-attention-card-pulse border-status-needs-you bg-[color-mix(in_srgb,var(--color-status-needs-you)_8%,var(--color-surface))]",
			)}
			data-testid="board-session-card"
			data-session-id={session.id}
		>
			{interactive && onOpen ? (
				<button
					aria-label={session.title}
					className="pointer-events-none absolute inset-0 outline-none"
					type="button"
				/>
			) : null}
			{overlay}
			{action ? <div className="absolute right-2 top-1.5 z-10">{action}</div> : null}
			<div className="px-3.5 pb-2.5 pt-3">
				<div className="flex min-w-0 items-start gap-2.5">
					{renderAvatar(session.provider)}
					<div className="min-w-0 flex-1">
						<div
							className={cn(
								"line-clamp-2 overflow-hidden text-balance text-sm-md font-semibold leading-tight tracking-tight text-foreground",
								(overlay || action) && "pr-6",
							)}
							title={session.title}
						>
							{session.title}
						</div>
					</div>
				</div>
				{showBranch && (
					<div className="mt-1.5 flex min-w-0 items-center gap-1.5 font-mono text-2xs text-muted-foreground">
						{branchIcon ?? <GitBranchIcon aria-hidden="true" className="size-icon-2xs shrink-0" />}
						<span className="truncate text-muted-foreground">{branch}</span>
						{branchAction}
					</div>
				)}
			</div>
			{prs.length > 0 && (
				<div className="flex min-w-0 flex-col gap-1.5 px-3.5 pb-1">
					{prs.length > 0 && (
						<div className="flex min-w-0 flex-col gap-y-1 font-mono text-2xs text-muted-foreground">
							{groupBoardPullRequests(prs).flatMap((group) =>
								group.prs.map((pr) => (
								<BoardPullRequestGroup
									externalLink={externalLink}
									group={{ state: group.state, prs: [pr] }}
									key={`${group.state}-${pr.url || pr.number}`}
									labels={labels.pr}
								/>
								)),
							)}
						</div>
					)}
				</div>
			)}
			<div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-t border-border pl-2 pr-3.5 py-2.5">
				<div className="flex min-w-0 flex-1">
					<span
						className={cn(
							"inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-sm border border-[color-mix(in_srgb,var(--session-status-tone)_24%,transparent)] bg-[color-mix(in_srgb,var(--session-status-tone)_10%,transparent)] px-1.5 py-0.5 text-2xs font-medium",
							!statusTone && "border-border bg-overlay",
							needsAttentionChip ? "text-status-needs-you" : (statusPresentation?.className ?? column.titleClassName),
						)}
						data-kanban-column={statusPresentation ? undefined : column.column}
						data-testid="session-status"
						style={statusTone ? ({ "--session-status-tone": statusTone } as CSSProperties) : undefined}
					>
						{statusPresentation ? (
							<span
								aria-hidden="true"
								className={cn("size-dot-sm shrink-0 rounded-full", statusPresentation.indicatorClassName)}
							/>
						) : (
							<span
								aria-hidden="true"
								className="size-[var(--size-swatch)] shrink-0 rounded-[var(--radius-swatch)]"
								style={{ backgroundColor: statusTone ?? column.dot }}
							/>
						)}
						<span className="min-w-0 truncate">
							{statusPresentation?.label ??
								(session.displayStatus
									? getDisplayStatusLabel(session.displayStatus, translate)
									: badge.label)}
						</span>
					</span>
				</div>
				<div className="ml-auto flex shrink-0 items-center gap-2 whitespace-nowrap text-2xs text-muted-foreground">
					{usage ? renderUsage(usage) : null}
					{usage ? <span aria-hidden="true" className="text-border-strong">·</span> : null}
					<span className="tabular-nums text-muted-foreground" title={labels.updatedAt(session.updatedAt)}>
						{labels.formatTime(session.updatedAt)}
					</span>
				</div>
			</div>
			{error ? (
				<div className="border-t border-border px-3.5 py-1.5 text-2xs text-destructive" role="alert">
					{error}
				</div>
			) : null}
			{footer}
		</div>
	);
}

export const SessionUsageMetricView = forwardRef<
	HTMLSpanElement,
	{ usage: BoardUsagePresentation } & HTMLAttributes<HTMLSpanElement>
>(({ className, usage, ...props }, ref) => (
	<span
		{...props}
		aria-label={usage.accessibleLabel}
		className={cn(
			"inline-flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-2xs text-muted-foreground",
			className,
		)}
		ref={ref}
	>
		{usage.compactLabel}
	</span>
));
SessionUsageMetricView.displayName = "SessionUsageMetricView";

type BoardPullRequestGroupModel = {
	prs: BoardPullRequestPresentation[];
	state: BoardPullRequestState;
};

function BoardPullRequestGroup({
	externalLink: ExternalLink,
	group,
	labels,
}: {
	externalLink: ExternalLinkComponent;
	group: BoardPullRequestGroupModel;
	labels: BoardPullRequestLabels;
}) {
	const statusLabel = labels.states[group.state];
	const singlePullRequest = group.prs.length === 1;
	const linkClassName =
		"rounded-sm border border-transparent transition-colors hover:border-border-strong hover:bg-interactive-hover";
	const details = (
		<>
			<PullRequestLifecycleIcon state={group.state} />
			<span className="sr-only">{labels.short}</span>
			<span className="inline-flex min-w-0 items-center gap-x-1 font-mono text-xs">
				{group.prs.map((pr, index) => (
					<span className="inline-flex items-center" key={pr.url || pr.number}>
						{singlePullRequest ? (
							<span>#{pr.number}</span>
						) : (
							<ExternalLink
								className={cn("font-medium text-foreground underline-offset-2 hover:underline", linkClassName)}
								href={pr.url}
								stopPropagation
							>
								#{pr.number}
							</ExternalLink>
						)}
						{index < group.prs.length - 1 ? "," : null}
					</span>
				))}
			</span>
			<span className="sr-only">{statusLabel}</span>
			{group.prs.some((pr) => (pr.commentCount ?? 0) > 0) ? (
				<div className="-ml-0.5 flex shrink-0 items-center pl-1">
					{group.prs
						.flatMap((pr) => pr.reviewerAvatars ?? [])
						.slice(0, 3)
						.map((avatar, index) => (
							<img
								alt=""
								className={cn("size-5 rounded-full border-2 border-surface object-cover ring-1 ring-border", index > 0 && "-ml-1.5")}
								key={`${avatar}-${index}`}
								src={avatar}
							/>
						))}
				</div>
			) : null}
			{group.prs.some((pr) => (pr.commentCount ?? 0) > 0) ? (
				<span className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs tabular-nums text-muted-foreground">
					<MessageSquareIcon aria-hidden="true" className="size-icon-2xs" />
					{singlePullRequest ? (
						<span>{group.prs[0]?.commentCount}</span>
					) : (
						<span className="inline-flex items-center gap-1">
							{group.prs
								.filter((pr) => (pr.commentCount ?? 0) > 0)
								.map((pr, index, comments) => (
									<span className="inline-flex items-center" key={`comments-${pr.url || pr.number}`}>
										<ExternalLink
											ariaLabel={`${pr.commentCount} comments on PR #${pr.number}`}
											className={cn("font-medium text-foreground underline-offset-2 hover:underline", linkClassName)}
											href={pr.url}
											stopPropagation
										>
											{pr.commentCount}
										</ExternalLink>
										{index < comments.length - 1 ? "," : null}
									</span>
								))}
						</span>
					)}
				</span>
			) : null}
		</>
	);
	return (
		<div
			aria-label={`${group.prs.map((pr) => `#${pr.number}`).join(", ")} ${statusLabel}`}
			className="flex min-w-0"
		>
			{singlePullRequest ? (
				<ExternalLink
					ariaLabel={`PR #${group.prs[0]?.number} ${statusLabel}`}
					className={cn("flex w-full min-w-0 items-center gap-x-2 px-1 py-0.5", linkClassName)}
					href={group.prs[0]?.url ?? "#"}
					stopPropagation
				>
					{details}
				</ExternalLink>
			) : (
				<div className="flex w-full min-w-0 items-center gap-x-2">{details}</div>
			)}
		</div>
	);
}

function PullRequestLifecycleIcon({ state }: { state: BoardPullRequestState }) {
	const className = cn("size-icon-sm shrink-0", lifecycleClassName(state));
	return <GitPullRequestIcon aria-hidden="true" className={className} />;
}

export function groupBoardPullRequests(
	prs: BoardPullRequestPresentation[],
): BoardPullRequestGroupModel[] {
	const groups = new Map<BoardPullRequestState, BoardPullRequestGroupModel>();
	for (const pr of prs) {
		const group = groups.get(pr.state);
		if (group) group.prs.push(pr);
		else groups.set(pr.state, { state: pr.state, prs: [pr] });
	}
	return Array.from(groups.values());
}

function lifecycleClassName(state: BoardPullRequestState): string {
	switch (state) {
		case "draft":
			return "text-passive";
		case "merged":
			return "text-status-merged";
		case "closed":
			return "text-error";
		case "open":
			return "text-success";
	}
}

/**
 * Collapsed archive toggle height. The overlay bar and the board's bottom
 * padding must stay in lockstep so the archive neither overlaps lanes nor
 * leaves a gap.
 */
export const ARCHIVE_TOGGLE_HEIGHT_PX = 58;
export const archiveToggleHeightClassName = "h-[58px]";
export const archiveToggleOffsetClassName = "pb-[58px]";

/**
 * Archive lives in its own memo'd component so expand/collapse state does not
 * re-render the kanban columns. Card mount is deferred via startTransition on
 * first open; after that the sheet stays mounted and open/close only tweens
 * Motion height 0↔auto (collapsed: inert / non-interactive). Overlay
 * positioning keeps lane height stable while expanded.
 */
export const SessionsArchiveView = memo(function SessionsArchiveView<
	TSession extends BoardSessionPresentation,
>({
	labels,
	renderSessionCard,
	resetKey,
	sessions,
}: {
	labels: {
		archive: string;
		archiveAria: string;
		archivedSessions: string;
	};
	renderSessionCard: (session: TSession) => ReactNode;
	/** Collapse and drop deferred cards when the board scope changes (e.g. projectId). */
	resetKey?: string;
	sessions: TSession[];
}) {
	const prefersReducedMotion = useReducedMotion();
	const [expanded, setExpanded] = useState(false);
	const [cardsReady, setCardsReady] = useState(false);

	useEffect(() => {
		setExpanded(false);
		setCardsReady(false);
	}, [resetKey]);

	useEffect(() => {
		if (!expanded || cardsReady) return;
		let cancelled = false;
		const id = requestAnimationFrame(() => {
			startTransition(() => {
				if (!cancelled) setCardsReady(true);
			});
		});
		return () => {
			cancelled = true;
			cancelAnimationFrame(id);
		};
	}, [expanded, cardsReady]);

	if (sessions.length === 0) return null;

	return (
		<div className="absolute inset-x-0 bottom-0 z-20 border-t border-border-strong bg-background px-3">
			{/* Full-row hit target: the control stretches edge-to-edge so empty
			    space beside the label toggles archive too. Height must match
			    archiveToggleOffsetClassName on the board. */}
			<button
				aria-expanded={expanded}
				aria-label={labels.archiveAria}
				className={cn(
					"group flex w-full min-w-0 items-center gap-2 py-0 text-muted-foreground transition-colors hover:text-foreground",
					archiveToggleHeightClassName,
					expanded ? "min-h-11" : "min-h-row-md",
				)}
				onClick={() => setExpanded((open) => !open)}
				type="button"
			>
				<ChevronIcon
					className={cn(
						"size-icon-2xs shrink-0 transition-transform duration-[140ms] ease-[cubic-bezier(0.25,0.46,0.45,0.94)]",
						prefersReducedMotion && "transition-none",
						expanded && "rotate-90",
					)}
					direction="right"
				/>
				<span className="text-2xs font-medium tracking-wide-sm">{labels.archive}</span>
				<span className="ml-1.5 font-mono text-micro text-passive">{sessions.length}</span>
			</button>
			{/* Keep the sheet mounted after first open; height tracks `expanded`. */}
			{cardsReady ? (
				<motion.div
					initial={prefersReducedMotion ? false : { height: 0 }}
					animate={{ height: expanded ? "auto" : 0 }}
					transition={
						prefersReducedMotion
							? { duration: 0 }
							: { duration: 0.14, ease: [0.25, 0.46, 0.45, 0.94] }
					}
					style={{ overflow: "hidden" }}
				>
					<div
						aria-hidden={!expanded}
						aria-label={expanded ? labels.archivedSessions : undefined}
						className={cn(
							"scrollbar-none grid max-h-[28vh] grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-2 overflow-y-auto pb-3",
							!expanded && "pointer-events-none",
						)}
						inert={!expanded ? true : undefined}
						role="list"
					>
						{sessions.map((session) => (
							<Fragment key={session.id}>{renderSessionCard(session)}</Fragment>
						))}
					</div>
				</motion.div>
			) : null}
		</div>
	);
}) as <TSession extends BoardSessionPresentation>(props: {
	labels: {
		archive: string;
		archiveAria: string;
		archivedSessions: string;
	};
	renderSessionCard: (session: TSession) => ReactNode;
	resetKey?: string;
	sessions: TSession[];
}) => ReactElement | null;

function sameLabel(a: string, b: string): boolean {
	const normalize = (value: string) =>
		value
			.toLowerCase()
			.replace(/^(feat|fix|chore|refactor|session)\//, "")
			.replace(/[^a-z0-9]+/g, "");
	return normalize(a) === normalize(b);
}
