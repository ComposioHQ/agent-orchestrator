import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { getSingularPatch, type AnnotationSide, type DiffLineAnnotation, type FileDiffMetadata, type SelectedLineRange } from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import type { components } from "../../api/schema";
import { formatFileAnnotationMessage, type FileAnnotationTarget } from "../../shared/file-annotations";
import type { DiffSelectionLine } from "../../shared/diff-selection";
import { apiClient, apiErrorMessage } from "../lib/api-client";
import {
	isChangedWorkspaceFile,
	sessionWorkspaceFilesQueryOptions,
	type WorkspaceCompareMode,
	type WorkspaceFileSummary,
} from "../hooks/useSessionWorkspaceFiles";
import { flattenDiffLines, resolveDiffLineAt, sliceSelectedDiffLines, type ResolvedDiffLine } from "../lib/diff-lines";
import { useResolvedTheme } from "../stores/ui-store";
import { cn } from "../lib/utils";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./ui/accordion";
import { subscribeWorkspaceFileChanges } from "../lib/workspace-file-events";
import { Button } from "./ui/button";
import { DiffSelectionMenu } from "./DiffSelectionMenu";
import { Input } from "./ui/input";

type WorkspaceFileDetail = components["schemas"]["WorkspaceFileResponse"] & {
	previousPath?: string;
	compareMode?: WorkspaceCompareMode;
};
type WorkspaceFileStatus = WorkspaceFileSummary["status"];

type ActiveFileAnnotationTarget = FileAnnotationTarget;
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
};

const emptyFiles: WorkspaceFileSummary[] = [];

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
	renamed: "text-accent",
	unmodified: "text-passive",
};

// Split (old | new) view only means something when both sides have content to
// compare. Added files have nothing on the old side; deleted files have
// nothing on the new side — splitting them just wastes half the pane on an
// empty column, so those always render unified regardless of the toggle.
function canSplitCompare(status: WorkspaceFileStatus): boolean {
	return status === "modified" || status === "renamed";
}

