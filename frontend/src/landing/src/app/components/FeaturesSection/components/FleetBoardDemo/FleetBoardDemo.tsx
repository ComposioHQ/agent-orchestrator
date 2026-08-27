"use client";

import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { Bell, LayoutDashboard, Network, Plus } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { featurePreviewTokens } from "../FeaturePreviewShell";
import { usePreviewScale } from "../usePreviewScale";

// ── Types ─────────────────────────────────────────────────────────────────────

type ColumnId = "working" | "staging" | "in_review" | "merge";
type ActivityState = "running" | "passed" | "reviewing" | "waiting";

export type FleetBoardAssets = Readonly<Record<string, string>>;

const FleetBoardAssetsContext = createContext<FleetBoardAssets>({});

function FleetBoardImage({ src, ...props }: ImgHTMLAttributes<HTMLImageElement>) {
	const assets = useContext(FleetBoardAssetsContext);
	const resolvedSrc = typeof src === "string" ? (assets[src] ?? src) : src;
	return <img {...props} src={resolvedSrc} />;
}

interface Card {
	id: string;
	title: string;
	branch: string;
	icon: string;
	column: ColumnId;
	activity: string;
	activityState: ActivityState;
	pr: string;
	time: string;
	merging?: boolean;
	testResults?: { pass: number; total: number };
	prComments?: number;
	reviewers?: string[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const COLUMN_CONFIG: Record<ColumnId, { title: string; color: string; weight: number }> = {
	working:   { title: "Idle / Working", color: "#60a5fa", weight: 4 },
	staging:   { title: "Needs you",      color: "#fb923c", weight: 3 },
	in_review: { title: "In review",      color: "#facc15", weight: 2 },
	merge:     { title: "Ready / Merged", color: "#4ade80", weight: 1 },
};

const COLUMN_ORDER: ColumnId[] = ["working", "staging", "in_review", "merge"];

const REVIEWERS_LIST = [
	"https://avatars.githubusercontent.com/u/212377671?v=4&s=36",
	"https://avatars.githubusercontent.com/u/11289825?v=4&s=36",
	"https://avatars.githubusercontent.com/u/96483690?v=4&s=36",
	"https://avatars.githubusercontent.com/u/73213873?v=4&s=36",
	"https://avatars.githubusercontent.com/u/44542765?v=4&s=36",
	"https://avatars.githubusercontent.com/u/40922251?v=4&s=36",
];

const RELATIVE_TIMES = ["2m ago", "4m ago", "8m ago", "14m ago", "21m ago", "31m ago"];
function randomTime() { return RELATIVE_TIMES[Math.floor(Math.random() * RELATIVE_TIMES.length)] as string; }
function randomDelay() { return 5000 + Math.random() * 6000; }
function pickRandom<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)] as T; }

function pickReviewers(): string[] {
	const shuffled = [...REVIEWERS_LIST].sort(() => Math.random() - 0.5);
	return shuffled.slice(0, 1 + Math.floor(Math.random() * 3));
}

function pickTestResults(): { pass: number; total: number } {
	const total = pickRandom([28, 42, 50, 54, 60]);
	const pass = Math.floor(total * (0.3 + Math.random() * 0.4));
	return { pass, total };
}

const STAGING_ACTIVITIES = [
	"Running tests", "Building...", "Type checking", "Linting codebase", "Running CI pipeline",
];
const IN_REVIEW_ACTIVITIES = [
	"Reviewer assigned", "Awaiting review", "Review in progress", "Second reviewer added",
];
const MERGE_ACTIVITIES = [
	"Ready to land", "Approved · ready to merge", "All checks passed", "LGTM", "Approved by 2 reviewers",
];

