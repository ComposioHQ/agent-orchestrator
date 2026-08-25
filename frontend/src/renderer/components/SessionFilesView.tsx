import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
	type RefObject,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import {
	Check,
	ChevronDown,
	ChevronRight,
	ChevronsDownUp,
	ChevronsUpDown,
	Columns2,
	Maximize2,
	Minimize2,
	Plus,
	Rows3,
	Search,
	Send as SendIcon,
} from "lucide-react";
import type { components } from "../../api/schema";
import { formatFileAnnotationMessage, type FileAnnotationTarget } from "../../shared/file-annotations";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import {
	isChangedWorkspaceFile,
	sessionWorkspaceFilesQueryOptions,
	useWorkspaceFileConnectionState,
	workspaceFilesRefetchInterval,
	type WorkspaceCommitSummary,
	type WorkspaceCompareMode,
	type WorkspaceFileSections,
	type WorkspaceFileSummary,
	type WorkspaceSummary,
} from "../hooks/useSessionWorkspaceFiles";
import { useParsedDiff } from "../hooks/useParsedDiff";
import { useDiffHighlight } from "../hooks/useDiffHighlight";
import { cn } from "../lib/utils";
import type { DiffRow, DiffRowKind } from "../lib/diff-parser";
import type { DiffRun } from "../lib/diff-highlight";
import type { DiffSelectionLine } from "../../shared/diff-selection";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./ui/accordion";
import { subscribeWorkspaceFileChanges } from "../lib/workspace-file-events";
import { Button } from "./ui/button";
import { DiffSelectionMenu } from "./DiffSelectionMenu";
import { ImageDiffView } from "./ImageDiffView";
import { Input } from "./ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { MarkdownFileView } from "./markdown/MarkdownFileView";
// The token colours live with the engine rather than with one caller: they are
// scoped under `.chat-code`/`.diff-code`/`.markdown-code`, so anything rendering these class names
// has to be inside one of those containers and has to have loaded this sheet.
import "./chat/code-theme.css";

type WorkspaceFileDetail = components["schemas"]["WorkspaceFileResponse"] & {
	previousPath?: string;
	compareMode?: WorkspaceCompareMode;
};
type WorkspaceFileStatus = WorkspaceFileSummary["status"];

type ActiveFileAnnotationTarget = FileAnnotationTarget & { rowIndex?: number };
type FileAnnotationStatus = "idle" | "sending" | "sent" | "error";
type FileAnnotationModel = {
	target: ActiveFileAnnotationTarget | null;
	draft: string;
	status: FileAnnotationStatus;
	error: string;
	begin: (target: ActiveFileAnnotationTarget) => void;
	setDraft: (draft: string) => void;
	cancel: () => void;
	submit: () => Promise<void>;
};

type SessionFilesViewProps = {
	sessionId: string;
	isMaximized?: boolean;
	onToggleMaximized?: (next: boolean) => void;
	revealFile?: ReviewFileTarget;
	/** Expand and reveal this workspace path once (from chat "open file"). */
	focusPath?: string | null;
	onFocusPathConsumed?: () => void;
};

export type ReviewFileTarget = { line?: number; path: string; requestId: number };
type ReviewLineTarget = { line: number; requestId: number };

const emptyFiles: WorkspaceFileSummary[] = [];
const emptyCommits: WorkspaceCommitSummary[] = [];

type WorkspaceSectionKey = "committed" | "staged" | "unstaged" | "untracked";

const statusLabel: Record<WorkspaceFileStatus, string> = {
	added: "A",
	deleted: "D",
	modified: "M",
	renamed: "R",
	unmodified: "",
};

const statusTone: Record<WorkspaceFileStatus, string> = {
	added: "text-success",
	deleted: "text-error",
	modified: "text-warning",
	renamed: "text-status-working",
	unmodified: "text-muted-foreground",
};

// Split (old | new) view only means something when both sides have content to
// compare. Added files have nothing on the old side; deleted files have
// nothing on the new side — splitting them just wastes half the pane on an
// empty column, so those always render unified regardless of the toggle.
function canSplitCompare(status: WorkspaceFileStatus): boolean {
	return status === "modified" || status === "renamed";
}

const MARKDOWN_EXTENSIONS = [".md", ".markdown"];

