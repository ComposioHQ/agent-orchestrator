import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flattenDiffLines } from "../lib/diff-lines";
import { SessionFilesView } from "./SessionFilesView";

const { getMock, postMock } = vi.hoisted(() => ({ getMock: vi.fn(), postMock: vi.fn() }));

vi.mock("../lib/api-client", () => ({
	apiClient: {
		GET: getMock,
		POST: postMock,
	},
	getApiBaseUrl: () => "",
	hasTrustedApiBaseUrl: () => false,
	subscribeApiBaseUrl: () => () => undefined,
	apiErrorMessage: (error: unknown, fallback = "Request failed") => {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error) {
			return String((error as { message: unknown }).message);
		}
		return fallback;
	},
}));

// @pierre/diffs' <FileDiff>/<Virtualizer> render through a custom element
// (<diffs-container>) with a Shadow DOM internally, and drive text selection
// through real pointer/coordinate hit-testing that jsdom cannot emulate (it
// has no layout engine). Both make the real components untestable here, so
// this suite mocks the package's React boundary instead of its internals:
// MockFileDiff renders every prop this file's SessionFilesView actually
// passes (fileDiff, options, lineAnnotations, renderAnnotation,
// renderGutterUtility) as plain, queryable DOM, which is enough to verify
// SessionFilesView's own wiring — annotations, selection -> instruction,
// split/unified — without re-testing @pierre/diffs' own rendering or
// interaction-manager internals.
vi.mock("@pierre/diffs/react", () => ({
	Virtualizer: MockVirtualizer,
	FileDiff: MockFileDiff,
}));

function MockVirtualizer({
	children,
	className,
	contentClassName,
}: {
	children: ReactNode;
	className?: string;
	contentClassName?: string;
}) {
	return (
		<div className={className}>
			<div className={contentClassName}>{children}</div>
		</div>
	);
}

type MockAnnotationSide = "deletions" | "additions";
type MockSelectedLineRange = { start: number; side?: MockAnnotationSide; end: number; endSide?: MockAnnotationSide };

// Typed `any` deliberately: this stands in for @pierre/diffs' own
// FileDiffProps<LAnnotation>, whose generics aren't worth reproducing in a
// test-only mock.
function MockFileDiff({ fileDiff, lineAnnotations, options, renderAnnotation, renderGutterUtility }: any) {
	const rows = flattenDiffLines(fileDiff);
	const [pendingStart, setPendingStart] = useState<{ lineNumber: number; side: MockAnnotationSide } | null>(null);
	return (
		<div data-diff-style={options?.diffStyle} data-line-diff-type={options?.lineDiffType} data-mock-file-diff="" data-overflow={options?.overflow}>
			{rows.map((row, index) => {
				const side: MockAnnotationSide = row.kind === "del" ? "deletions" : "additions";
				const lineNumber = row.kind === "del" ? row.oldNo : row.newNo;
				const annotated = lineAnnotations?.some((entry: { side: string; lineNumber: number }) => entry.side === side && entry.lineNumber === lineNumber);
				return (
					<div data-diff-row="" data-kind={row.kind} data-new-no={row.newNo ?? ""} data-old-no={row.oldNo ?? ""} key={index}>
						{options?.enableGutterUtility && renderGutterUtility
							? renderGutterUtility(() => (lineNumber != null ? { lineNumber, side } : undefined))
							: null}
						{options?.enableLineSelection ? (
							<button
								aria-label={`select ${row.kind} row ${index}`}
								onClick={() => {
									const point = { lineNumber: lineNumber ?? 0, side };
									if (!pendingStart) {
										setPendingStart(point);
										options.onLineSelectionChange?.({ start: point.lineNumber, side: point.side, end: point.lineNumber, endSide: point.side } satisfies MockSelectedLineRange);
										return;
									}
									options.onLineSelectionChange?.({
										start: pendingStart.lineNumber,
										side: pendingStart.side,
										end: point.lineNumber,
										endSide: point.side,
									} satisfies MockSelectedLineRange);
									setPendingStart(null);
								}}
								type="button"
							/>
						) : null}
						<span className="whitespace-pre">{row.text}</span>
						{annotated && renderAnnotation ? renderAnnotation({ side, lineNumber }) : null}
					</div>
				);
			})}
		</div>
	);
}

function renderWithQuery(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}