export function SessionFilesView({
	sessionId,
	isMaximized = false,
	onToggleMaximized,
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

	const filesQuery = useQuery(sessionWorkspaceFilesQueryOptions(sessionId, t("files.error.loadWorkspace")));
	useEffect(() => subscribeWorkspaceFileChanges(sessionId, queryClient), [queryClient, sessionId]);
	const files = filesQuery.data?.files ?? emptyFiles;
	const changedFiles = useMemo(() => files.filter(isChangedWorkspaceFile), [files]);

	useEffect(() => {
		annotationGenerationRef.current += 1;
		setExpandedPaths(new Set());
		setFilter("");
		setAnnotationTarget(null);
		setAnnotationDraft("");
		setAnnotationStatus("idle");
		setAnnotationError("");
	}, [sessionId]);

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
			const scrollRoot = root.querySelector<HTMLElement>(".session-files-scroll-root");
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
	const visibleFiles = useMemo(
		() =>
			normalizedFilter
				? changedFiles.filter((file) => fileSearchText(file).includes(normalizedFilter))
				: changedFiles,
		[changedFiles, normalizedFilter],
	);
	const changedCount = changedFiles.length;
	const expandedVisibleCount = visibleFiles.filter((file) => expandedPaths.has(file.path)).length;

	const toggleVisibleFiles = () => {
		setExpandedPaths((current) => {
			const next = new Set(current);
			if (expandedVisibleCount > 0) {
				for (const file of visibleFiles) next.delete(file.path);
				return next;
			}
			for (const file of visibleFiles) next.add(file.path);
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
				<Button
					aria-label={expandedVisibleCount > 0 ? t("files.collapseAll") : t("files.expandAll")}
					className="shrink-0"
					disabled={visibleFiles.length === 0}
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

			{/* @pierre/diffs' <Virtualizer> replaces the plain scroll div: it is the
			   shared viewport every expanded file's <FileDiff> virtualizes its rows
			   against (see DiffView), the same "one shared scroll root, many
			   independently-expandable diffs" shape the old @tanstack/react-virtual
			   setup used. It renders its own outer (viewport) and inner (content)
			   elements rather than accepting arbitrary props through, so the scroll
			   root is now found by the "session-files-scroll-root" class instead of
			   a data attribute. */}
			<Virtualizer
				className="session-files-scroll-root board-scrollbar min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain bg-background"
				contentClassName={cn("flex w-full flex-col px-0", !isMaximized && "mx-auto max-w-[1200px]")}
			>
				<ReviewFileList
					annotation={annotation}
					compareMode={filesQuery.data?.compareMode}
					error={filesQuery.error}
					expandedPaths={expandedPaths}
					files={visibleFiles}
					isLoading={filesQuery.isPending}
					onExpandedPathsChange={setExpandedPaths}
					onRetry={() => void filesQuery.refetch()}
					sessionId={sessionId}
					split={split}
				/>
			</Virtualizer>
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
	sessionId,
	split,
}: {
	annotation: FileAnnotationModel;
	compareMode?: WorkspaceCompareMode;
	error: Error | null;
	expandedPaths: Set<string>;
	files: WorkspaceFileSummary[];
	isLoading: boolean;
	onExpandedPathsChange: (next: Set<string>) => void;
	onRetry: () => void;
	sessionId: string;
	split: boolean;
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
		<Accordion
			asChild
			onValueChange={(next: string[]) => onExpandedPathsChange(new Set(next))}
			type="multiple"
			value={Array.from(expandedPaths)}
		>
			<ul className="session-files-review-list flex flex-col gap-0.5">
				{files.map((file) => (
					<ReviewFileCard
						annotation={annotation}
						expanded={expandedPaths.has(file.path)}
						file={file}
						key={file.path}
						sessionId={sessionId}
						split={split}
					/>
				))}
			</ul>
		</Accordion>
	);
}

function ReviewFileCard({
	annotation,
	expanded,
	file,
	sessionId,
	split,
}: {
	annotation: FileAnnotationModel;
	expanded: boolean;
	file: WorkspaceFileSummary;
	sessionId: string;
	split: boolean;
}) {
	const { t } = useTranslation();
	// While the user has an active text selection (or the context menu it opens)
	// in this file's diff, a background refetch would re-render the diff body
	// out from under them and blow away the browser's native selection.
	const [selectionOrMenuActive, setSelectionOrMenuActive] = useState(false);
	const detailQuery = useQuery({
		queryKey: ["session-workspace-file", sessionId, file.path],
		enabled: expanded && !selectionOrMenuActive,
		queryFn: () => loadWorkspaceFile(sessionId, file.path, t),
	});

	return (
		<AccordionItem asChild value={file.path}>
			<li className="session-files-review-row overflow-hidden bg-transparent">
				<AccordionTrigger
					aria-label={t(expanded ? "files.collapseFile" : "files.expandFile", { file: fileLabel(file) })}
					className="flex min-w-0 flex-1 items-center gap-1.5 px-2.5 py-1 text-left"
					data-file-toggle=""
					headerClassName="min-h-9 hover:bg-interactive-hover/50 data-[state=open]:bg-interactive-active/35"
					trailing={
						<FileFeedbackButton
							active={annotation.target?.path === file.path && annotation.target.side === "file"}
							file={file}
							onClick={() => annotation.begin({ path: file.path, previousPath: file.previousPath, side: "file" })}
						/>
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
						<ReviewDiffBody
							annotation={annotation}
							detail={detailQuery.data}
							filePath={file.path}
							onActiveSelectionChange={setSelectionOrMenuActive}
							sessionId={sessionId}
							split={split && canSplitCompare(file.status)}
						/>
					) : null}
				</AccordionContent>
			</li>
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

async function loadWorkspaceFile(sessionId: string, path: string, t: TFunction) {
	const { data, error } = await apiClient.GET("/api/v1/sessions/{sessionId}/workspace/file", {
		params: { path: { sessionId }, query: { path } },
	});
	if (error) throw new Error(apiErrorMessage(error, t("files.error.loadWorkspaceFile")));
	if (!data) throw new Error(t("files.error.emptyResponse"));
	return data;
}

function ReviewDiffBody({
	annotation,
	detail,
	filePath,
	onActiveSelectionChange,
	sessionId,
	split,
}: {
	annotation: FileAnnotationModel;
	detail: WorkspaceFileDetail;
	filePath: string;
	onActiveSelectionChange: (active: boolean) => void;
	sessionId: string;
	split: boolean;
}) {
	const { t } = useTranslation();
	if (detail.binary) {
		return <PanelMessage compact>{t("files.binaryUnavailable")}</PanelMessage>;
	}
	if (!detail.diff) {
		return <PanelMessage compact>{emptyDiffMessage(detail.compareMode, t)}</PanelMessage>;
	}
	return (
		<ParsedDiffBody
			annotation={annotation}
			compareMode={detail.compareMode}
			diff={detail.diff}
			filePath={filePath}
			onActiveSelectionChange={onActiveSelectionChange}
			path={detail.path}
			previousPath={detail.previousPath}
			sessionId={sessionId}
			split={split}
			truncated={detail.diffTruncated}
		/>
	);
}

// getSingularPatch (from @pierre/diffs) is a synchronous, pure parse of the
// raw unified diff — unlike the old hand-written parseUnifiedDiff, it does no
// O(n^2) work (there is no intra-line LCS pass; Shiki tokenizes and
// @pierre/diffs' own inline-diff option highlight changed spans), so there is
// nothing here that a large diff needs kept off the render thread. The
// perf-sensitive part of a big diff — actually laying out and highlighting
// thousands of rows — happens inside <FileDiff> below, which DiffView wraps
// in @pierre/diffs' own <Virtualizer> instead. A worker pool
// (WorkerPoolContextProvider) is available for offloading highlighting itself,
// but wiring it up means bundling a module Worker plus its optional WASM
// grammar engine through Electron's CSP (script-src 'self', no
// wasm-unsafe-eval configured — see vite.renderer.config.ts) — a build/CSP
// change out of scope for a renderer-only diff view swap. Row virtualization
// alone already keeps a 10,000-line diff's first paint roughly the same cost
// as a 50-line one, which is what the worker threshold existed to guarantee.
function ParsedDiffBody({
	annotation,
	compareMode,
	diff,
	filePath,
	onActiveSelectionChange,
	path,
	previousPath,
	sessionId,
	split,
	truncated,
}: {
	annotation: FileAnnotationModel;
	compareMode?: WorkspaceCompareMode;
	diff: string;
	filePath: string;
	onActiveSelectionChange: (active: boolean) => void;
	path: string;
	previousPath?: string;
	sessionId: string;
	split: boolean;
	truncated?: boolean;
}) {
	const { t } = useTranslation();
	// getSingularPatch throws if the patch doesn't resolve to exactly one file
	// (e.g. a truncated diff whose header itself got cut, or an unexpected
	// multi-file patch) — catch that here rather than letting it propagate:
	// there's no error boundary scoped to the Files tab, so an uncaught throw
	// here would hit the app-root TelemetryErrorBoundary and white-screen the
	// whole renderer, not just this panel.
	const fileDiff = useMemo(() => {
		try {
			return getSingularPatch(diff);
		} catch {
			return null;
		}
	}, [diff]);
	const rows = useMemo(() => (fileDiff ? flattenDiffLines(fileDiff) : []), [fileDiff]);
	if (!fileDiff) {
		return <PanelMessage compact>{t("files.error.loadFile")}</PanelMessage>;
	}
	if (rows.length === 0) {
		return <PanelMessage compact>{emptyDiffMessage(compareMode, t)}</PanelMessage>;
	}
	return (
		<DiffView
			annotation={annotation}
			filePath={filePath}
			fileDiff={fileDiff}
			onActiveSelectionChange={onActiveSelectionChange}
			path={path}
			previousPath={previousPath}
			rows={rows}
			sessionId={sessionId}
			split={split}
			truncated={truncated}
		/>
	);
}

type DiffViewMenuState = {
	open: boolean;
	position: { x: number; y: number };
	lines: DiffSelectionLine[];
	selectedText: string;
};

// pierre-dark / pierre-light (from @pierre/theme, a @pierre/diffs dependency)
// rather than a theme built from this app's own tokens: their near-black
// background and blue accent already sit close to this app's palette, and —
// like the terminal, which keeps its own palette by the same reasoning (see
// DESIGN.md) — a syntax-highlighted code surface reads better under a theme
// built for code than one built for chrome.
const DIFF_THEME = { light: "pierre-light", dark: "pierre-dark" } as const;

function DiffView({
	annotation,
	filePath,
	fileDiff,
	onActiveSelectionChange,
	path,
	previousPath,
	rows,
	sessionId,
	split,
	truncated,
}: {
	annotation: FileAnnotationModel;
	filePath: string;
	fileDiff: FileDiffMetadata;
	onActiveSelectionChange: (active: boolean) => void;
	path: string;
	previousPath?: string;
	rows: ResolvedDiffLine[];
	sessionId: string;
	split: boolean;
	truncated?: boolean;
}) {
	const { t } = useTranslation();
	const resolvedTheme = useResolvedTheme();
	const [selectedLines, setSelectedLines] = useState<SelectedLineRange | null>(null);
	const [menuState, setMenuState] = useState<DiffViewMenuState | null>(null);

	const menuOpen = menuState?.open ?? false;
	useEffect(() => {
		onActiveSelectionChange(selectedLines != null || menuOpen);
	}, [selectedLines, menuOpen, onActiveSelectionChange]);

	// @pierre/diffs owns the drag-select gesture itself (enableLineSelection
	// below) rather than native browser text selection, so the row range comes
	// from its own SelectedLineRange instead of a DOM Range — but the trigger
	// stays the same: a right-click while something is selected opens the same
	// DiffSelectionMenu as before, with the native context menu suppressed.
	const onContextMenu = useCallback(
		(event: MouseEvent<HTMLDivElement>) => {
			if (!selectedLines) return;
			event.preventDefault();
			const lines = sliceSelectedDiffLines(rows, selectedLines);
			setMenuState({
				open: true,
				position: { x: event.clientX, y: event.clientY },
				lines,
				selectedText: lines.map((line) => line.text).join("\n"),
			});
		},
		[rows, selectedLines],
	);

	const target = annotation.target;
	const lineAnnotations: DiffLineAnnotation<undefined>[] =
		target && target.path === path && target.side !== "file" && target.line != null
			? [{ side: target.side === "old" ? "deletions" : "additions", lineNumber: target.line }]
			: [];

	return (
		<div>
			{truncated ? (
				<div className="shrink-0 border-b border-border bg-warning/10 px-3 py-1.5 text-xs text-warning">
					{t("files.diffTruncated")}
				</div>
			) : null}
			<div
				className="session-files-diff-scrollbar overflow-x-auto overflow-y-visible bg-terminal font-mono text-xs leading-row text-terminal-foreground"
				onContextMenu={onContextMenu}
			>
				<FileDiff
					fileDiff={fileDiff}
					lineAnnotations={lineAnnotations}
					options={{
						diffIndicators: "classic",
						diffStyle: split ? "split" : "unified",
						disableFileHeader: true,
						enableGutterUtility: true,
						enableLineSelection: true,
						lineDiffType: "word",
						onLineSelectionChange: setSelectedLines,
						overflow: "wrap",
						theme: DIFF_THEME,
						themeType: resolvedTheme,
					}}
					renderAnnotation={() => <FileAnnotationComposer annotation={annotation} />}
					renderGutterUtility={(getHoveredLine) => (
						<GutterFeedbackButton
							annotation={annotation}
							getHoveredLine={getHoveredLine}
							path={path}
							previousPath={previousPath}
							rows={rows}
							t={t}
						/>
					)}
					selectedLines={selectedLines}
				/>
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

// The gutter-utility slot @pierre/diffs renders is a single element it
// repositions over whichever line is hovered (rather than one button per row,
// like the old CSS-hover affordance), so both its label and its click target
// are built from the current hover — getHoveredLine() — instead of a specific
// row prop. `renderGutterUtility` and `onGutterUtilityClick` are mutually
// exclusive in @pierre/diffs (the latter drives its own gutter drag-select,
// not a plain click callback), so a custom gutter button owns its click
// handling itself rather than going through options.
function GutterFeedbackButton({
	annotation,
	getHoveredLine,
	path,
	previousPath,
	rows,
	t,
}: {
	annotation: FileAnnotationModel;
	getHoveredLine: () => { lineNumber: number; side: AnnotationSide } | undefined;
	path: string;
	previousPath?: string;
	rows: ResolvedDiffLine[];
	t: TFunction;
}) {
	const hovered = getHoveredLine();
	const side: "old" | "new" = hovered?.side === "deletions" ? "old" : "new";
	const sideLabel = t(side === "old" ? "files.oldSide" : "files.newSide");
	const label = t("files.addLineFeedback", { file: path, line: hovered?.lineNumber ?? "", side: sideLabel });
	const onClick = () => {
		const current = getHoveredLine();
		if (!current) return;
		const line = resolveDiffLineAt(rows, current.side, current.lineNumber);
		if (!line) return;
		annotation.begin(lineAnnotationTarget(path, previousPath, current.side === "deletions" ? "old" : "new", line));
	};
	return (
		<button
			aria-label={label}
			className="flex size-6 items-center justify-center rounded-sm border border-primary/70 bg-primary text-primary-foreground shadow-md shadow-black/30"
			onClick={onClick}
			type="button"
		>
			<Plus className="size-4" aria-hidden="true" />
		</button>
	);
}

function lineAnnotationTarget(
	path: string,
	previousPath: string | undefined,
	side: "old" | "new",
	line: ResolvedDiffLine,
): ActiveFileAnnotationTarget {
	return {
		path,
		previousPath,
		side,
		line: (side === "old" ? line.oldNo : line.newNo) ?? undefined,
		oldLine: line.oldNo ?? undefined,
		newLine: line.newNo ?? undefined,
		lineKind: line.kind,
		lineText: line.text,
	};
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
				"inline-flex w-5 shrink-0 items-center justify-center font-mono text-caption font-medium",
				statusTone[status],
			)}
			title={t(`files.status.${status}`)}
		>
			{label}
		</span>
	);
}