// A deleted file has no current worktree content — the Rendered view shows the
// file as it stands now, not a historical revision — so there's nothing for it
// to render and the toggle stays hidden.
function canRenderMarkdown(path: string, status: WorkspaceFileStatus): boolean {
	const lower = path.toLowerCase();
	return status !== "deleted" && MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function SessionFilesView({
	sessionId,
	isMaximized = false,
	onToggleMaximized,
	revealFile,
	focusPath,
	onFocusPathConsumed,
}: SessionFilesViewProps) {
	const { t } = useTranslation();
	const queryClient = useQueryClient();
	const [filter, setFilter] = useState("");
	const [split, setSplit] = useState(false);
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
	const [annotationTarget, setAnnotationTarget] = useState<ActiveFileAnnotationTarget | null>(null);
	const [annotationDraft, setAnnotationDraft] = useState("");
	const [annotationStatus, setAnnotationStatus] = useState<FileAnnotationStatus>("idle");
	const [annotationError, setAnnotationError] = useState("");
	const annotationGenerationRef = useRef(0);
	const annotationSentTimerRef = useRef<number | null>(null);
	const rootRef = useRef<HTMLElement>(null);

	const workspaceConnectionState = useWorkspaceFileConnectionState(sessionId);
	const filesQuery = useQuery({
		...sessionWorkspaceFilesQueryOptions(sessionId, t("files.error.loadWorkspace")),
		refetchInterval: workspaceFilesRefetchInterval(workspaceConnectionState),
	});
	useEffect(() => subscribeWorkspaceFileChanges(sessionId, queryClient), [queryClient, sessionId]);
	const files = filesQuery.data?.files ?? emptyFiles;
	const changedFiles = useMemo(() => files.filter(isChangedWorkspaceFile), [files]);
	const sections = filesQuery.data?.sections;
	const commits = filesQuery.data?.commits ?? emptyCommits;
	const summary = filesQuery.data?.summary;
	const ahead = filesQuery.data?.ahead ?? null;
	const behind = filesQuery.data?.behind ?? null;
	// Sections are only populated for single-repo sessions (see backend
	// workspaceGitState). Workspace-project and scratch sessions fall back to
	// the flat base..worktree list below instead of showing an empty panel.
	const useSections = Boolean(
		sections &&
			(sections.staged.length > 0 ||
				sections.unstaged.length > 0 ||
				sections.untracked.length > 0 ||
				sections.committed.length > 0),
	);

	useEffect(() => {
		if (!revealFile?.path) return;
		const match = changedFiles.find(
			(file) => file.path === revealFile.path || file.previousPath === revealFile.path,
		);
		if (!match) return;
		setFilter("");
		setExpandedPaths((current) => {
			if (current.has(match.path)) return current;
			const next = new Set(current);
			next.add(match.path);
			return next;
		});
		window.requestAnimationFrame(() => {
			if (revealFile.line && document.activeElement?.matches("[data-diff-row]")) return;
			const row = Array.from(rootRef.current?.querySelectorAll<HTMLElement>("[data-file-path]") ?? [])
				.find((candidate) => candidate.dataset.filePath === match.path);
			row?.scrollIntoView?.({ block: "nearest" });
			row?.querySelector<HTMLButtonElement>("[data-file-toggle]")?.focus();
		});
	}, [changedFiles, revealFile]);

	useEffect(() => {
		annotationGenerationRef.current += 1;
		setExpandedPaths(new Set());
		setFilter("");
		setAnnotationTarget(null);
		setAnnotationDraft("");
		setAnnotationStatus("idle");
		setAnnotationError("");
	}, [sessionId]);

	// Chat (and similar) can ask the Files rail to open on a specific path. Match
	// by exact path first, then by basename when the turn diff only carried a
	// short name — either way expand that row and clear the request.
	useEffect(() => {
		if (!focusPath) return;
		const match =
			changedFiles.find((file) => file.path === focusPath) ??
			changedFiles.find((file) => file.path === focusPath.replace(/^\.\//, "")) ??
			changedFiles.find((file) => file.path.endsWith(`/${focusPath}`) || file.path === focusPath);
		if (!match && !filesQuery.isSuccess) return;
		const target = match?.path ?? focusPath;
		setExpandedPaths((current) => {
			if (current.has(target)) return current;
			const next = new Set(current);
			next.add(target);
			return next;
		});
		onFocusPathConsumed?.();
		requestAnimationFrame(() => {
			const toggle = rootRef.current?.querySelector<HTMLElement>(
				`[data-file-toggle][data-file-path="${CSS.escape(target)}"]`,
			);
			toggle?.scrollIntoView({ block: "nearest" });
		});
	}, [changedFiles, filesQuery.isSuccess, focusPath, onFocusPathConsumed]);

	useEffect(
		() => () => {
			if (annotationSentTimerRef.current !== null) window.clearTimeout(annotationSentTimerRef.current);
		},
		[],
	);

	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const routeDiffWheel = (event: WheelEvent) => {
			if (event.ctrlKey || event.metaKey || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
			const target = event.target;
			if (!(target instanceof Element) || !target.closest(".session-files-diff-scrollbar")) return;
			const scrollRoot = root.querySelector<HTMLElement>("[data-files-scroll-root]");
			if (!scrollRoot) return;
			const delta =
				event.deltaMode === WheelEvent.DOM_DELTA_LINE
					? event.deltaY * 16
					: event.deltaMode === WheelEvent.DOM_DELTA_PAGE
						? event.deltaY * scrollRoot.clientHeight
						: event.deltaY;
			if (delta === 0) return;
			event.preventDefault();
			scrollRoot.scrollTop += delta;
		};
		root.addEventListener("wheel", routeDiffWheel, { capture: true, passive: false });
		return () => root.removeEventListener("wheel", routeDiffWheel, { capture: true });
	}, []);

	const beginAnnotation = (target: ActiveFileAnnotationTarget) => {
		annotationGenerationRef.current += 1;
		if (annotationSentTimerRef.current !== null) window.clearTimeout(annotationSentTimerRef.current);
		annotationSentTimerRef.current = null;
		setAnnotationTarget(target);
		setAnnotationDraft("");
		setAnnotationStatus("idle");
		setAnnotationError("");
	};
	const cancelAnnotation = () => {
		annotationGenerationRef.current += 1;
		setAnnotationTarget(null);
		setAnnotationDraft("");
		setAnnotationStatus("idle");
		setAnnotationError("");
	};
	const submitAnnotation = async () => {
		if (!annotationTarget || !annotationDraft.trim() || annotationStatus === "sending") return;
		const sendGeneration = annotationGenerationRef.current;
		const sendTarget = annotationTarget;
		const sendFeedback = annotationDraft;
		setAnnotationStatus("sending");
		setAnnotationError("");
		try {
			const { error } = await apiClient.POST("/api/v1/sessions/{sessionId}/send", {
				params: { path: { sessionId } },
				body: { message: formatFileAnnotationMessage(sendTarget, sendFeedback) },
			});
			if (sendGeneration !== annotationGenerationRef.current) return;
			if (error) throw new Error(apiErrorMessage(error, t("files.feedbackError")));
			setAnnotationStatus("sent");
			annotationSentTimerRef.current = window.setTimeout(() => {
				annotationSentTimerRef.current = null;
				cancelAnnotation();
			}, 1_200);
		} catch (error) {
			if (sendGeneration !== annotationGenerationRef.current) return;
			setAnnotationStatus("error");
			setAnnotationError(apiErrorMessage(error, t("files.feedbackError")));
		}
	};
	const annotation: FileAnnotationModel = {
		target: annotationTarget,
		draft: annotationDraft,
		status: annotationStatus,
		error: annotationError,
		begin: beginAnnotation,
		setDraft: setAnnotationDraft,
		cancel: cancelAnnotation,
		submit: submitAnnotation,
	};

	const normalizedFilter = filter.trim().toLowerCase();
	const filterFiles = useCallback(
		(list: WorkspaceFileSummary[]) =>
			normalizedFilter ? list.filter((file) => fileSearchText(file).includes(normalizedFilter)) : list,
		[normalizedFilter],
	);
	const visibleFiles = useMemo(() => filterFiles(changedFiles), [changedFiles, filterFiles]);
	const visibleSections = useMemo<WorkspaceFileSections | null>(() => {
		if (!sections) return null;
		return {
			committed: filterFiles(sections.committed),
			staged: filterFiles(sections.staged),
			unstaged: filterFiles(sections.unstaged),
			untracked: filterFiles(sections.untracked),
		};
	}, [sections, filterFiles]);
	const changedCount = changedFiles.length;
	const allVisibleFiles = useSections
		? [
				...(visibleSections?.committed ?? []),
				...(visibleSections?.staged ?? []),
				...(visibleSections?.unstaged ?? []),
				...(visibleSections?.untracked ?? []),
			]
		: visibleFiles;
	const expandedVisibleCount = allVisibleFiles.filter((file) => expandedPaths.has(file.path)).length;

	const toggleVisibleFiles = () => {
		setExpandedPaths((current) => {
			const next = new Set(current);
			if (expandedVisibleCount > 0) {
				for (const file of allVisibleFiles) next.delete(file.path);
				return next;
			}
			for (const file of allVisibleFiles) next.add(file.path);
			return next;
		});
	};

	// j / k move focus between file rows (Vim-style), unless the user is typing
	// in the search box. The rows themselves handle Enter/Space to expand.
	const onFilesKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.key !== "j" && event.key !== "k") return;
		const active = document.activeElement;
		if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
		const toggles = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>("[data-file-toggle]") ?? []);
		if (toggles.length === 0) return;
		event.preventDefault();
		const current = toggles.findIndex((button) => button === active);
		if (current === -1) {
			toggles[0].focus();
			return;
		}
		const next = event.key === "j" ? Math.min(toggles.length - 1, current + 1) : Math.max(0, current - 1);
		toggles[next].focus();
	};

	return (
		<section
			ref={rootRef}
			onKeyDown={onFilesKeyDown}
			className="flex h-full min-h-0 flex-col bg-background text-foreground"
			aria-label={t("files.sessionFiles")}
		>
			<header className="flex h-10 shrink-0 items-center gap-0.5 border-b border-border bg-surface px-2">
				<label className="relative mr-1 min-w-0 flex-1">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 size-icon-sm -translate-y-1/2 text-passive" />
					<Input
						aria-label={t("files.search")}
						className="h-8 pl-8 font-mono text-xs"
						onChange={(event) => setFilter(event.target.value)}
						placeholder={
							filesQuery.isPending
								? t("files.loading")
								: t("files.searchCountPlaceholder", { count: changedCount })
						}
						value={filter}
					/>
				</label>
				<WorkspaceHeaderStats ahead={ahead} behind={behind} summary={summary} />
				<Button
					aria-label={expandedVisibleCount > 0 ? t("files.collapseAll") : t("files.expandAll")}
					className="shrink-0"
					disabled={allVisibleFiles.length === 0}
					onClick={toggleVisibleFiles}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					{expandedVisibleCount > 0 ? (
						<ChevronsDownUp className="size-icon-sm" aria-hidden="true" />
					) : (
						<ChevronsUpDown className="size-icon-sm" aria-hidden="true" />
					)}
				</Button>
				<Button
					aria-label={split ? t("files.unifiedDiff") : t("files.splitDiff")}
					aria-pressed={split}
					className="shrink-0"
					onClick={() => setSplit((current) => !current)}
					size="icon-sm"
					type="button"
					variant="ghost"
				>
					{split ? (
						<Columns2 className="size-icon-sm" aria-hidden="true" />
					) : (
						<Rows3 className="size-icon-sm" aria-hidden="true" />
					)}
				</Button>
				{onToggleMaximized ? (
					<Button
						aria-label={isMaximized ? t("files.minimize") : t("files.maximize")}
						className="shrink-0"
						onClick={() => onToggleMaximized(!isMaximized)}
						size="icon-sm"
						type="button"
						variant="ghost"
					>
						{isMaximized ? (
							<Minimize2 className="size-icon-sm" aria-hidden="true" />
						) : (
							<Maximize2 className="size-icon-sm" aria-hidden="true" />
						)}
					</Button>
				) : null}
			</header>

			<div
				className="board-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain bg-background"
				data-files-scroll-root=""
			>
				<div className={cn("flex w-full flex-col px-0", !isMaximized && "mx-auto max-w-[1200px]")}>
					{useSections && visibleSections ? (
						<SectionedFileList
							annotation={annotation}
							commits={commits}
							compareMode={filesQuery.data?.compareMode}
							error={filesQuery.error}
							expandedPaths={expandedPaths}
							isLoading={filesQuery.isPending}
							onExpandedPathsChange={setExpandedPaths}
							onRetry={() => void filesQuery.refetch()}
							revealFile={revealFile}
							sections={visibleSections}
							sessionId={sessionId}
							split={split}
							wrap={true}
						/>
					) : (
						<ReviewFileList
							annotation={annotation}
							compareMode={filesQuery.data?.compareMode}
							error={filesQuery.error}
							expandedPaths={expandedPaths}
							files={visibleFiles}
							isLoading={filesQuery.isPending}
							onExpandedPathsChange={setExpandedPaths}
							onRetry={() => void filesQuery.refetch()}
							revealFile={revealFile}
							sessionId={sessionId}
							split={split}
							wrap={true}
						/>
					)}
				</div>
			</div>
		</section>
	);
}