// A diff line's content lives in a span with a `whitespace-pre*` class (real
// @pierre/diffs markup uses no such class, but MockFileDiff's stand-in row
// deliberately does, so this matcher works the same as it always has).
function diffLine(text: string) {
	return (_content: string, element: Element | null): boolean =>
		element != null && /whitespace-pre/.test(element.className) && element.textContent === text;
}

// @pierre/diffs' getSingularPatch (used by SessionFilesView to build
// FileDiffMetadata) requires a real git-style patch — file headers included —
// to locate the single file diff within it, unlike the old hand-written
// parser, which only ever looked for "@@" hunk lines. The real backend
// (workspace_files.go) always emits full git diff output, so these fixtures
// mirror production shape.
const simpleDiff =
	"diff --git a/src/App.tsx b/src/App.tsx\n" +
	"index 111..222 100644\n" +
	"--- a/src/App.tsx\n" +
	"+++ b/src/App.tsx\n" +
	"@@ -1,1 +1,1 @@\n" +
	"-const value = 0;\n" +
	"+const value = 1;\n";

const multiHunkDiff =
	"diff --git a/src/App.tsx b/src/App.tsx\n" +
	"index 111..222 100644\n" +
	"--- a/src/App.tsx\n" +
	"+++ b/src/App.tsx\n" +
	"@@ -1,3 +1,3 @@\n" +
	" line one\n" +
	"-line two\n" +
	"+line two changed\n" +
	" line three\n" +
	"@@ -10,3 +10,2 @@\n" +
	" line ten\n" +
	"-line eleven\n" +
	" line twelve\n";

// getSingularPatch (from @pierre/diffs) throws unless a patch resolves to
// exactly one file. The real backend only ever sends one file's diff per
// request, but this exercises the defensive fallback for whatever text
// reaches it — two concatenated file diffs is a simple way to make the real
// parser violate that contract without mocking it.
const multiFileDiff = `${simpleDiff}diff --git a/src/Other.tsx b/src/Other.tsx\nindex 333..444 100644\n--- a/src/Other.tsx\n+++ b/src/Other.tsx\n@@ -1,1 +1,1 @@\n-const other = 0;\n+const other = 1;\n`;