function advanceCard(card: Card): Card {
	if (card.column === "working") {
		return {
			...card,
			column: "staging",
			activity: pickRandom(STAGING_ACTIVITIES),
			activityState: "running",
			time: randomTime(),
			testResults: pickTestResults(),
			reviewers: undefined,
			prComments: undefined,
		};
	}
	if (card.column === "staging") {
		return {
			...card,
			column: "in_review",
			activity: pickRandom(IN_REVIEW_ACTIVITIES),
			activityState: "reviewing",
			time: randomTime(),
			testResults: undefined,
			reviewers: pickReviewers(),
			prComments: Math.floor(Math.random() * 4),
		};
	}
	if (card.column === "in_review") {
		return {
			...card,
			column: "merge",
			activity: pickRandom(MERGE_ACTIVITIES),
			activityState: "passed",
			time: randomTime(),
			reviewers: card.reviewers ?? pickReviewers(),
			prComments: card.prComments ?? 0,
		};
	}
	return card;
}

// ── Seed data ─────────────────────────────────────────────────────────────────

const INITIAL_CARDS: Card[] = [
	{
		id: "c1", title: "Confirm download labels are platform-aware",
		branch: "landing/platform-copy", icon: "/app-icons/cursor.svg",
		column: "working", activity: "Editing copy", activityState: "running",
		pr: "draft", time: "14m ago",
	},
	{
		id: "c2", title: "Port Figma board mock into the hero preview",
		branch: "landing/figma-board", icon: "/app-icons/coverage-claude-code.svg",
		column: "working", activity: "Editing component", activityState: "running",
		pr: "PR #318", time: "8m ago",
	},
	{
		id: "c3", title: "Run integration tests on webhook handler",
		branch: "webhooks/integration-tests", icon: "/app-icons/coverage-codex.svg",
		column: "staging", activity: "Running tests", activityState: "running",
		pr: "draft", time: "22m ago",
		testResults: { pass: 18, total: 50 },
	},
	{
		id: "c4", title: "Migrate auth tokens to short-lived JWTs",
		branch: "auth/jwt-rotation", icon: "/app-icons/coverage-codex.svg",
		column: "staging", activity: "Building...", activityState: "running",
		pr: "PR #331", time: "34m ago",
		testResults: { pass: 22, total: 60 },
	},
	{
		id: "c5", title: "Preload GitHub stars before hydration",
		branch: "landing/preload-stars", icon: "/app-icons/coverage-claude-code.svg",
		column: "in_review", activity: "Awaiting review", activityState: "reviewing",
		pr: "PR #324", time: "1h ago",
		prComments: 2,
		reviewers: [REVIEWERS_LIST[0], REVIEWERS_LIST[2]],
	},
	{
		id: "c6", title: "Stabilize Vercel framework detection",
		branch: "deploy/vercel-next-config", icon: "/app-icons/opencode.svg",
		column: "merge", activity: "Ready to land", activityState: "passed",
		pr: "PR #327", time: "3h ago",
		prComments: 0,
		reviewers: [REVIEWERS_LIST[1], REVIEWERS_LIST[3]],
	},
];

// ── SVG Icons ─────────────────────────────────────────────────────────────────

function BranchIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="4.5" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.3" />
			<circle cx="4.5" cy="12.5" r="1.5" stroke="currentColor" strokeWidth="1.3" />
			<circle cx="11.5" cy="5.5" r="1.5" stroke="currentColor" strokeWidth="1.3" />
			<path d="M4.5 5v6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.3" />
			<path d="M4.5 3.5C4.5 7 11.5 7 11.5 7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.3" />
		</svg>
	);
}

function PullRequestIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="4.5" cy="3.5" r="1.5" stroke="currentColor" strokeWidth="1.3" />
			<circle cx="4.5" cy="12.5" r="1.5" stroke="currentColor" strokeWidth="1.3" />
			<circle cx="11.5" cy="12.5" r="1.5" stroke="currentColor" strokeWidth="1.3" />
			<path d="M4.5 5v6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.3" />
			<path d="M11.5 5v6" stroke="currentColor" strokeLinecap="round" strokeWidth="1.3" />
			<path d="M8.5 3.5h1A2 2 0 0 1 11.5 5.5" stroke="currentColor" strokeLinecap="round" strokeWidth="1.3" />
			<path d="m6.8 1.8 1.7 1.7-1.7 1.7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.3" />
		</svg>
	);
}

function CheckIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" />
			<path d="M5.5 8l2 2 3-3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" />
		</svg>
	);
}

function WaitingIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" />
			<path d="M6.3 5.8v4.4M9.7 5.8v4.4" stroke="currentColor" strokeLinecap="round" strokeWidth="1.5" />
		</svg>
	);
}

function ReviewingIcon({ className = "" }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden="true">
			<circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.4" />
			<path d="M8 5.5V8l1.8 1.8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.4" />
		</svg>
	);
}

function CircleProgressIcon({ pass, total }: { pass: number; total: number }) {
	const r = 5;
	const circ = 2 * Math.PI * r;
	const ratio = total > 0 ? pass / total : 0;
	const dash = ratio * circ;
	const fillColor = ratio >= 1 ? "#4ade80" : ratio < 0.5 ? "#fb923c" : "#e5e7eb";
	return (
		<svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ flexShrink: 0 }}>
			<circle cx="6" cy="6" r={r} stroke="#374151" strokeWidth="1.5" />
			<circle cx="6" cy="6" r={r} stroke={fillColor} strokeWidth="1.5"
				strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
				transform="rotate(-90 6 6)" />
		</svg>
	);
}

function ActivityIcon({ state, testResults }: { state: ActivityState; testResults?: { pass: number; total: number } }) {
	if (state === "passed") return <CheckIcon className="h-2.5 w-2.5 shrink-0" />;
	if (state === "waiting") return <WaitingIcon className="h-2.5 w-2.5 shrink-0" />;
	if (state === "reviewing") return <ReviewingIcon className="h-2.5 w-2.5 shrink-0" />;
	if (testResults) return <CircleProgressIcon pass={testResults.pass} total={testResults.total} />;
	return <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-[#4b5563] border-t-[#d1d5db]" />;
}

// ── AnimatedTestCount ─────────────────────────────────────────────────────────

function AnimatedTestCount({ testResults }: { testResults: { pass: number; total: number } }) {
	const total = testResults.total;
	const [animPass, setAnimPass] = useState(testResults.pass);

	useEffect(() => {
		let timeout: number;
		const tick = () => {
			setAnimPass((p) => {
				const jump = Math.floor(Math.random() * 4) + 1;
				const next = p + jump;
				return next >= total ? Math.floor(total * 0.2) : next;
			});
			timeout = window.setTimeout(tick, 300 + Math.random() * 600);
		};
		timeout = window.setTimeout(tick, 300 + Math.random() * 600);
		return () => window.clearTimeout(timeout);
	}, [total]);

	return (
		<>
			<ActivityIcon state="running" testResults={{ pass: animPass, total }} />
			{`${animPass}/${total} passed`}
		</>
	);
}

// ── BoardCard ─────────────────────────────────────────────────────────────────

function BoardCard({ card, isPulsing }: { card: Card; isPulsing: boolean }) {
	const prMatch = card.pr.match(/PR\s+#(\d+)/i);
	const isWaiting = card.activityState === "waiting";
	const activityTone =
		card.activityState === "passed" ? "#4ade80"
		: card.activityState === "waiting" ? "#fb923c"
		: card.activityState === "reviewing" ? "#facc15"
		: "#60a5fa";

	return (
		<motion.article
			layout
			layoutId={`${card.id}-${card.column}`}
			initial={{ opacity: 0 }}
			animate={card.merging ? { opacity: 0 } : { opacity: 1 }}
			exit={{ opacity: 0 }}
			transition={{
				duration: 0.22,
				ease: "easeOut",
				layout: { duration: 0.22, ease: "easeOut" },
			}}
			className={`relative w-full overflow-hidden rounded-lg border bg-[var(--preview-card)] ${
				isWaiting ? "border-[#fb923c]/60" : "border-[var(--preview-border)]"
			}`}
		>
			<div className="flex items-start gap-2.5 px-3.5 pb-2.5 pt-3">
				<FleetBoardImage
					src={card.icon}
					alt=""
					width={16}
					height={16}
					aria-hidden="true"
					draggable="false"
					className="mt-0.5 size-4 shrink-0 object-contain"
				/>
				<div className="min-w-0 flex-1">
					<div className="line-clamp-2 text-[11px] font-semibold leading-[1.2] tracking-tight text-[var(--preview-card-foreground)]">
					{card.title}
				</div>
					<div className="mt-1.5 flex min-w-0 items-center gap-1.5 font-mono text-[9px] text-[var(--preview-muted-foreground)]">
						<BranchIcon className="size-2.5 shrink-0" />
						<span className="truncate">{card.branch}</span>
					</div>
				</div>
			</div>
			<div aria-hidden="true" className="mx-3.5 h-px bg-[var(--preview-border)]" />
			<div className="flex items-center gap-2 px-3.5 py-2 text-[9px]">
				<span className="inline-flex min-w-0 flex-1 items-center gap-1.5" style={{ color: activityTone }}>
					<span
						aria-hidden="true"
						className={`size-1.5 shrink-0 rounded-full ${isPulsing ? "animate-pulse" : ""}`}
						style={{ background: activityTone }}
					/>
					<span className="truncate font-medium">{card.activity}</span>
				</span>
				<div className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[8.5px] text-[var(--preview-muted-foreground)]">
					{prMatch ? <span>#{prMatch[1]}</span> : null}
					<span>{card.time}</span>
				</div>
			</div>
		</motion.article>
	);
}

// ── BoardColumn ───────────────────────────────────────────────────────────────

function BoardColumn({ cards, id, title }: { cards: Card[]; id: ColumnId; title: string }) {
	const attentionCards = cards.filter((c) => c.activityState === "waiting");
	const normalCards = cards.filter((c) => c.activityState !== "waiting");
	const sorted = [...attentionCards, ...normalCards];
	const pulsingId = attentionCards[0]?.id ?? null;
	const splitLane = id === "working" || id === "merge";
	const primaryLabel = id === "working" ? "Idle" : "Ready";
	const secondaryLabel = id === "working" ? "Working" : "Merged";
	const primaryTone = id === "working" ? "var(--preview-muted-foreground)" : "#4ade80";
	const secondaryTone = id === "working" ? "#60a5fa" : "#4ade80";
	const primaryCount = id === "working" ? cards.filter((card) => card.activityState === "waiting").length : cards.length;
	const secondaryCount = id === "working" ? cards.length - primaryCount : 0;

	return (
		<section className="flex min-h-0 min-w-0 flex-col border-r border-[var(--preview-border)] last:border-r-0">
			<div className="flex h-12 shrink-0 items-center gap-2 px-4">
				{splitLane ? (
					<>
						<div className="flex min-w-0 items-center gap-2 font-mono text-[9px] font-medium uppercase tracking-wide">
							<LaneLabel color={primaryTone} label={primaryLabel} />
							<span className="text-[var(--preview-passive)]">/</span>
							<LaneLabel color={secondaryTone} label={secondaryLabel} />
						</div>
						<div className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[9px] text-[var(--preview-muted-foreground)]">
							<span>{primaryCount}</span><span>/</span><span>{secondaryCount}</span>
						</div>
					</>
				) : (
					<>
						<span className="size-1.5 rounded-full" style={{ background: id === "staging" ? "#fb923c" : "#facc15" }} />
						<span className="truncate font-mono text-[9px] font-medium uppercase tracking-wide text-[var(--preview-muted-foreground)]">{title}</span>
						<span className="ml-auto font-mono text-[9px] leading-none text-[var(--preview-muted-foreground)]">{cards.length}</span>
					</>
				)}
			</div>
			<div className="min-h-0 flex-1 space-y-2.5 overflow-hidden px-3 pb-3 pt-3">
				<AnimatePresence initial={false}>
					{sorted.map((card) => (
						<BoardCard key={card.id} card={card} isPulsing={card.id === pulsingId} />
					))}
				</AnimatePresence>
			</div>
		</section>
	);
}

function LaneLabel({ color, label }: { color: string; label: string }) {
	return (
		<span className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap" style={{ color }}>
			<span className="size-1.5 rounded-full" style={{ background: color }} />
			{label}
		</span>
	);
}

// ── FleetBoardDemo ────────────────────────────────────────────────────────────

export function FleetBoardDemo({ assets = {} }: { assets?: FleetBoardAssets }) {
	const [cards, setCards] = useState<Card[]>(INITIAL_CARDS);
	const incomingIdx = useRef(0);
	const { viewportRef, viewportStyle, canvasStyle } = usePreviewScale(620, 408);

	// Remove a merged card after its exit animation
	const mergeCard = (id: string) => {
		setCards((c) => c.filter((card) => card.id !== id));
	};

	useEffect(() => {
		let timeoutId: number;
		const scheduleNext = () => { timeoutId = window.setTimeout(runStep, randomDelay()); };

		const runStep = () => {
			setCards((current) => {
				// Pick a card to advance (weighted towards earlier columns)
				let total = 0;
				for (const c of current) {
					if (!c.merging) total += COLUMN_CONFIG[c.column].weight;
				}
				let threshold = Math.random() * total;
				let chosen: Card | null = null;
				for (const c of current) {
					if (c.merging) continue;
					threshold -= COLUMN_CONFIG[c.column].weight;
					if (threshold <= 0) { chosen = c; break; }
				}
				if (!chosen) chosen = current.find((c) => !c.merging) ?? null;

				let next = current;
				if (chosen) {
					if (chosen.column === "merge") {
						window.setTimeout(() => mergeCard(chosen!.id), 0);
						next = next.map((c) => c.id === chosen!.id ? { ...c, merging: true } : c);
					} else {
						next = next.map((c) => c.id === chosen!.id ? advanceCard(c) : c);
					}
				}

				// Ensure no column is ever empty
				for (let i = 1; i < COLUMN_ORDER.length; i++) {
					const col = COLUMN_ORDER[i]!;
					const prev = COLUMN_ORDER[i - 1]!;
					if (next.filter((c) => c.column === col && !c.merging).length === 0) {
						const donor = next.find((c) => c.column === prev && !c.merging);
						if (donor) next = next.map((c) => c.id === donor.id ? advanceCard(c) : c);
					}
				}

				// Occasionally flip a card to waiting
				if (Math.random() < 0.1) {
					const candidates = next.filter((c) => !c.merging && c.activityState !== "waiting" && c.column !== "merge");
					const target = candidates[Math.floor(Math.random() * candidates.length)];
					if (target) {
						next = next.map((c) =>
							c.id === target.id ? {
								...c,
								activityState: "waiting" as const,
								activity: c.column === "in_review" ? "Changes requested" : "Needs your input",
								time: randomTime(),
							} : c,
						);
					}
				}

				// Spawn a new working card if column is thin
				const workingCount = next.filter((c) => c.column === "working" && !c.merging).length;
				if (workingCount < 2 && next.filter((c) => !c.merging).length < 8) {
					const newId = `spawned-${++incomingIdx.current}`;
					const templates = [
						{ title: "Throttle agent spawn rate under load",      branch: "backend/spawn-throttle",      icon: "/app-icons/coverage-claude-code.svg" },
						{ title: "Add keyboard shortcut for session focus",    branch: "feat/session-focus-shortcut", icon: "/app-icons/coverage-codex.svg"       },
						{ title: "Lazy-load session terminal on first open",   branch: "perf/lazy-terminal",          icon: "/app-icons/cursor.svg"               },
						{ title: "Fix memory leak in terminal resize handler", branch: "fix/terminal-resize-leak",    icon: "/app-icons/coverage-claude-code.svg" },
						{ title: "Migrate auth tokens to short-lived JWTs",   branch: "auth/jwt-rotation",           icon: "/app-icons/opencode.svg"             },
					];
					const t = templates[incomingIdx.current % templates.length]!;
					next = [{
						id: newId,
						title: t.title,
						branch: t.branch,
						icon: t.icon,
						column: "working",
						activity: "Writing implementation",
						activityState: "running",
						pr: "draft",
						time: randomTime(),
					}, ...next];
				}

				return next;
			});
			scheduleNext();
		};

		scheduleNext();
		return () => window.clearTimeout(timeoutId);
	}, []);

	const boardColumns = COLUMN_ORDER.map((id) => ({
		id,
		...COLUMN_CONFIG[id],
		cards: cards.filter((c) => c.column === id),
	}));

	return (
		<FleetBoardAssetsContext.Provider value={assets}>
		<div
			ref={viewportRef}
			className="relative mx-auto w-full min-w-0 max-w-[620px]"
			style={viewportStyle}
		>
			<div
				className="absolute left-0 top-0 overflow-hidden rounded-[10px] border border-[var(--preview-border)] bg-[var(--preview-background)] text-[9px] text-[var(--preview-foreground)] shadow-[0_24px_64px_-20px_rgba(0,0,0,0.8)]"
				style={{ ...featurePreviewTokens, ...canvasStyle, fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif" }}
			>
				<style>{`
					@keyframes ao-attention-pulse-frames {
						0%, 100% { box-shadow: 0 0 0 0 rgba(251, 146, 60, 0.35); }
						50%       { box-shadow: 0 0 0 4px rgba(251, 146, 60, 0); }
					}
					.ao-attention-pulse { animation: ao-attention-pulse-frames 2.2s ease-in-out infinite; }
					@media (prefers-reduced-motion: reduce) { .ao-attention-pulse { animation: none; } }
				`}</style>
				<div className="flex h-full min-h-0 flex-col">
					<BoardTopbar />
					<LayoutGroup>
						<div className="min-h-0 flex-1 overflow-hidden">
							<div className="grid h-full w-[1024px] grid-cols-4 divide-x divide-[var(--preview-border)]">
								{boardColumns.map((col) => (
									<BoardColumn key={col.id} cards={col.cards} id={col.id} title={col.title} />
								))}
							</div>
						</div>
					</LayoutGroup>
				</div>
			</div>
		</div>
		</FleetBoardAssetsContext.Provider>
	);
}

function BoardTopbar() {
	return (
		<div className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--preview-border)] px-3">
			<span className="inline-flex items-center gap-1.5 text-[10px] font-semibold tracking-tight text-[var(--preview-foreground)]">
				<LayoutDashboard aria-hidden="true" className="size-3.5 text-[var(--preview-muted-foreground)]" />
				Board
			</span>
			<div className="ml-auto flex shrink-0 items-center gap-1.5">
				<span className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[5px] border border-[var(--preview-border)] bg-[var(--preview-input)] px-2.5 text-[9px] font-semibold text-[var(--preview-muted-foreground)]">
					<Plus aria-hidden="true" className="size-3" />
					Task
				</span>
				<span className="inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-[5px] bg-[var(--preview-primary)] px-2.5 text-[9px] font-semibold text-[var(--preview-primary-foreground)]">
					<Network aria-hidden="true" className="size-3" />
					Orchestrator
				</span>
				<span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-[var(--preview-border)]" />
				<span className="grid size-7 place-items-center rounded-[5px] text-[var(--preview-muted-foreground)]">
					<Bell aria-hidden="true" className="size-3.5" />
				</span>
			</div>
		</div>
	);
}