function ReviewFileList({
	annotation,
	compareMode,
	error,
	expandedPaths,
	files,
	isLoading,
	onExpandedPathsChange,
	onRetry,
	revealFile,
	sessionId,
	split,
	wrap,
}: {
	annotation: FileAnnotationModel;
	compareMode?: WorkspaceCompareMode;
	error: Error | null;
	expandedPaths: Set<string>;
	files: WorkspaceFileSummary[];
	isLoading: boolean;
	onExpandedPathsChange: (next: Set<string>) => void;
	onRetry: () => void;
	revealFile?: ReviewFileTarget;
	sessionId: string;
	split: boolean;
	wrap: boolean;
}) {
	const { t } = useTranslation();
	if (isLoading) {
		return <PanelMessage>{t("files.loading")}</PanelMessage>;
	}
	if (error) {
		return (
			<PanelMessage action={<RetryButton onClick={onRetry} />}>{error.message || t("files.error.load")}</PanelMessage>
		);
	}
	if (files.length === 0) {
		return <PanelMessage>{emptyFilesMessage(compareMode, t)}</PanelMessage>;
	}
	return (
		<FileAccordionList
			annotation={annotation}
			expandedPaths={expandedPaths}
			files={files}
			onExpandedPathsChange={onExpandedPathsChange}
			revealFile={revealFile}
			sessionId={sessionId}
			split={split}
			wrap={wrap}
		/>
	);
}

// FileAccordionList is one Radix Accordion instance over one flat file list.
// SectionedFileList mounts several of these side by side (one per git-state
// group), each scoped to its own files but sharing the single `expandedPaths`
// set: `value` is filtered down to the paths this instance owns, and
// onValueChange writes its own paths back into the shared set rather than
// replacing it outright (Radix's onValueChange reports only this instance's
// open values, which would otherwise clobber every other section's expanded
// state).
function FileAccordionList({
	annotation,
	expandedPaths,
	files,
	onExpandedPathsChange,
	revealFile,
	section,
	sessionId,
	split,
	wrap,
}: {
	annotation: FileAnnotationModel;
	expandedPaths: Set<string>;
	files: WorkspaceFileSummary[];
	onExpandedPathsChange: (next: Set<string>) => void;
	revealFile?: ReviewFileTarget;
	section?: WorkspaceSectionKey;
	sessionId: string;
	split: boolean;
	wrap: boolean;
}) {
	const ownPaths = useMemo(() => new Set(files.map((file) => file.path)), [files]);
	const openValues = useMemo(
		() => Array.from(expandedPaths).filter((path) => ownPaths.has(path)),
		[expandedPaths, ownPaths],
	);
	return (
		<Accordion
			asChild
			onValueChange={(next: string[]) => {
				const merged = new Set(expandedPaths);
				for (const path of ownPaths) merged.delete(path);
				for (const path of next) merged.add(path);
				onExpandedPathsChange(merged);
			}}
			type="multiple"
			value={openValues}
		>
			<ul className="session-files-review-list flex flex-col gap-0.5">
				{files.map((file) => (
					<ReviewFileCard
						annotation={annotation}
						expanded={expandedPaths.has(file.path)}
						file={file}
						key={file.path}
						revealLine={
							revealFile?.line &&
							(file.path === revealFile.path || file.previousPath === revealFile.path)
								? { line: revealFile.line, requestId: revealFile.requestId }
								: undefined
						}
						section={section}
						sessionId={sessionId}
						split={split}
						wrap={wrap}
					/>
				))}
			</ul>
		</Accordion>
	);
}