describe("SessionFilesView", () => {
	beforeEach(() => {
		getMock.mockReset();
		postMock.mockReset();
		postMock.mockResolvedValue({ data: {} });
		getMock.mockImplementation(async (path: string, options?: unknown) => {
			if (path === "/api/v1/sessions/{sessionId}/workspace/files") {
				return {
					data: {
						sessionId: "sess-1",
						truncated: false,
						compareBaseSha: "base-sha",
						compareBaseRef: "main",
						compareMode: "base",
						files: [
							{
								path: "src/App.tsx",
								status: "modified",
								additions: 2,
								deletions: 1,
								size: 120,
								binary: false,
							},
							{
								path: "README.md",
								status: "unmodified",
								additions: 0,
								deletions: 0,
								size: 80,
								binary: false,
							},
							{
								path: "docs/guide.md",
								status: "added",
								additions: 3,
								deletions: 0,
								size: 90,
								binary: false,
							},
						],
					},
				};
			}
			if (path === "/api/v1/sessions/{sessionId}/workspace/file") {
				const query = options as { params?: { query?: { path?: string } } };
				return {
					data: {
						sessionId: "sess-1",
						path: query.params?.query?.path ?? "src/App.tsx",
						status: "modified",
						additions: 2,
						deletions: 1,
						size: 120,
						binary: false,
						deleted: false,
						content: "const value = 1;\n",
						contentTruncated: false,
						diff: simpleDiff,
						diffTruncated: false,
						compareBaseSha: "base-sha",
						compareBaseRef: "main",
						compareMode: "base",
					},
				};
			}
			return { data: undefined };
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows a loading search state instead of a false zero while the first file request is pending", () => {
		getMock.mockImplementation(() => new Promise(() => {}));
		const { unmount } = renderWithQuery(<SessionFilesView sessionId="sess-1" />);

		expect(screen.getByPlaceholderText("Loading files...")).toBeInTheDocument();
		expect(screen.queryByPlaceholderText("Search 0 files")).not.toBeInTheDocument();
		unmount();
	});

	it("loads the workspace files and requests detail for the selected file", async () => {
		renderWithQuery(<SessionFilesView sessionId="sess-1" />);

		const firstFile = await screen.findByRole("button", { name: "Expand src/App.tsx" });
		expect(screen.getByPlaceholderText("Search 2 files")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Close files" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Refresh files" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /README\.md/ })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Download src/App.tsx" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add feedback for file src/App.tsx" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Diff layout" })).not.toBeInTheDocument();
		expect(screen.queryByText("Stacked")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("2 changed files")).not.toBeInTheDocument();
		expect(getMock).not.toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/workspace/file", expect.anything());

		await userEvent.click(firstFile);

		await waitFor(() =>
			expect(getMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/workspace/file", {
				params: { path: { sessionId: "sess-1" }, query: { path: "src/App.tsx" } },
			}),
		);
		expect(await screen.findByText(diffLine("const value = 1;"))).toBeInTheDocument();
	});

	it("filters and expands a changed file from the review list", async () => {
		renderWithQuery(<SessionFilesView sessionId="sess-1" />);

		await userEvent.type(await screen.findByPlaceholderText("Search 2 files"), "guide");
		expect(screen.queryByRole("button", { name: /src\/App\.tsx/ })).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "Expand docs/guide.md" }));

		await waitFor(() =>
			expect(getMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/workspace/file", {
				params: { path: { sessionId: "sess-1" }, query: { path: "docs/guide.md" } },
			}),
		);
	});

	it("keeps multiple files expanded at once", async () => {
		renderWithQuery(<SessionFilesView sessionId="sess-1" />);

		await userEvent.click(await screen.findByRole("button", { name: "Expand src/App.tsx" }));
		await userEvent.click(await screen.findByRole("button", { name: "Expand docs/guide.md" }));

		expect(await screen.findByRole("button", { name: "Collapse docs/guide.md" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Collapse src/App.tsx" })).toBeInTheDocument();
	});

	it("renders previous and current paths for renamed files", async () => {
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/sessions/{sessionId}/workspace/files") {
				return {
					data: {
						sessionId: "sess-1",
						truncated: false,
						compareMode: "base",
						files: [
							{
								path: "src/NewName.tsx",
								previousPath: "src/OldName.tsx",
								status: "renamed",
								additions: 0,
								deletions: 0,
								size: 120,
								binary: false,
							},
						],
					},
				};
			}
			return {
				data: {
					sessionId: "sess-1",
					path: "src/NewName.tsx",
					previousPath: "src/OldName.tsx",
					status: "renamed",
					additions: 0,
					deletions: 0,
					size: 120,
					binary: false,
					deleted: false,
					content: "",
					contentTruncated: false,
					diff: "",
					diffTruncated: false,
					compareMode: "base",
				},
			};
		});

		renderWithQuery(<SessionFilesView sessionId="sess-1" />);

		expect(await screen.findByText("src/OldName.tsx")).toBeInTheDocument();
		expect(screen.getByText("src/NewName.tsx")).toBeInTheDocument();
	});

	it("reports HEAD fallback when no base comparison is available", async () => {
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/sessions/{sessionId}/workspace/files") {
				return {
					data: {
						sessionId: "sess-1",
						truncated: false,
						compareMode: "head_fallback",
						files: [],
					},
				};
			}
			return { data: undefined };
		});

		renderWithQuery(<SessionFilesView sessionId="sess-1" />);

		expect(await screen.findByText("No changes against HEAD.")).toBeInTheDocument();
		expect(screen.queryByLabelText(/changed files?$/)).not.toBeInTheDocument();
	});

	it("uses the terminal foreground color for diff content", async () => {
		renderWithQuery(<SessionFilesView sessionId="sess-1" />);

		await userEvent.click(await screen.findByRole("button", { name: "Expand src/App.tsx" }));

		const codePane = (await screen.findByText(diffLine("const value = 1;"))).closest(".session-files-diff-scrollbar");
		expect(codePane).toHaveClass("text-terminal-foreground");
		expect(codePane).toHaveClass("session-files-diff-scrollbar");
		expect(codePane).not.toHaveClass("text-terminal");
	});

	it("renders a real diff without git-header noise, normalizing CRLF endings", async () => {
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/sessions/{sessionId}/workspace/files") {
				return {
					data: {
						sessionId: "sess-1",
						truncated: false,
						files: [{ path: "src/App.tsx", status: "modified", additions: 1, deletions: 1, size: 120, binary: false }],
					},
				};
			}
			return {
				data: {
					sessionId: "sess-1",
					path: "src/App.tsx",
					status: "modified",
					additions: 1,
					deletions: 1,
					size: 120,
					binary: false,
					deleted: false,
					content: "",
					contentTruncated: false,
					// CRLF endings on purpose: @pierre/diffs' patch parser must
					// normalize them like the old hand-written one did.
					diff: "diff --git a/src/App.tsx b/src/App.tsx\r\nindex 111..222 100644\r\n--- a/src/App.tsx\r\n+++ b/src/App.tsx\r\n@@ -1,2 +1,2 @@\r\n context line\r\n-old line\r\n+new line\r\n",
					diffTruncated: false,
				},
			};
		});

		renderWithQuery(<SessionFilesView sessionId="sess-1" />);
		await userEvent.click(await screen.findByRole("button", { name: "Expand src/App.tsx" }));

		// Content renders without the leading +/- marker or a trailing \r.
		expect(await screen.findByText(diffLine("new line"))).toBeInTheDocument();
		expect(screen.getByText(diffLine("old line"))).toBeInTheDocument();
		expect(screen.getByText(diffLine("context line"))).toBeInTheDocument();
		// Git file-header lines never become rendered rows.
		expect(screen.queryByText(diffLine("diff --git a/src/App.tsx b/src/App.tsx"))).not.toBeInTheDocument();
		expect(screen.queryByText(diffLine("index 111..222 100644"))).not.toBeInTheDocument();
		expect(screen.queryByText(diffLine("+++ b/src/App.tsx"))).not.toBeInTheDocument();
	});

	it("renders long lines wrapped, with word-level inline diffing, by default", async () => {
		renderWithQuery(<SessionFilesView sessionId="sess-1" />);

		await userEvent.click(await screen.findByRole("button", { name: "Expand src/App.tsx" }));
		await screen.findByText(diffLine("const value = 1;"));

		const diffRoot = document.querySelector("[data-mock-file-diff]");
		expect(diffRoot).toHaveAttribute("data-overflow", "wrap");
		expect(diffRoot).toHaveAttribute("data-line-diff-type", "word");
		expect(screen.queryByRole("button", { name: "Wrap long lines" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Disable line wrapping" })).not.toBeInTheDocument();
	});

	it("switches between unified and side-by-side split diff", async () => {
		renderWithQuery(<SessionFilesView sessionId="sess-1" />);
		await userEvent.click(await screen.findByRole("button", { name: "Expand src/App.tsx" }));
		await screen.findByText(diffLine("const value = 1;"));
		expect(document.querySelector("[data-mock-file-diff]")).toHaveAttribute("data-diff-style", "unified");

		const unifiedToggle = screen.getByRole("button", { name: "Split diff view" });
		expect(unifiedToggle).toHaveAttribute("aria-pressed", "false");
		expect(unifiedToggle.querySelector(".lucide-rows-3")).not.toBeNull();
		await userEvent.click(unifiedToggle);
		expect(document.querySelector("[data-mock-file-diff]")).toHaveAttribute("data-diff-style", "split");
		// Old and new both still rendered, just under @pierre/diffs' own split
		// layout rather than a hand-rolled grid.
		expect(screen.getByText(diffLine("const value = 0;"))).toBeInTheDocument();
		expect(screen.getByText(diffLine("const value = 1;"))).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add feedback on old line 1 in src/App.tsx" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add feedback on new line 1 in src/App.tsx" })).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "Add feedback on old line 1 in src/App.tsx" }));
		expect(screen.getByRole("textbox", { name: "Feedback for src/App.tsx · old line 1" })).toBeInTheDocument();
		await userEvent.keyboard("{Escape}");

		const splitToggle = screen.getByRole("button", { name: "Unified diff view" });
		expect(splitToggle).toHaveAttribute("aria-pressed", "true");
		expect(splitToggle.querySelector(".lucide-columns-2")).not.toBeNull();
		expect(splitToggle).not.toHaveClass("text-accent");
		await userEvent.click(splitToggle);
		expect(document.querySelector("[data-mock-file-diff]")).toHaveAttribute("data-diff-style", "unified");
		expect(screen.getByRole("button", { name: "Split diff view" }).querySelector(".lucide-rows-3")).not.toBeNull();
	});

	it("ignores split view for an added file — there is no old side to compare", async () => {
		renderWithQuery(<SessionFilesView sessionId="sess-1" />);
		await userEvent.click(await screen.findByRole("button", { name: "Expand src/App.tsx" }));
		await screen.findByText(diffLine("const value = 1;"));

		// docs/guide.md is an added file in the shared mock data.
		await userEvent.click(await screen.findByRole("button", { name: "Expand docs/guide.md" }));
		await waitFor(() =>
			expect(getMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/workspace/file", {
				params: { path: { sessionId: "sess-1" }, query: { path: "docs/guide.md" } },
			}),
		);

		await userEvent.click(screen.getByRole("button", { name: "Split diff view" }));

		const modifiedRow = screen.getByRole("button", { name: "Collapse src/App.tsx" }).closest("li");
		const addedRow = screen.getByRole("button", { name: "Collapse docs/guide.md" }).closest("li");
		expect(modifiedRow?.querySelector("[data-mock-file-diff]")).toHaveAttribute("data-diff-style", "split");
		expect(addedRow?.querySelector("[data-mock-file-diff]")).toHaveAttribute("data-diff-style", "unified");
	});

	it("sends inline line feedback to the session agent with precise diff context", async () => {
		renderWithQuery(<SessionFilesView sessionId="sess-1" />);
		await userEvent.click(await screen.findByRole("button", { name: "Expand src/App.tsx" }));
		await screen.findByText(diffLine("const value = 1;"));

		const feedbackButton = screen.getByRole("button", { name: "Add feedback on new line 1 in src/App.tsx" });
		await userEvent.click(feedbackButton);
		const feedback = screen.getByRole("textbox", { name: "Feedback for src/App.tsx · new line 1" });
		await userEvent.type(feedback, "Reuse the shared value instead.");
		await userEvent.click(screen.getByRole("button", { name: "Send feedback" }));

		await waitFor(() =>
			expect(postMock).toHaveBeenCalledWith("/api/v1/sessions/{sessionId}/send", {
				params: { path: { sessionId: "sess-1" } },
				body: { message: expect.stringContaining("Reuse the shared value instead.") },
			}),
		);
		const body = postMock.mock.calls[0][1].body as { message: string };
		expect(body.message).toContain("- Path: src/App.tsx");
		expect(body.message).toContain("- Location: New side, line 1");
		expect(body.message).toContain("- Code: const value = 1;");
		expect(await screen.findByText("Sent to agent")).toBeInTheDocument();
	});

	it("opens whole-file feedback and cancels it with Escape", async () => {
		renderWithQuery(<SessionFilesView sessionId="sess-1" />);
		await screen.findByRole("button", { name: "Expand src/App.tsx" });

		await userEvent.click(screen.getByRole("button", { name: "Add feedback for file src/App.tsx" }));
		const feedback = screen.getByRole("textbox", { name: "Feedback for src/App.tsx · whole file" });
		expect(feedback).toHaveFocus();
		await userEvent.keyboard("{Escape}");

		expect(screen.queryByRole("textbox", { name: "Feedback for src/App.tsx · whole file" })).not.toBeInTheDocument();
		expect(postMock).not.toHaveBeenCalled();
	});

	it("moves focus between file rows with j and k", async () => {
		renderWithQuery(<SessionFilesView sessionId="sess-1" />);
		const first = await screen.findByRole("button", { name: "Expand src/App.tsx" });
		const second = screen.getByRole("button", { name: "Expand docs/guide.md" });

		first.focus();
		await userEvent.keyboard("j");
		expect(second).toHaveFocus();

		await userEvent.keyboard("k");
		expect(first).toHaveFocus();
	});

	it("renders changed files as one integrated review list instead of boxed cards", async () => {
		renderWithQuery(<SessionFilesView sessionId="sess-1" />);

		const activeRowButton = await screen.findByRole("button", { name: "Expand src/App.tsx" });
		const list = screen.getByRole("list");
		const row = activeRowButton.closest("li");

		expect(list).toHaveClass("session-files-review-list");
		expect(row).toHaveClass("session-files-review-row");
		expect(row).not.toHaveClass("border");
		expect(row).not.toHaveClass("bg-surface");
		expect(row).not.toHaveClass("shadow-sm");
		expect(activeRowButton.parentElement).toHaveClass("min-h-9");
		expect(activeRowButton).toHaveClass("gap-1.5", "px-2.5", "py-1");
		expect(screen.getByLabelText("Session files").querySelector("header")).toHaveClass("h-10", "px-2");
		const modifiedMark = screen.getByTitle("Modified");
		expect(modifiedMark).toHaveTextContent("M");
		expect(modifiedMark).not.toHaveClass("rounded", "border", "bg-warning/10");
	});

	it("uses one vertical scroller for the file list and expanded diffs", async () => {
		const { container } = renderWithQuery(<SessionFilesView sessionId="sess-1" />);
		await userEvent.click(await screen.findByRole("button", { name: "Expand src/App.tsx" }));
		await screen.findByText(diffLine("const value = 1;"));

		const panelScroller = container.querySelector(".session-files-scroll-root");
		const diffScroller = container.querySelector(".session-files-diff-scrollbar");
		expect(panelScroller).toHaveClass("overflow-y-auto");
		expect(diffScroller).toHaveClass("overflow-x-auto");
		expect(diffScroller).not.toHaveClass("overflow-auto");
		expect(diffScroller?.parentElement).not.toHaveClass("max-h-[min(620px,calc(100vh-18rem))]");
	});

	it("routes vertical wheel gestures over a diff to the Files scroller immediately", async () => {
		const { container } = renderWithQuery(<SessionFilesView sessionId="sess-1" />);
		await userEvent.click(await screen.findByRole("button", { name: "Expand src/App.tsx" }));
		await screen.findByText(diffLine("const value = 1;"));

		const panelScroller = container.querySelector<HTMLElement>(".session-files-scroll-root");
		const diffScroller = container.querySelector<HTMLElement>(".session-files-diff-scrollbar");
		expect(panelScroller).not.toBeNull();
		expect(diffScroller).not.toBeNull();
		if (!panelScroller || !diffScroller) return;

		fireEvent.wheel(diffScroller, { deltaX: 0, deltaY: 80, deltaMode: WheelEvent.DOM_DELTA_PIXEL });
		expect(panelScroller.scrollTop).toBe(80);

		fireEvent.wheel(diffScroller, { deltaX: 80, deltaY: 4, deltaMode: WheelEvent.DOM_DELTA_PIXEL });
		expect(panelScroller.scrollTop).toBe(80);
	});

	it("shows binary-file feedback as a compact inline state", async () => {
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/sessions/{sessionId}/workspace/files") {
				return {
					data: {
						sessionId: "sess-1",
						truncated: false,
						files: [{ path: "screenshot.png", status: "added", additions: 0, deletions: 0, size: 120, binary: true }],
					},
				};
			}
			return {
				data: {
					sessionId: "sess-1",
					path: "screenshot.png",
					status: "added",
					additions: 0,
					deletions: 0,
					size: 120,
					binary: true,
					deleted: false,
					content: "",
					contentTruncated: false,
					diff: "",
					diffTruncated: false,
				},
			};
		});

		renderWithQuery(<SessionFilesView sessionId="sess-1" />);
		await userEvent.click(await screen.findByRole("button", { name: "Expand screenshot.png" }));

		expect((await screen.findByText("Binary file preview is not available.")).parentElement?.parentElement).toHaveClass(
			"min-h-16",
			"p-3",
		);
	});

	it("shows a fallback message instead of crashing when a diff fails to parse", async () => {
		getMock.mockImplementation(async (path: string) => {
			if (path === "/api/v1/sessions/{sessionId}/workspace/files") {
				return {
					data: {
						sessionId: "sess-1",
						truncated: false,
						files: [{ path: "src/App.tsx", status: "modified", additions: 2, deletions: 2, size: 120, binary: false }],
					},
				};
			}
			return {
				data: {
					sessionId: "sess-1",
					path: "src/App.tsx",
					status: "modified",
					additions: 2,
					deletions: 2,
					size: 120,
					binary: false,
					deleted: false,
					content: "irrelevant",
					contentTruncated: false,
					diff: multiFileDiff,
					diffTruncated: false,
				},
			};
		});

		renderWithQuery(<SessionFilesView sessionId="sess-1" />);
		await userEvent.click(await screen.findByRole("button", { name: "Expand src/App.tsx" }));

		expect(await screen.findByText("Unable to load this file.")).toBeInTheDocument();
	});

	it("uses the full session panel width while maximized", async () => {
		const { unmount } = renderWithQuery(<SessionFilesView sessionId="sess-1" />);
		const railList = await screen.findByRole("list");
		expect(railList.parentElement).toHaveClass("max-w-[1200px]");
		unmount();

		renderWithQuery(<SessionFilesView isMaximized sessionId="sess-1" />);
		const maximizedList = await screen.findByRole("list");
		expect(maximizedList.parentElement).not.toHaveClass("max-w-[1200px]");
	});

	it("lets the caller toggle between rail and maximized layouts", async () => {
		const onToggleMaximized = vi.fn();
		renderWithQuery(<SessionFilesView onToggleMaximized={onToggleMaximized} sessionId="sess-1" />);

		await userEvent.click(await screen.findByRole("button", { name: "Maximize files" }));
		expect(onToggleMaximized).toHaveBeenCalledWith(true);
	});

	it("shows a minimize action while maximized", async () => {
		const onToggleMaximized = vi.fn();
		renderWithQuery(
			<SessionFilesView isMaximized onToggleMaximized={onToggleMaximized} sessionId="sess-1" />,
		);

		await userEvent.click(await screen.findByRole("button", { name: "Minimize files" }));
		expect(onToggleMaximized).toHaveBeenCalledWith(false);
	});

	it("does not render a redundant close button in the Files toolbar", async () => {
		renderWithQuery(<SessionFilesView sessionId="sess-1" />);

		await screen.findByRole("button", { name: "Expand src/App.tsx" });
		expect(screen.queryByRole("button", { name: "Close files" })).not.toBeInTheDocument();
	});

	describe("diff selection -> send to agent", () => {
		it("opens the custom menu for a range selection and suppresses the native menu", async () => {
			const { container } = renderWithQuery(<SessionFilesView sessionId="sess-1" />);
			await userEvent.click(await screen.findByRole("button", { name: "Expand src/App.tsx" }));
			await screen.findByText(diffLine("const value = 1;"));

			// Row 0 is the deleted line, row 1 is the added line — select across both.
			await userEvent.click(screen.getByRole("button", { name: "select del row 0" }));
			await userEvent.click(screen.getByRole("button", { name: "select add row 1" }));

			const scrollPane = container.querySelector(".session-files-diff-scrollbar") as HTMLElement;
			const notCanceled = fireEvent.contextMenu(scrollPane, { clientX: 12, clientY: 34 });

			// fireEvent's return value is false when a handler called preventDefault —
			// i.e. this is direct evidence the native context menu was suppressed.
			expect(notCanceled).toBe(false);
			expect(await screen.findByRole("menuitem", { name: "Copy" })).toBeInTheDocument();
			expect(screen.getByRole("menuitem", { name: "Explain" })).toBeInTheDocument();
			expect(screen.getByRole("menuitem", { name: "Make changes" })).toBeInTheDocument();
		});

		it("leaves the native context menu untouched when there is no active selection", async () => {
			const { container } = renderWithQuery(<SessionFilesView sessionId="sess-1" />);
			await userEvent.click(await screen.findByRole("button", { name: "Expand src/App.tsx" }));
			await screen.findByText(diffLine("const value = 1;"));

			const scrollPane = container.querySelector(".session-files-diff-scrollbar") as HTMLElement;
			const notCanceled = fireEvent.contextMenu(scrollPane, { clientX: 1, clientY: 1 });

			expect(notCanceled).toBe(true);
			expect(screen.queryByRole("menuitem", { name: "Copy" })).not.toBeInTheDocument();
		});

		it("maps a selection spanning multiple hunks and a pure-deletion line to the composed message", async () => {
			getMock.mockImplementation(async (path: string) => {
				if (path === "/api/v1/sessions/{sessionId}/workspace/files") {
					return {
						data: {
							sessionId: "sess-1",
							truncated: false,
							compareMode: "base",
							files: [{ path: "src/App.tsx", status: "modified", additions: 1, deletions: 2, size: 120, binary: false }],
						},
					};
				}
				return {
					data: {
						sessionId: "sess-1",
						path: "src/App.tsx",
						status: "modified",
						additions: 1,
						deletions: 2,
						size: 120,
						binary: false,
						deleted: false,
						content: "",
						contentTruncated: false,
						diff: multiHunkDiff,
						diffTruncated: false,
					},
				};
			});

			const { container } = renderWithQuery(<SessionFilesView sessionId="sess-1" />);
			await userEvent.click(await screen.findByRole("button", { name: "Expand src/App.tsx" }));
			await screen.findByText(diffLine("line twelve"));

			// Row 0 ("line one", first hunk) through row 6 ("line twelve", second
			// hunk) — the range spans the gap between hunks and the pure-deletion
			// row (row 5, "line eleven", no new-side number).
			await userEvent.click(screen.getByRole("button", { name: "select context row 0" }));
			await userEvent.click(screen.getByRole("button", { name: "select context row 6" }));

			const scrollPane = container.querySelector(".session-files-diff-scrollbar") as HTMLElement;
			const notCanceled = fireEvent.contextMenu(scrollPane, { clientX: 5, clientY: 6 });
			expect(notCanceled).toBe(false);

			await userEvent.click(await screen.findByRole("menuitem", { name: "Explain" }));

			await waitFor(() => expect(postMock).toHaveBeenCalled());
			const body = postMock.mock.calls[0][1].body as { message: string };
			// Both hunks' real content lines made it into the message...
			expect(body.message).toContain(" line one");
			expect(body.message).toContain("- line two");
			expect(body.message).toContain("+ line two changed");
			expect(body.message).toContain(" line three");
			expect(body.message).toContain(" line ten");
			expect(body.message).toContain("- line eleven");
			expect(body.message).toContain(" line twelve");
			// The pure-deletion line correctly falls back to old-line numbering
			// only where it has to; the overall range still prefers new numbers.
			expect(body.message).toContain("Selected lines 1-11:");
		});

		it("maps a single-side selection to only that side's line", async () => {
			renderWithQuery(<SessionFilesView sessionId="sess-1" />);
			await userEvent.click(await screen.findByRole("button", { name: "Expand src/App.tsx" }));
			await screen.findByText(diffLine("const value = 1;"));

			// A single click selects just that one row (start === end).
			const scrollPane = document.querySelector(".session-files-diff-scrollbar") as HTMLElement;
			await userEvent.click(screen.getByRole("button", { name: "select del row 0" }));

			const notCanceled = fireEvent.contextMenu(scrollPane, { clientX: 3, clientY: 4 });
			expect(notCanceled).toBe(false);

			await userEvent.click(await screen.findByRole("menuitem", { name: "Explain" }));

			await waitFor(() => expect(postMock).toHaveBeenCalled());
			const body = postMock.mock.calls[0][1].body as { message: string };
			expect(body.message).toContain("- const value = 0;");
			expect(body.message).not.toContain("const value = 1;");
		});
	});

	it("renders a large diff without hanging", async () => {
		const lineCount = 400;
		const hunkLines: string[] = [`@@ -1,${lineCount} +1,${lineCount} @@`];
		for (let i = 0; i < lineCount; i += 1) {
			hunkLines.push(`-old line ${i} with some content to diff against`);
			hunkLines.push(`+new line ${i} with some different content entirely`);
		}
		const diff = "diff --git a/big.txt b/big.txt\nindex 111..222 100644\n--- a/big.txt\n+++ b/big.txt\n" + hunkLines.join("\n") + "\n";

		getMock.mockImplementation(async (path: string, options?: unknown) => {
			if (path === "/api/v1/sessions/{sessionId}/workspace/files") {
				return {
					data: {
						sessionId: "sess-1",
						truncated: false,
						files: [{ path: "big.txt", status: "modified", additions: lineCount, deletions: lineCount, size: 20000, binary: false }],
					},
				};
			}
			if (path === "/api/v1/sessions/{sessionId}/workspace/file") {
				const query = options as { params?: { query?: { path?: string } } };
				return {
					data: {
						sessionId: "sess-1",
						path: query.params?.query?.path ?? "big.txt",
						status: "modified",
						additions: lineCount,
						deletions: lineCount,
						size: 20000,
						binary: false,
						deleted: false,
						content: "irrelevant",
						contentTruncated: false,
						diff,
						diffTruncated: false,
					},
				};
			}
			return { data: undefined };
		});

		renderWithQuery(<SessionFilesView sessionId="sess-1" />);
		await userEvent.click(await screen.findByRole("button", { name: "Expand big.txt" }));

		// getSingularPatch + flattenDiffLines are both linear passes over the
		// parsed diff (no LCS, unlike the old hand-written parser) — actual
		// row-level virtualization for a diff this size is @pierre/diffs' own
		// responsibility (see DiffView's <Virtualizer> wrapper), which is
		// mocked away in this suite; this is a regression smoke test for the
		// parse/flatten path, not a virtualization test.
		await waitFor(() =>
			expect(screen.getByText(diffLine("new line 0 with some different content entirely"))).toBeInTheDocument(),
		);
		expect(screen.getByText(diffLine(`new line ${lineCount - 1} with some different content entirely`))).toBeInTheDocument();
	});
});