function SectionedFileList({
	annotation,
	commits,
	compareMode,
	error,
	expandedPaths,
	isLoading,
	onExpandedPathsChange,
	onRetry,
	revealFile,
	sections,
	sessionId,
	split,
	wrap,
}: {
	annotation: FileAnnotationModel;
	commits: WorkspaceCommitSummary[];
	compareMode?: WorkspaceCompareMode;
	error: Error | null;
	expandedPaths: Set<string>;
	isLoading: boolean;
	onExpandedPathsChange: (next: Set<string>) => void;
	onRetry: () => void;
	revealFile?: ReviewFileTarget;
	sections: WorkspaceFileSections;
	sessionId: string;
	split: boolean;
	wrap: boolean;
}) {
	const { t } = useTranslation();
	const [collapsedSections, setCollapsedSections] = useState<Set<WorkspaceSectionKey>>(() => new Set());
	if (isLoading) {
		return <PanelMessage>{t("files.loading")}</PanelMessage>;
	}
	if (error) {
		return (
			<PanelMessage action={<RetryButton onClick={onRetry} />}>{error.message || t("files.error.load")}</PanelMessage>
		);
	}
	const groups: Array<{ key: WorkspaceSectionKey; label: string; files: WorkspaceFileSummary[] }> = [
		{ key: "committed", label: t("files.section.committed"), files: sections.committed },
		{ key: "staged", label: t("files.section.staged"), files: sections.staged },
		{ key: "unstaged", label: t("files.section.unstaged"), files: sections.unstaged },
		{ key: "untracked", label: t("files.section.untracked"), files: sections.untracked },
	];
	if (groups.every((group) => group.files.length === 0)) {
		return <PanelMessage>{emptyFilesMessage(compareMode, t)}</PanelMessage>;
	}
	const toggleSection = (key: WorkspaceSectionKey) => {
		setCollapsedSections((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};
	return (
		<div className="flex flex-col gap-2 py-1.5">
			{groups.map((group) =>
				group.files.length === 0 ? null : (
					<SectionGroup
						annotation={annotation}
						collapsed={collapsedSections.has(group.key)}
						commits={group.key === "committed" ? commits : undefined}
						expandedPaths={expandedPaths}
						files={group.files}
						key={group.key}
						label={group.label}
						onExpandedPathsChange={onExpandedPathsChange}
						onToggleCollapsed={() => toggleSection(group.key)}
						revealFile={revealFile}
						section={group.key}
						sessionId={sessionId}
						split={split}
						wrap={wrap}
					/>
				),
			)}
		</div>
	);
}

function SectionGroup({
	annotation,
	collapsed,
	commits,
	expandedPaths,
	files,
	label,
	onExpandedPathsChange,
	onToggleCollapsed,
	revealFile,
	section,
	sessionId,
	split,
	wrap,
}: {
	annotation: FileAnnotationModel;
	collapsed: boolean;
	commits?: WorkspaceCommitSummary[];
	expandedPaths: Set<string>;
	files: WorkspaceFileSummary[];
	label: string;
	onExpandedPathsChange: (next: Set<string>) => void;
	onToggleCollapsed: () => void;
	revealFile?: ReviewFileTarget;
	section: WorkspaceSectionKey;
	sessionId: string;
	split: boolean;
	wrap: boolean;
}) {
	return (
		<section>
			<button
				aria-expanded={!collapsed}
				className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left hover:bg-interactive-hover/50"
				onClick={onToggleCollapsed}
				type="button"
			>
				{collapsed ? (
					<ChevronRight className="size-icon-sm shrink-0 text-muted-foreground" aria-hidden="true" />
				) : (
					<ChevronDown className="size-icon-sm shrink-0 text-muted-foreground" aria-hidden="true" />
				)}
				<span className="text-caption font-bold uppercase tracking-wide text-foreground">{label}</span>
				<span className="rounded-full bg-muted px-1.5 py-0.25 text-caption font-medium text-muted-foreground">
					{files.length}
				</span>
			</button>
			{collapsed ? null : (
				<div className="flex flex-col gap-1.5 px-2.5 pb-1">
					{commits && commits.length > 0 ? <CommitList commits={commits} /> : null}
					<FileAccordionList
						annotation={annotation}
						expandedPaths={expandedPaths}
						files={files}
						onExpandedPathsChange={onExpandedPathsChange}
						revealFile={revealFile}
						section={section}
						sessionId={sessionId}
						split={split}
						wrap={wrap}
					/>
				</div>
			)}
		</section>
	);
}

function CommitList({ commits }: { commits: WorkspaceCommitSummary[] }) {
	return (
		<ul className="flex flex-col gap-0.5 border-b border-border/40 pb-1.5">
			{commits.map((commit) => (
				<li className="flex items-center gap-1.5 py-0.5 font-mono text-caption text-passive" key={commit.sha}>
					<span className="shrink-0 text-passive/70">{commit.sha.slice(0, 7)}</span>
					<span className="min-w-0 flex-1 truncate text-foreground">{commit.subject}</span>
				</li>
			))}
		</ul>
	);
}

function WorkspaceHeaderStats({
	ahead,
	behind,
	summary,
}: {
	ahead: number | null;
	behind: number | null;
	summary?: WorkspaceSummary;
}) {
	const { t } = useTranslation();
	const hasSummary = Boolean(summary && summary.files > 0);
	const hasAheadBehind = Boolean(ahead || behind);
	if (!hasSummary && !hasAheadBehind) return null;
	return (
		<span
			aria-label={t("files.workspaceSummary")}
			className="flex shrink-0 items-center gap-2 px-1 font-mono text-caption"
		>
			{hasSummary && summary ? (
				<span className="flex items-center gap-1">
					{summary.additions > 0 ? <span className="text-success">+{summary.additions}</span> : null}
					{summary.deletions > 0 ? <span className="text-error">-{summary.deletions}</span> : null}
				</span>
			) : null}
			{hasAheadBehind ? (
				<span className="flex items-center gap-1.5 text-passive">
					{ahead ? <span title={t("files.aheadCount", { count: ahead })}>↑{ahead}</span> : null}
					{behind ? <span title={t("files.behindCount", { count: behind })}>↓{behind}</span> : null}
				</span>
			) : null}
		</span>
	);
}

function ReviewFileCard({
	annotation,
	expanded,
	file,
	revealLine,
	section,
	sessionId,
	split,
	wrap,
}: {
	annotation: FileAnnotationModel;
	expanded: boolean;
	file: WorkspaceFileSummary;
	revealLine?: ReviewLineTarget;
	section?: WorkspaceSectionKey;
	sessionId: string;
	split: boolean;
	wrap: boolean;
}) {
	const { t } = useTranslation();
	// While the user has an active text selection (or the context menu it opens)
	// in this file's diff, a background refetch would re-render the diff body
	// out from under them and blow away the browser's native selection.
	const [selectionOrMenuActive, setSelectionOrMenuActive] = useState(false);
	// Keyed by file.path in ReviewFileList's .map(), so this naturally resets to
	// "source" for a different file while surviving this file's own re-renders.
	const [viewMode, setViewMode] = useState<"source" | "rendered">("source");
	const cardRef = useRef<HTMLElement>(null);
	const { onViewModeChange } = useViewModeScrollAnchor(cardRef, viewMode, setViewMode);
	const detailQuery = useQuery({
		// section is part of the key: a partially staged file has one row under
		// Staged and another under Unstaged, and each must resolve its own diff
		// rather than sharing a cache entry keyed on path alone.
		queryKey: ["session-workspace-file", sessionId, file.path, section],
		enabled: expanded && !selectionOrMenuActive,
		queryFn: () => loadWorkspaceFile(sessionId, file.path, section, t),
	});

	const markdownTabs = canRenderMarkdown(file.path, file.status);
	const card = (
			<li className="session-files-review-row overflow-hidden bg-transparent" data-file-path={file.path}>
				<AccordionTrigger
					aria-label={t(expanded ? "files.collapseFile" : "files.expandFile", { file: fileLabel(file) })}
					className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1 text-left"
					data-file-toggle=""
					data-file-path={file.path}
					headerClassName="min-h-9 hover:bg-interactive-hover/50 data-[state=open]:bg-interactive-active/35"
					trailing={
						<>
							{markdownTabs && expanded ? (
								<TabsList className={markdownTabsListClass}>
									<TabsTrigger value="source" className={markdownTabTriggerClass}>
										{t("files.diff")}
									</TabsTrigger>
									<TabsTrigger value="rendered" className={markdownTabTriggerClass}>
										{t("files.preview")}
									</TabsTrigger>
								</TabsList>
							) : null}
							<FileFeedbackButton
								active={annotation.target?.path === file.path && annotation.target.side === "file"}
								file={file}
								onClick={() => annotation.begin({ path: file.path, previousPath: file.previousPath, side: "file" })}
							/>
						</>
					}
				>
					{expanded ? (
						<ChevronDown className="size-icon-sm shrink-0 text-passive" aria-hidden="true" />
					) : (
						<ChevronRight className="size-icon-sm shrink-0 text-passive" aria-hidden="true" />
					)}
					<StatusMark status={file.status} />
					<FilePathLabel file={file} />
					<ChangeBadges additions={file.additions} deletions={file.deletions} />
				</AccordionTrigger>
				{annotation.target?.path === file.path && annotation.target.side === "file" ? (
					<FileAnnotationComposer annotation={annotation} />
				) : null}
				<AccordionContent className="border-t border-border/60 bg-background/40">
					{detailQuery.isPending ? <PanelMessage compact>{t("files.loadingDiff")}</PanelMessage> : null}
					{!detailQuery.isPending && detailQuery.error ? (
						<PanelMessage compact action={<RetryButton onClick={() => void detailQuery.refetch()} />}>
							{detailQuery.error.message || t("files.error.loadFile")}
						</PanelMessage>
					) : null}
					{!detailQuery.isPending && !detailQuery.error && detailQuery.data ? (
						<FileDetailBody
							annotation={annotation}
							detail={detailQuery.data}
							detailLoadedAt={detailQuery.dataUpdatedAt}
							file={file}
							onActiveSelectionChange={setSelectionOrMenuActive}
							revealLine={revealLine}
							sessionId={sessionId}
							split={split}
							wrap={wrap}
						/>
					) : null}
				</AccordionContent>
			</li>
	);
	// The tab strip lives in the file's own title row, so the Tabs root has to
	// enclose that row as well as the body it switches. Both roots take `asChild`,
	// so Accordion item → Tabs root → the same single <li>: no wrapper element, and
	// the DOM is what it was before the strip moved up. That also makes `cardRef`
	// the <li> rather than the <div> Radix types it as — the scroll anchor only
	// reads getBoundingClientRect/closest off it, so the cast is safe.
	return (
		<AccordionItem asChild value={file.path}>
			{markdownTabs ? (
				<Tabs
					ref={cardRef as RefObject<HTMLDivElement>}
					value={viewMode}
					onValueChange={(next) => onViewModeChange(next as FileViewMode)}
					asChild
				>
					{card}
				</Tabs>
			) : (
				card
			)}
		</AccordionItem>
	);
}

function FileFeedbackButton({ active, file, onClick }: { active: boolean; file: WorkspaceFileSummary; onClick: () => void }) {
	const { t } = useTranslation();
	if (active) return <span className="size-7 shrink-0" aria-hidden="true" />;
	return (
		<Button
			aria-label={t("files.addFileFeedback", { file: file.path })}
			className="size-7 shrink-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100"
			onClick={onClick}
			size={null}
			type="button"
			variant="ghost"
		>
			<Plus className="size-icon-sm" aria-hidden="true" />
		</Button>
	);
}
function FilePathLabel({ file }: { file: WorkspaceFileSummary }) {
	if (!file.previousPath) {
		return <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground">{file.path}</span>;
	}
	return (
		<span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-foreground">
			<span className="text-passive line-through decoration-border">{file.previousPath}</span>
			<span className="px-1 text-passive">-&gt;</span>
			<span>{file.path}</span>
		</span>
	);
}

function fileLabel(file: WorkspaceFileSummary): string {
	return file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path;
}

function fileSearchText(file: WorkspaceFileSummary): string {
	return fileLabel(file).toLowerCase();
}

function emptyFilesMessage(compareMode: WorkspaceCompareMode | undefined, t: TFunction): string {
	if (compareMode === "head_fallback") return t("files.noChangesHead");
	if (compareMode === "base") return t("files.noChangesBase");
	return t("files.noneChanged");
}

function emptyDiffMessage(compareMode: WorkspaceCompareMode | undefined, t: TFunction): string {
	return compareMode === "base" ? t("files.noChangesBase") : t("files.noChangesHead");
}

async function loadWorkspaceFile(sessionId: string, path: string, section: WorkspaceSectionKey | undefined, t: TFunction) {
	const { data, error } = await apiClient.GET("/api/v1/sessions/{sessionId}/workspace/file", {
		params: { path: { sessionId }, query: { path, section } },
	});
	if (error) throw new Error(apiErrorMessage(error, t("files.error.loadWorkspaceFile")));
	if (!data) throw new Error(t("files.error.emptyResponse"));
	return data;
}

type FileViewMode = "source" | "rendered";

/**
 * Keeps a file card where the eye left it when its diff/rendered tab changes.
 *
 * There is no per-file scroll box — the Files panel is one shared scroller
 * (`[data-files-scroll-root]`, see `useSharedScrollRowVirtualizer`), so "scroll
 * position" is that panel's `scrollTop`, and nothing about switching tabs resets
 * it directly. What moves the content is the height swap: a 4,000-line diff and
 * its rendered form are wildly different heights, and when the shorter one mounts
 * the browser clamps `scrollTop` to the now-smaller maximum. Switching back
 * restores the height but not the clamped-away offset, which is why a long diff
 * came back parked near its top.
 *
 * Note this is NOT solved by `forceMount` on both tabs: a hidden `TabsContent`
 * is `display: none`, contributes zero height, and clamps identically — it would
 * only add the cost of keeping a large diff permanently mounted.
 *
 * So: remember where the card sat when a mode was left, and put it back when that
 * mode returns. Re-run after a frame as well, because virtualized rows measure
 * their real heights one frame after mounting and shift everything below them.
 */
function useViewModeScrollAnchor(
	cardRef: RefObject<HTMLElement | null>,
	viewMode: FileViewMode,
	setViewMode: (mode: FileViewMode) => void,
) {
	// Offset of the card's top edge from the scroll root's, per mode. Negative
	// once it has scrolled up out of view, which is the case that mattered. The
	// card rather than the tab strip: the strip sits in the title row now, so it
	// no longer moves with the body being swapped, and the card's own top edge is
	// the fixed thing above it.
	const offsets = useRef<Partial<Record<FileViewMode, number>>>({});
	const pending = useRef<{ root: HTMLElement; offset: number } | null>(null);

	const currentOffset = useCallback(
		(root: HTMLElement) => {
			const card = cardRef.current;
			if (!card) return null;
			return card.getBoundingClientRect().top - root.getBoundingClientRect().top;
		},
		[cardRef],
	);

	const onViewModeChange = useCallback(
		(next: FileViewMode) => {
			const root = cardRef.current?.closest<HTMLElement>("[data-files-scroll-root]") ?? null;
			const offset = root ? currentOffset(root) : null;
			if (root && offset !== null) {
				offsets.current[viewMode] = offset;
				// Fall back to holding the card still when the incoming mode has no
				// remembered offset yet — the first switch in either direction.
				pending.current = { root, offset: offsets.current[next] ?? offset };
			}
			setViewMode(next);
		},
		[cardRef, currentOffset, setViewMode, viewMode],
	);

	useLayoutEffect(() => {
		const target = pending.current;
		pending.current = null;
		if (!target) return;
		const settle = () => {
			const offset = currentOffset(target.root);
			if (offset === null) return;
			const delta = offset - target.offset;
			if (delta) target.root.scrollTop += delta;
		};
		settle();
		const frame = requestAnimationFrame(settle);
		return () => cancelAnimationFrame(frame);
	}, [currentOffset, viewMode]);

	return { onViewModeChange };
}

// Colours and sizes come from the inspector rail's own tab buttons
// (`session-inspector__tab-button` in packages/product-ui/src/SessionInspectorView.tsx),
// which is the tab language for the pane this control sits in: `text-passive` labels
// at `text-2xs font-semibold` and `--color-interactive-*` fills, a rung or two down
// the control scale from the rail's own 28px. Stock shadcn's own palette is dropped — its dark-theme active fill,
// `bg-input/30`, is white at 1.2% over the track, which is not a visible selection at
// this size.
//
// The two interaction fills are one step apart on the same neutral (foreground at 4%
// for the track, 7% for the selected tab) rather than two competing colours, so the
// pair reads as one control with one thing lit. Hover moves the label, not the fill —
// a hover tint would land on the track's own value and disappear. That is also what
// `settings-segment-item` does.
//
// Sizing tracks the rail as the user drags it in, off the `inspector` container the
// shell already declares and the 350px/300px steps it already breaks at, so the
// toggle narrows on the same drag positions as everything else in the pane rather
// than on a threshold invented here. In the centre pane there is no `inspector`
// container to match, so the variants sit inert and the control keeps its full size.
//
// Full size is a `--size-control-xs` track, the bottom rung of the control scale, over
// 16px pills — deliberately under the 20px a standalone control would get. It rides
// in a 36px row it does not own, next to a 28px feedback button, and reading as the
// smaller thing there is the point. Wide labels keep the targets easy despite the
// height. Nothing below that is left to give, so the two narrow steps buy their width
// back out of horizontal padding instead, which is the dimension actually under
// pressure when the rail closes in.
//
// The hairline around the track is GitHub's segmented-control signature, and it is
// what separates this shape from a shadcn pill group: the border draws the outline,
// the fills only say which half is live. Border and padding cost the track 1px a side
// each, hence 16px pills inside 20px, and the radii follow — 6px outside, 4px inside,
// still concentric.
//
// Every line below overrides a stock-shadcn base class in ui/tabs.tsx, so the dark:
// variants have to be restated to outrank the primitive's own dark: rules.
const markdownTabsListClass =
	"mr-1 h-control-xs shrink-0 gap-px rounded-sm border border-border bg-interactive-hover p-px";
const markdownTabTriggerClass = [
	"h-4 flex-none rounded-xs px-1.5 text-2xs font-semibold",
	"text-passive transition-[background,color] duration-fast",
	"hover:text-foreground dark:text-passive dark:hover:text-foreground",
	"data-[state=active]:bg-interactive-active data-[state=active]:text-foreground",
	"dark:data-[state=active]:border-transparent dark:data-[state=active]:bg-interactive-active",
	"@max-[350px]/inspector:px-1",
	"@max-[300px]/inspector:px-0.5",
].join(" ");

// A markdown file's body is the two panels the title row's tab strip switches
// between; every other file (and a deleted markdown file, which has no current
// content to render) falls straight through to the diff body unchanged.
function FileDetailBody({
	annotation,
	detail,
	detailLoadedAt,
	file,
	onActiveSelectionChange,
	revealLine,
	sessionId,
	split,
	wrap,
}: {
	annotation: FileAnnotationModel;
	detail: WorkspaceFileDetail;
	detailLoadedAt: number;
	file: WorkspaceFileSummary;
	onActiveSelectionChange: (active: boolean) => void;
	revealLine?: ReviewLineTarget;
	sessionId: string;
	split: boolean;
	wrap: boolean;
}) {
	const diffBody = (
		<ReviewDiffBody
			annotation={annotation}
			detail={detail}
			detailLoadedAt={detailLoadedAt}
			filePath={file.path}
			onActiveSelectionChange={onActiveSelectionChange}
			revealLine={revealLine}
			sessionId={sessionId}
			split={split && canSplitCompare(file.status)}
			wrap={wrap}
		/>
	);
	if (!canRenderMarkdown(file.path, file.status)) return diffBody;
	return (
		<>
			<TabsContent value="source">{diffBody}</TabsContent>
			<TabsContent value="rendered">
				<MarkdownFileView
					content={detail.content}
					filePath={file.path}
					sessionId={sessionId}
					truncated={detail.contentTruncated}
					version={detailLoadedAt}
				/>
			</TabsContent>
		</>
	);
}

function ReviewDiffBody({
	annotation,
	detail,
	detailLoadedAt,
	filePath,
	onActiveSelectionChange,
	revealLine,
	sessionId,
	split,
	wrap,
}: {
	annotation: FileAnnotationModel;
	detail: WorkspaceFileDetail;
	detailLoadedAt: number;
	filePath: string;
	onActiveSelectionChange: (active: boolean) => void;
	revealLine?: ReviewLineTarget;
	sessionId: string;
	split: boolean;
	wrap: boolean;
}) {
	const { t } = useTranslation();
	const { rows, pending } = useParsedDiff(detail.diff);
	// An image has no readable line diff, so it renders as the images themselves
	// rather than the binary placeholder.
	if (detail.imageMediaType) {
		return (
			<ImageDiffView
				path={detail.path}
				sessionId={sessionId}
				split={split}
				status={detail.status}
				version={detailLoadedAt}
			/>
		);
	}
	if (detail.binary) {
		return <PanelMessage compact>{t("files.binaryUnavailable")}</PanelMessage>;
	}
	if (pending) {
		return <PanelMessage compact>{t("files.loadingDiff")}</PanelMessage>;
	}
	if (rows.length === 0) {
		return <PanelMessage compact>{emptyDiffMessage(detail.compareMode, t)}</PanelMessage>;
	}
	return (
		<DiffView
			annotation={annotation}
			filePath={filePath}
			onActiveSelectionChange={onActiveSelectionChange}
			path={detail.path}
			previousPath={detail.previousPath}
			revealLine={revealLine}
			rows={rows}
			sessionId={sessionId}
			split={split}
			truncated={detail.diffTruncated}
			wrap={wrap}
		/>
	);
}

const diffRowTone: Record<Exclude<DiffRowKind, "hunk">, string> = {
	add: "bg-success/10",
	del: "bg-error/10",
	context: "",
};

const diffMarkerGlyph: Record<Exclude<DiffRowKind, "hunk">, string> = {
	add: "+",
	del: "-",
	context: " ",
};

// isSelectionActiveIn is the shared check used both by the live selectionchange
// listener and the context-menu handler: a real (non-collapsed) selection whose
// anchor lives inside this DiffView's scroll container.
function isSelectionActiveIn(selection: Selection | null, container: HTMLElement | null): boolean {
	if (!selection || !container || selection.isCollapsed) return false;
	return selection.anchorNode !== null && container.contains(selection.anchorNode);
}

// closestDiffRowElement climbs from a Range boundary (which for a text
// selection is almost always a text node, and text nodes have no `.closest`)
// up to the nearest `[data-diff-row]` element, or null if the boundary isn't
// inside a real diff row (e.g. it landed on a hunk band or an empty
// split-view placeholder).
function closestDiffRowElement(node: Node | null): Element | null {
	if (!node) return null;
	const element = node instanceof Element ? node : node.parentElement;
	return element?.closest?.("[data-diff-row]") ?? null;
}

// toDiffSelectionLine maps a DiffRow to the shared DiffSelectionLine shape.
// Hunk rows never carry data-row-index themselves, but a multi-hunk selection
// range can still include one in the middle of the sliced rows[min..max] —
// this drops it defensively rather than emitting a bogus "hunk" line.
function toDiffSelectionLine(row: DiffRow): DiffSelectionLine | null {
	if (row.kind === "hunk") return null;
	return { kind: row.kind, oldNo: row.oldNo, newNo: row.newNo, text: row.text };
}

function isNotNull<T>(value: T | null): value is T {
	return value !== null;
}

type DiffViewMenuState = {
	open: boolean;
	position: { x: number; y: number };
	lines: DiffSelectionLine[];
	selectedText: string;
};

// SessionFilesView has no per-file scroll box — the Files panel is one
// continuous list, and an expanded file's rows scroll as part of that same
// shared container (`[data-files-scroll-root]`). Below the threshold every
// row just renders directly, unchanged from before (the vast majority of
// diffs never pay for any of this). Above it, only the rows actually
// scrolled into view are mounted, via @tanstack/react-virtual attached to
// that SHARED scroll container rather than a container of this file's own —
// `scrollMargin` is this file's row-list's offset from the top of the shared
// scrollable content, since the virtualizer needs that to know which of its
// rows fall inside the current viewport. That offset shifts whenever
// anything above this file changes height (another file expanding or
// collapsing, or gaining/losing its own virtualized rows), so it's
// re-measured via a ResizeObserver on the full file list rather than once.
// Rows wrap (`whitespace-pre-wrap`) and the panel's available width varies a
// lot — full window width when the Files view is maximized, much narrower
// when docked alongside the terminal — so a long line can be one row of
// height in the maximized view and several wrapped rows tall when docked.
// ESTIMATED_ROW_HEIGHT is only the initial guess for a row that hasn't
// rendered yet; `measureElement` corrects it to the row's real height once
// mounted, which is what keeps rows from overlapping when they wrap.
const ROW_VIRTUALIZE_THRESHOLD = 150;
const ESTIMATED_ROW_HEIGHT = 20;

function useSharedScrollRowVirtualizer(
	scrollContainerRef: RefObject<HTMLElement | null>,
	count: number,
	enabled: boolean,
) {
	const listRef = useRef<HTMLDivElement>(null);
	const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
	const [scrollMargin, setScrollMargin] = useState(0);

	useEffect(() => {
		if (!enabled) return;
		setScrollElement(scrollContainerRef.current?.closest<HTMLElement>("[data-files-scroll-root]") ?? null);
	}, [enabled, scrollContainerRef]);

	// A regular effect, not useLayoutEffect: "Expand All" mounts many DiffView
	// instances in the same commit, and React runs every layout effect from
	// that commit synchronously, before the browser is allowed to paint
	// anything. A read (getBoundingClientRect) here forces a synchronous
	// layout — N of those back to back, all before first paint, is exactly
	// what made "Expand All" stall. A plain effect still measures almost
	// immediately (one frame later at worst), which is an imperceptible
	// one-time cost for something that self-corrects, in exchange for never
	// blocking paint on how many files just got expanded at once.
	useEffect(() => {
		if (!enabled || !scrollElement || !listRef.current) return;
		const measure = () => {
			if (!listRef.current) return;
			const listRect = listRef.current.getBoundingClientRect();
			const scrollRect = scrollElement.getBoundingClientRect();
			setScrollMargin(listRect.top - scrollRect.top + scrollElement.scrollTop);
		};
		measure();
		const resizeTarget = scrollElement.querySelector<HTMLElement>(".session-files-review-list") ?? scrollElement;
		const observer = new ResizeObserver(measure);
		observer.observe(resizeTarget);
		return () => observer.disconnect();
	}, [enabled, scrollElement]);

	const virtualizer = useVirtualizer({
		count,
		getScrollElement: () => (enabled ? scrollElement : null),
		estimateSize: () => ESTIMATED_ROW_HEIGHT,
		// Every row outside the viewport that overscan pulls in is a row that
		// still has to pay full first-time cost (render + a real DOM
		// measurement, see useSharedScrollRowVirtualizer's comment above) the
		// first time it's scrolled into range. A smaller buffer means fewer
		// never-before-seen rows get force-measured on each scroll jump,
		// trading a slightly higher chance of a one-frame blank edge during
		// very fast scrolling for less of that first-pass cost on big files.
		overscan: 8,
		scrollMargin,
	});

	return { listRef, scrollElement, virtualizer };
}

function DiffView({
	annotation,
	filePath,
	onActiveSelectionChange,
	path,
	previousPath,
	revealLine,
	rows,
	sessionId,
	split,
	truncated,
	wrap,
}: {
	annotation: FileAnnotationModel;
	filePath: string;
	onActiveSelectionChange: (active: boolean) => void;
	path: string;
	previousPath?: string;
	revealLine?: ReviewLineTarget;
	rows: DiffRow[];
	sessionId: string;
	split: boolean;
	truncated?: boolean;
	wrap: boolean;
}) {
	const { t } = useTranslation();
	const containerRef = useRef<HTMLDivElement>(null);
	const [hasSelection, setHasSelection] = useState(false);
	const [menuState, setMenuState] = useState<DiffViewMenuState | null>(null);
	const shouldVirtualize = !split && rows.length > ROW_VIRTUALIZE_THRESHOLD;
	const { listRef, scrollElement, virtualizer } = useSharedScrollRowVirtualizer(containerRef, rows.length, shouldVirtualize);
	const highlight = useDiffHighlight(rows, path, previousPath);
	// Unified view shows each row once, so a del row reads its old-file color and
	// every other row (context, add) reads its new-file color — same convention
	// toSplitRows already uses to decide which side "owns" a context row.
	const runs = useMemo(
		() => rows.map((row, index) => (row.kind === "del" ? highlight.oldSide[index] : highlight.newSide[index])),
		[rows, highlight],
	);
	const revealLineNumber = revealLine?.line;
	const revealRequestId = revealLine?.requestId;

	useEffect(() => {
		if (!revealLineNumber) return;
		const newSideIndex = rows.findIndex((row) => row.newNo === revealLineNumber);
		const rowIndex = newSideIndex >= 0 ? newSideIndex : rows.findIndex((row) => row.oldNo === revealLineNumber);
		const targetSide = newSideIndex >= 0 ? "new" : "old";
		if (rowIndex < 0 || (shouldVirtualize && !scrollElement)) return;

		if (shouldVirtualize) virtualizer.scrollToIndex(rowIndex, { align: "center" });
		let retryFrame: number | undefined;
		const focusRow = () => {
			const sideSelector = split ? `[data-diff-side="${targetSide}"]` : "";
			const row = containerRef.current?.querySelector<HTMLElement>(`[data-diff-row][data-row-index="${rowIndex}"]${sideSelector}`);
			if (!row) return false;
			row.scrollIntoView({ block: "center" });
			row.focus({ preventScroll: true });
			return true;
		};
		const frame = window.requestAnimationFrame(() => {
			if (!focusRow()) retryFrame = window.requestAnimationFrame(focusRow);
		});
		return () => {
			window.cancelAnimationFrame(frame);
			if (retryFrame !== undefined) window.cancelAnimationFrame(retryFrame);
		};
	}, [revealLineNumber, revealRequestId, rows, scrollElement, shouldVirtualize, split, virtualizer]);

	useEffect(() => {
		const onSelectionChange = () => {
			setHasSelection(isSelectionActiveIn(window.getSelection(), containerRef.current));
		};
		document.addEventListener("selectionchange", onSelectionChange);
		return () => document.removeEventListener("selectionchange", onSelectionChange);
	}, []);

	const menuOpen = menuState?.open ?? false;
	useEffect(() => {
		onActiveSelectionChange(hasSelection || menuOpen);
		// Unmounting takes the selection with it. Without this the guard sticks on
		// after a tab switch away from the diff, and the file's detail query stays
		// disabled — the rendered view would then show content that never refreshes.
		return () => onActiveSelectionChange(false);
	}, [hasSelection, menuOpen, onActiveSelectionChange]);

	const onContextMenu = useCallback(
		(event: MouseEvent<HTMLDivElement>) => {
			const container = containerRef.current;
			const selection = window.getSelection();
			if (!isSelectionActiveIn(selection, container) || !selection) return;

			// Only past this point do we know we're overriding a real selection —
			// the native context menu must stay untouched for a collapsed selection
			// or one outside this container.
			event.preventDefault();

			const range = selection.getRangeAt(0);
			const startRow = closestDiffRowElement(range.startContainer);
			const endRow = closestDiffRowElement(range.endContainer);
			if (!startRow || !endRow) return;

			const startIndex = Number(startRow.getAttribute("data-row-index"));
			const endIndex = Number(endRow.getAttribute("data-row-index"));
			if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) return;

			const min = Math.min(startIndex, endIndex);
			const max = Math.max(startIndex, endIndex);
			const lines = rows
				.slice(min, max + 1)
				.map(toDiffSelectionLine)
				.filter(isNotNull);

			setMenuState({
				open: true,
				position: { x: event.clientX, y: event.clientY },
				lines,
				selectedText: selection.toString(),
			});
		},
		[rows],
	);

	return (
		<div>
			{truncated ? (
				<div className="shrink-0 border-b border-border bg-warning/10 px-3 py-1.5 text-xs text-warning">
					{t("files.diffTruncated")}
				</div>
			) : null}
			<div
				className="diff-code session-files-diff-scrollbar overflow-x-auto overflow-y-visible bg-terminal font-mono text-xs leading-row text-terminal-foreground"
				onContextMenu={onContextMenu}
				ref={containerRef}
			>
				{split ? (
					<SplitDiff
						annotation={annotation}
						newRuns={highlight.newSide}
						oldRuns={highlight.oldSide}
						path={path}
						previousPath={previousPath}
						rows={rows}
						t={t}
					/>
				) : shouldVirtualize ? (
					<div
						className={cn("relative", !wrap && "min-w-max")}
						ref={listRef}
						style={{ height: virtualizer.getTotalSize() }}
					>
						{virtualizer.getVirtualItems().map((virtualRow) => {
							const row = rows[virtualRow.index];
							return (
								<div
									data-index={virtualRow.index}
									key={virtualRow.index}
									ref={virtualizer.measureElement}
									style={{
										position: "absolute",
										top: 0,
										left: 0,
										width: "100%",
										transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
									}}
								>
									<DiffRowContent
										annotation={annotation}
										index={virtualRow.index}
										path={path}
										previousPath={previousPath}
										row={row}
										runs={runs[virtualRow.index]}
										t={t}
										wrap={wrap}
									/>
								</div>
							);
						})}
					</div>
				) : (
					<div className={cn(!wrap && "min-w-max")}>
						{rows.map((row, index) => (
							<DiffRowContent
								annotation={annotation}
								index={index}
								key={index}
								path={path}
								previousPath={previousPath}
								row={row}
								runs={runs[index]}
								t={t}
								wrap={wrap}
							/>
						))}
					</div>
				)}
			</div>
			<DiffSelectionMenu
				filePath={filePath}
				lines={menuState?.lines ?? []}
				onOpenChange={(open) => setMenuState((current) => (current ? { ...current, open } : current))}
				open={menuOpen}
				position={menuState?.position ?? { x: 0, y: 0 }}
				selectedText={menuState?.selectedText ?? ""}
				sessionId={sessionId}
			/>
		</div>
	);
}

const HunkBand = memo(function HunkBand({ row }: { row: DiffRow }) {
	return (
		<div className="flex select-none items-baseline gap-2 bg-surface-faint px-2.5 py-0.75 text-passive">
			<span className="shrink-0 text-passive/70">{row.text}</span>
			{row.section ? <span className="min-w-0 truncate text-passive/90">{row.section}</span> : null}
		</div>
	);
});

type DiffRowContentProps = {
	annotation: FileAnnotationModel;
	index: number;
	path: string;
	previousPath?: string;
	row: DiffRow;
	runs: DiffRun[];
	t: TFunction;
	wrap: boolean;
};

// One unified-view diff row, shared between the plain (non-virtualized) and
// virtualized render paths so they can't drift apart from each other.
function DiffRowContentInner({ annotation, index, path, previousPath, row, runs, t, wrap }: DiffRowContentProps) {
	if (row.kind === "hunk") return <HunkBand row={row} />;
	return (
		<div>
			<div
				className={cn(
					"group/line relative flex focus:outline-none focus:ring-1 focus:ring-inset focus:ring-accent",
					diffRowTone[row.kind],
				)}
				data-diff-row=""
				data-kind={row.kind}
				data-new-no={row.newNo ?? ""}
				data-old-no={row.oldNo ?? ""}
				data-row-index={index}
				tabIndex={-1}
			>
				<LineFeedbackButton
					active={isAnnotationRow(annotation.target, path, index)}
					onClick={() => annotation.begin(lineAnnotationTarget(path, previousPath, row, index))}
					t={t}
					target={lineAnnotationTarget(path, previousPath, row, index)}
				/>
				<span className="w-9 shrink-0 select-none border-r border-border/50 bg-terminal px-1.5 text-right text-passive/70 tabular-nums">
					{row.newNo ?? row.oldNo ?? ""}
				</span>
				<span
					className={cn(
						"w-4 shrink-0 select-none text-center",
						row.kind === "add" && "text-success",
						row.kind === "del" && "text-error",
					)}
				>
					{diffMarkerGlyph[row.kind]}
				</span>
				<span className={cn("pr-3", wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>
					{renderDiffRuns(runs, row.kind === "add")}
				</span>
			</div>
			{isAnnotationRow(annotation.target, path, index) ? <FileAnnotationComposer annotation={annotation} /> : null}
		</div>
	);
}

// `annotation` is a fresh object on every SessionFilesView render (its draft
// text, send status, etc. all live there), so a plain memo would never skip
// a re-render — every row would see a "changed" prop on every keystroke
// anywhere in the panel, on top of every scroll tick. Only a row that IS or
// WAS the active annotation target actually needs to re-render when
// `annotation` changes; every other row only cares about `row`/`index`/
// `path`/`previousPath`/`runs`/`wrap`, which are stable across scroll-driven
// re-renders (`runs` only gets a new reference when useDiffHighlight actually
// recomputes — unchanged rows and settled diffs keep the same array). This is
// what actually lets scrolling skip re-running the i18next calls, cn() calls,
// and nested Button for rows that are already mounted and unchanged, while
// still picking up the color pop-in once a grammar chunk finishes loading.
const DiffRowContent = memo(DiffRowContentInner, (prev, next) => {
	if (
		prev.row !== next.row ||
		prev.index !== next.index ||
		prev.path !== next.path ||
		prev.previousPath !== next.previousPath ||
		prev.runs !== next.runs ||
		prev.wrap !== next.wrap
	) {
		return false;
	}
	const prevActive = isAnnotationRow(prev.annotation.target, prev.path, prev.index);
	const nextActive = isAnnotationRow(next.annotation.target, next.path, next.index);
	return !prevActive && !nextActive;
});

type SplitRow =
	| { kind: "hunk"; row: DiffRow }
	| { kind: "pair"; left: DiffRow | null; leftIndex: number | null; right: DiffRow | null; rightIndex: number | null };

// toSplitRows aligns the unified rows into left (old) / right (new) pairs: each
// run of deletions lines up index-for-index with the additions that follow it,
// context appears on both sides, and hunk headers span the full width. Each
// side also carries its original index into the flat `rows` array (leftIndex /
// rightIndex) so SplitSide can stamp the same data-row-index the unified view
// uses, without SplitSide re-deriving it via `rows.indexOf`.
function toSplitRows(rows: DiffRow[]): SplitRow[] {
	const out: SplitRow[] = [];
	let dels: Array<{ row: DiffRow; index: number }> = [];
	let adds: Array<{ row: DiffRow; index: number }> = [];
	const flush = () => {
		const count = Math.max(dels.length, adds.length);
		for (let i = 0; i < count; i += 1) {
			out.push({
				kind: "pair",
				left: dels[i]?.row ?? null,
				leftIndex: dels[i]?.index ?? null,
				right: adds[i]?.row ?? null,
				rightIndex: adds[i]?.index ?? null,
			});
		}
		dels = [];
		adds = [];
	};
	rows.forEach((row, index) => {
		if (row.kind === "del") {
			dels.push({ row, index });
			return;
		}
		if (row.kind === "add") {
			adds.push({ row, index });
			return;
		}
		flush();
		if (row.kind === "hunk") out.push({ kind: "hunk", row });
		else out.push({ kind: "pair", left: row, leftIndex: index, right: row, rightIndex: index });
	});
	flush();
	return out;
}

function SplitDiff({
	annotation,
	newRuns,
	oldRuns,
	path,
	previousPath,
	rows,
	t,
}: {
	annotation: FileAnnotationModel;
	newRuns: DiffRun[][];
	oldRuns: DiffRun[][];
	path: string;
	previousPath?: string;
	rows: DiffRow[];
	t: TFunction;
}) {
	const splitRows = useMemo(() => toSplitRows(rows), [rows]);
	return (
		<div>
			{splitRows.map((splitRow, index) =>
				splitRow.kind === "hunk" ? (
					<HunkBand key={`sh${index}`} row={splitRow.row} />
				) : (
					<div key={`sp${index}`}>
						<div className="grid grid-cols-2 divide-x divide-border/40">
							<SplitSide
								annotation={annotation}
								path={path}
								previousPath={previousPath}
								row={splitRow.left}
								rowIndex={splitRow.leftIndex}
								runs={splitRow.leftIndex === null ? null : oldRuns[splitRow.leftIndex]}
								side="old"
								t={t}
							/>
							<SplitSide
								annotation={annotation}
								path={path}
								previousPath={previousPath}
								row={splitRow.right}
								rowIndex={splitRow.rightIndex}
								runs={splitRow.rightIndex === null ? null : newRuns[splitRow.rightIndex]}
								side="new"
								t={t}
							/>
						</div>
						{(splitRow.leftIndex !== null && isAnnotationRow(annotation.target, path, splitRow.leftIndex)) ||
						(splitRow.rightIndex !== null && isAnnotationRow(annotation.target, path, splitRow.rightIndex)) ? (
							<FileAnnotationComposer annotation={annotation} />
						) : null}
					</div>
				),
			)}
		</div>
	);
}

function SplitSide({
	annotation,
	path,
	previousPath,
	row,
	rowIndex,
	runs,
	side,
	t,
}: {
	annotation: FileAnnotationModel;
	path: string;
	previousPath?: string;
	row: DiffRow | null;
	rowIndex: number | null;
	runs: DiffRun[] | null;
	side: "old" | "new";
	t: TFunction;
}) {
	if (!row || rowIndex === null || !runs) return <div className="bg-surface-faint/20" aria-hidden="true" />;
	const lineNo = side === "old" ? row.oldNo : row.newNo;
	const tone = row.kind === "hunk" ? "" : diffRowTone[row.kind];
	const target = lineNo == null ? null : lineAnnotationTarget(path, previousPath, row, rowIndex, side);
	return (
		<div
			className={cn(
				"group/line relative flex min-w-0 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-accent",
				tone,
			)}
			data-diff-row=""
			data-diff-side={side}
			data-kind={row.kind}
			data-new-no={row.newNo ?? ""}
			data-old-no={row.oldNo ?? ""}
			data-row-index={rowIndex}
			tabIndex={-1}
		>
			{target ? (
				<LineFeedbackButton
					active={isAnnotationRow(annotation.target, path, rowIndex)}
					onClick={() => annotation.begin(target)}
					t={t}
					target={target}
				/>
			) : null}
			<span className="w-9 shrink-0 select-none border-r border-border/50 bg-terminal px-1.5 text-right text-passive/70 tabular-nums">
				{lineNo ?? ""}
			</span>
			<span className="min-w-0 whitespace-pre-wrap break-all px-1.5">{renderDiffRuns(runs, row.kind === "add")}</span>
		</div>
	);
}

function lineAnnotationTarget(
	path: string,
	previousPath: string | undefined,
	row: DiffRow,
	rowIndex: number,
	side: "old" | "new" = row.kind === "del" ? "old" : "new",
): ActiveFileAnnotationTarget {
	return {
		path,
		previousPath,
		side,
		line: side === "old" ? (row.oldNo ?? undefined) : (row.newNo ?? undefined),
		oldLine: row.oldNo ?? undefined,
		newLine: row.newNo ?? undefined,
		lineKind: row.kind === "hunk" ? undefined : row.kind,
		lineText: row.text,
		rowIndex,
	};
}

function isAnnotationRow(target: ActiveFileAnnotationTarget | null, path: string, rowIndex: number): boolean {
	return target?.path === path && target.side !== "file" && target.rowIndex === rowIndex;
}

// `t` comes from the caller (which already holds one useTranslation()
// subscription) rather than calling useTranslation() here: this button is
// invisible until hover on every diff row, and a virtualized file can mount
// dozens of them per scroll tick — a separate i18n context subscription per
// row added up on large files.
function LineFeedbackButton({
	active,
	onClick,
	t,
	target,
}: {
	active: boolean;
	onClick: () => void;
	t: TFunction;
	target: ActiveFileAnnotationTarget;
}) {
	if (active) return null;
	const side = t(target.side === "old" ? "files.oldSide" : "files.newSide");
	const label = t("files.addLineFeedback", { file: target.path, line: target.line, side });
	return (
		<Button
			aria-label={label}
			className="absolute inset-y-0 left-6 z-20 my-auto size-6 rounded-sm border-primary/70 opacity-0 shadow-md shadow-black/30 transition-opacity active:translate-y-0 active:scale-100 focus-visible:opacity-100 group-hover/line:opacity-100"
			onClick={onClick}
			size={null}
			type="button"
			variant="primary"
		>
			<Plus className="size-4" aria-hidden="true" />
		</Button>
	);
}

function FileAnnotationComposer({ annotation }: { annotation: FileAnnotationModel }) {
	const { t } = useTranslation();
	const target = annotation.target;
	if (!target) return null;
	const side = target.side === "file" ? "" : t(target.side === "old" ? "files.oldSide" : "files.newSide");
	const targetLabel =
		target.side === "file"
			? t("files.fileFeedbackTarget", { file: target.path })
			: t("files.lineFeedbackTarget", { file: target.path, line: target.line, side });
	const submit = () => void annotation.submit();

	return (
		<form
			className="border-y border-border/70 bg-surface px-3 py-2 font-sans"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<div className="mb-1.5 flex items-center justify-between gap-2">
				<span className="min-w-0 truncate font-mono text-caption text-passive">{targetLabel}</span>
				{annotation.status === "sent" ? (
					<span className="inline-flex items-center gap-1 text-caption text-success" role="status">
						<Check className="size-icon-sm" aria-hidden="true" />
						{t("files.feedbackSent")}
					</span>
				) : null}
			</div>
			<textarea
				aria-label={t("files.feedbackLabel", { target: targetLabel })}
				autoFocus
				className="min-h-20 w-full resize-y rounded-md border border-input bg-background px-2.5 py-2 text-sm text-foreground outline-none placeholder:text-passive focus-visible:outline-none disabled:opacity-60"
				disabled={annotation.status === "sending" || annotation.status === "sent"}
				onChange={(event) => annotation.setDraft(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						annotation.cancel();
					} else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
						event.preventDefault();
						submit();
					}
				}}
				placeholder={t("files.feedbackPlaceholder")}
				value={annotation.draft}
			/>
			{annotation.status === "error" ? (
				<p className="mt-1.5 text-xs text-error" role="alert">
					{annotation.error}
				</p>
			) : null}
			<div className="mt-2 flex items-center justify-end gap-1.5">
				<span className="mr-auto text-caption text-passive">{t("files.feedbackShortcut")}</span>
				<Button
					disabled={annotation.status === "sending" || annotation.status === "sent"}
					onClick={annotation.cancel}
					size="sm"
					type="button"
					variant="ghost"
				>
					{t("files.cancelFeedback")}
				</Button>
				<Button
					disabled={!annotation.draft.trim() || annotation.status === "sending" || annotation.status === "sent"}
					size="sm"
					type="submit"
				>
					<SendIcon className="size-icon-sm" aria-hidden="true" />
					{annotation.status === "sending" ? t("files.sendingFeedback") : t("files.sendFeedback")}
				</Button>
			</div>
		</form>
	);
}

// Renders a diff line's composed runs: a highlight.js class when the line could
// be tokenized, layered with the existing exact-changed-word background tint. A
// run with neither renders as a bare string, matching the plain-text output this
// replaces exactly (no highlighting available for the file's language, or the
// row is unchanged context with nothing to tokenize against).
function renderDiffRuns(runs: DiffRun[], add: boolean): ReactNode {
	return runs.map((run, index) =>
		run.changed ? (
			<span className={cn(run.className, "rounded-sm", add ? "bg-success/35" : "bg-error/35")} key={index}>
				{run.text}
			</span>
		) : run.className ? (
			<span className={run.className} key={index}>
				{run.text}
			</span>
		) : (
			run.text
		),
	);
}

function ChangeBadges({ additions, deletions }: { additions: number; deletions: number }) {
	return (
		<span className="flex shrink-0 items-center gap-1 font-mono text-caption font-medium">
			{additions > 0 ? <span className="px-0.5 text-success">+{additions}</span> : null}
			{deletions > 0 ? <span className="px-0.5 text-error">-{deletions}</span> : null}
		</span>
	);
}

function PanelMessage({ action, children, compact = false }: { action?: ReactNode; children: ReactNode; compact?: boolean }) {
	return (
		<div
			className={cn(
				"grid place-items-center text-center text-xs text-muted-foreground",
				compact ? "min-h-16 p-3" : "min-h-[180px] p-6",
			)}
		>
			<div className="flex max-w-sm flex-col items-center gap-3">
				<p>{children}</p>
				{action ?? null}
			</div>
		</div>
	);
}

function RetryButton({ onClick }: { onClick: () => void }) {
	const { t } = useTranslation();
	return (
		<Button onClick={onClick} size="sm" type="button" variant="outline">
			{t("files.retry")}
		</Button>
	);
}

function StatusMark({ status }: { status: WorkspaceFileStatus }) {
	const { t } = useTranslation();
	const label = statusLabel[status];
	return (
		<span
			className={cn(
				"inline-flex w-5 shrink-0 items-center justify-center font-mono text-caption font-bold",
				statusTone[status],
			)}
			title={t(`files.status.${status}`)}
		>
			{label}
		</span>
	);
}
