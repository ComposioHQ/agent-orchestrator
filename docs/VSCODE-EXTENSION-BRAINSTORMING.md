# File Browser & Markdown Viewer for AO Web Dashboard

## Problem

When using AO remotely, agents produce markdown plans and code that need to be read frequently. Currently this requires opening a separate code-server instance alongside the AO dashboard — constant context-switching between two browser tabs.

## Solution

Add a **VSCode-like IDE layout** to the AO session detail page. A compact top bar, then a three-pane workspace: file tree (left), file preview (center), and live terminal (right). All pane separators are draggable to resize.

This is built into the existing `(with-sidebar)` route group from the `gb-personal` branch, adding a new `workspace` sub-route at `(with-sidebar)/sessions/[id]/workspace`. All new components live in an isolated `components/workspace/` directory to avoid merge conflicts with `main`.

---

## Visual Layout

### Full IDE Layout (within `(with-sidebar)` shell)

```
┌────────────┬────────────────────────────────────────────────────────────────────────┐
│            │ ← app-1 · ● Working · feat/fix-auth-bug · PR #89 · +42 -8   🔗 ⚙    │
│  PROJECT   ├───────────────┬───────────────────────────────────┬────────────────────┤
│  SIDEBAR   │ FILES      «  │ PREVIEW                        «  │ TERMINAL        «  │
│ (existing) │               │                                   │                    │
│ ────────── │ 📁 src/       │ # Authentication Plan             │ $ claude           │
│ Portfolio  │ ├── 📁 auth/  │                                   │                    │
│ ────────── │ │  ├── 🟡 logi│ ## Phase 1: Token Validation      │ I'll fix the JWT   │
│ 🟢 my-app  │ │  ├── 🟢 sign│                                   │ validation.        │
│   ● app-1  │ │  └── 🟡 util│ We need to fix the JWT validation │                    │
│   ● app-2  │ ├── 📁 api/   │ logic in `src/auth/login.ts`.     │ Reading login.ts   │
│ 🟢 backend │ │  └──  routes│ The current impl doesn't check    │ ...                │
│   ● be-1   │ └──  index.ts │ token expiry.                     │ Writing login.ts   │
│            │ 📁 docs/      │                                   │ ...                │
│            │ └── 📄 plan.md│ ### Changes Required              │                    │
│            │ 📁 tests/     │                                   │ Done. Token expiry │
│            │ └── 🟢 auth.te│ | File     | Change    | Status | │ check is in place. │
│            │  .gitignore   │ |----------|-----------|--------| │                    │
│            │  package.json │ | login.ts | Fix exp   | ✅     | │ > █                │
│            │ 🟡 README.md  │ | utils.ts | Add help  | ⬜     | │                    │
│            │               │                                   │                    │
│            │               │ ```typescript                     │                    │
│            │               │ function validateToken(t: str) {  │                    │
│            │               │   const d = jwt.verify(t, s);     │                    │
│            │               │   if (d.exp < Date.now() / 1000)  │                    │
│            │               │     throw new TokenExpiredError(); │                    │
│            │               │   return d;                        │                    │
│            │               │ }                                  │                    │
│            │               │ ```                                │                    │
│            ├───────────────┴───────────────────────────────────┴────────────────────┤
└────────────┘               ↕                                   ↕
                       draggable                           draggable
                       separator                           separator
```

**Four distinct columns:**
1. `ProjectSidebar` (existing, 244px fixed) — project/session navigation
2. `FileTree` (new, resizable ~20%) — worktree file browser with git status
3. `Preview` (new, resizable ~40%) — rendered markdown / syntax-highlighted code
4. `Terminal` (new, resizable ~40%) — live agent terminal (reuses `DirectTerminal`)

### Compact Top Bar (single line)

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ ← app-1 · ● Working · feat/fix-auth-bug · PR #89 · +42 -8 · CI ✓       🔗  ⚙     │
└─────────────────────────────────────────────────────────────────────────────────────┘
  │    │      │           │                   │        │         │          │   │
  │    │      │           │                   │        │         │          │   └ settings/prefs
  │    │      │           │                   │        │         │          └ open in old view
  │    │      │           │                   │        │         └ CI status badge
  │    │      │           │                   │        └ additions/deletions
  │    │      │           │                   └ PR link (opens GitHub)
  │    │      │           └ branch name (copyable)
  │    │      └ activity dot + label (Working/Idle/etc)
  │    └ session ID
  └ back to dashboard
```

All existing top-strip elements compressed into a single `height: 40px` bar. Same info, less vertical space.

### File Tree — Git Status Colors

```
File Tree Legend:
  🟢 Green  (#3fb950) = Added / untracked
  🟡 Yellow (#d29922) = Modified
  🔴 Red    (#f85149) = Deleted
  ⚪ No indicator     = Unchanged

Directory inherits color from children:
  📁 src/auth/  → yellow tint if any child is modified
  📁 tests/     → green tint if all children are new
```

### Preview Pane — Code File Selected

When a non-markdown file is selected, syntax-highlighted code with line numbers:

```
┌─── PREVIEW ────────────────────────────────────────────────┐
│  src/auth/login.ts                                  🟡 M   │
│ ──────────────────────────────────────────────────────────── │
│   1 │ import jwt from "jsonwebtoken";                       │
│   2 │ import { TokenExpiredError } from "./errors.js";      │
│   3 │                                                       │
│   4 │ export function validateToken(tok: string) {          │
│   5 │   const decoded = jwt.verify(tok, SECRET);            │
│   6 │   if (decoded.exp < Date.now() / 1000) {              │
│   7 │     throw new TokenExpiredError();                     │
│   8 │   }                                                    │
│   9 │   return decoded;                                      │
│  10 │ }                                                      │
└──────────────────────────────────────────────────────────────┘
```

### Empty State — No File Selected

```
┌─── PREVIEW ────────────────────────────────────────────────┐
│                                                             │
│                   📄                                        │
│                                                             │
│              Select a file from                             │
│              the tree to preview                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### Pane Headers

Each pane has a thin header bar (24px) with a label and a collapse chevron (`«`):

```
┌── FILES          « ┐┌── PREVIEW          « ┐┌── TERMINAL          « ┐
│ 📁 src/             ││ # Plan Title          ││ $ claude               │
│ ├── 📁 auth/        ││ ...                   ││ ...                    │
└─────────────────────┘└───────────────────────┘└────────────────────────┘
```

### Collapsed Pane States

Clicking `«` or dragging the separator to the edge collapses a pane to a **thin 32px vertical strip** with the panel's icon. Clicking the strip (or its `»` chevron) re-expands it.

```
File tree collapsed:                Terminal collapsed:
┌──┬───────────────┬─────────────┐  ┌──────────┬──────────────────────┬──┐
│📁│ PREVIEW       │ TERMINAL    │  │ FILES    │ PREVIEW              │▶│
│» │               │             │  │          │                      │» │
│  │               │             │  │          │                      │  │
└──┴───────────────┴─────────────┘  └──────────┴──────────────────────┴──┘
 click strip                         click strip
 to re-expand                        to re-expand

Both side panes collapsed (preview takes full width):
┌──┬─────────────────────────────────────────┬──┐
│📁│ PREVIEW                                  │▶│
│» │                                          │» │
│  │                                          │  │
└──┴─────────────────────────────────────────┴──┘
```

Pane collapsed/expanded state is persisted in `localStorage` alongside pane sizes.

---

## URL Structure

```
/sessions/app-1/workspace?file=docs/plan.md
                 │              │
                 │              └── selected file (relative to worktree root)
                 └── new sub-route under (with-sidebar) group
```

This lives within the `(with-sidebar)` layout, so the `ProjectSidebar` is automatically present on the left. The workspace three-pane layout fills the remaining `flex-1` content area.

- Refreshing preserves the selected file
- Sharing the URL opens the exact same view
- Pane sizes stored in `localStorage` (not URL — too noisy)

A "Workspace" link in the sidebar session list and on the session detail page provides navigation to this view.

---

## Technical Design

### New Page (Modular, Minimal Existing Code Changes)

```
packages/web/src/
  app/(with-sidebar)/sessions/[id]/
    page.tsx                          # existing session detail — untouched
    workspace/
      page.tsx                        # NEW — workspace IDE layout
  components/
    workspace/                        # NEW — all new components in isolated directory
      WorkspaceLayout.tsx             # three-pane resizable layout
      CompactTopBar.tsx               # single-line session header
      FileTree.tsx                    # collapsible tree with git status
      FilePreview.tsx                 # markdown renderer + code viewer
      ResizablePanes.tsx              # draggable separator logic
      useFileTree.ts                  # hook: fetch tree + poll
      useFileContent.ts              # hook: fetch content + poll
      usePaneSizes.ts                # hook: localStorage persistence
      workspace.css                   # NEW — all workspace styles (not in globals.css)
  app/api/sessions/[id]/
    files/
      route.ts                       # NEW — directory tree + git status
      [...path]/
        route.ts                     # NEW — file content with ETag
```

**Key principle:** All new code lives in `workspace/` directories. Styles go in a dedicated `workspace.css` imported only by `WorkspaceLayout.tsx` — not appended to `globals.css`. This avoids CSS merge conflicts with `main` entirely. Easy to rebase from `main` or `gb-personal`.

### Dependencies to Install

Run from `packages/web/`:

```bash
pnpm add react-markdown remark-gfm rehype-highlight highlight.js
```

- **`react-markdown`** — renders markdown to React components
- **`remark-gfm`** — adds GitHub Flavored Markdown (tables, task lists, strikethrough)
- **`rehype-highlight`** — syntax highlighting for code blocks (uses highlight.js)
- **`highlight.js`** — needed for the CSS themes (import a dark theme in `workspace.css`)

No new server-side dependencies.

### How to Resolve Session → Worktree Path

The API endpoints need the session's worktree path. Follow the same pattern as existing API routes:

```typescript
// In app/api/sessions/[id]/files/route.ts
import { getServices } from "@/lib/services";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { sessionManager } = await getServices();
  const session = await sessionManager.get(id);

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const worktreePath = session.workspacePath;
  if (!worktreePath) {
    return NextResponse.json({ error: "Session has no workspace" }, { status: 404 });
  }

  // Now use worktreePath with fs.readdirSync / execSync("git status") etc.
}
```

Key fields from `session` (type `Session` from `@composio/ao-core`):
- `session.workspacePath` — absolute path to the git worktree on disk
- `session.id` — session ID (e.g., "app-1")
- `session.projectId` — project this session belongs to

### API Endpoints

```
GET /api/sessions/[id]/files
  → Returns directory tree + git status for the session's worktree
  → Response: { tree: FileNode[], gitStatus: Record<string, GitStatus> }

GET /api/sessions/[id]/files/[...path]
  → Returns file content
  → Headers: ETag (based on file mtime hash)
  → Response: { content: string, path: string, size: number, mtime: string }
  → Supports If-None-Match for efficient polling (304 Not Modified)
```

**FileNode type:**
```typescript
interface FileNode {
  name: string;
  path: string;            // relative to worktree root
  type: "file" | "directory";
  children?: FileNode[];   // only for directories
}

type GitStatus = "M" | "A" | "D" | "?" | "R";
```

**Git status detection (full implementation reference):**
```typescript
import { execSync } from "node:child_process";

function getGitStatus(worktreePath: string): Record<string, GitStatus> {
  const result: Record<string, GitStatus> = {};
  try {
    const output = execSync("git status --porcelain", {
      cwd: worktreePath,
      encoding: "utf-8",
      timeout: 5000,
    });
    for (const line of output.split("\n")) {
      if (!line || line.length < 4) continue;
      // Format: "XY path" where X=index status, Y=worktree status
      // " M src/foo.ts" → modified in worktree
      // "?? src/bar.ts" → untracked
      // "A  src/baz.ts" → added to index
      const status = line[0] === "?" ? "?" : (line[0] !== " " ? line[0] : line[1]);
      const filePath = line.slice(3);
      result[filePath] = status as GitStatus;
    }
  } catch {
    // git not available or not a repo — return empty
  }
  return result;
}
```

**Directory tree building:**
```typescript
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function buildTree(dirPath: string, rootPath: string): FileNode[] {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  const nodes: FileNode[] = [];

  // Sort: directories first, then alphabetical
  entries.sort((a, b) => {
    if (a.isDirectory() && !b.isDirectory()) return -1;
    if (!a.isDirectory() && b.isDirectory()) return 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    const relPath = relative(rootPath, fullPath);

    if (entry.isDirectory()) {
      // Don't filter directories — show everything in MVP
      nodes.push({
        name: entry.name,
        path: relPath,
        type: "directory",
        children: buildTree(fullPath, rootPath),
      });
    } else {
      nodes.push({
        name: entry.name,
        path: relPath,
        type: "file",
      });
    }
  }
  return nodes;
}
```

**File content endpoint — binary/size handling:**
```typescript
// In app/api/sessions/[id]/files/[...path]/route.ts

const MAX_FILE_SIZE = 1_048_576; // 1MB

// Check if file is likely binary
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".svg",
  ".woff", ".woff2", ".ttf", ".eot",
  ".pdf", ".zip", ".tar", ".gz", ".7z",
  ".exe", ".dll", ".so", ".dylib",
  ".mp3", ".mp4", ".avi", ".mov",
]);

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; path: string[] }> }) {
  const { id, path: pathSegments } = await params;
  const filePath = pathSegments.join("/");

  // ... resolve session and worktreePath ...

  const fullPath = join(worktreePath, filePath);

  // Security: ensure path doesn't escape worktree
  if (!fullPath.startsWith(worktreePath)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  const stat = statSync(fullPath);
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();

  // ETag for efficient polling
  const etag = `"${stat.mtimeMs.toString(36)}-${stat.size.toString(36)}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304 });
  }

  // Binary check
  if (BINARY_EXTENSIONS.has(ext)) {
    return NextResponse.json({
      error: "binary",
      message: "Binary file preview is not supported",
      path: filePath,
      size: stat.size,
    }, {
      status: 422,
      headers: { ETag: etag },
    });
  }

  // Size check
  if (stat.size > MAX_FILE_SIZE) {
    return NextResponse.json({
      error: "too_large",
      message: `File is too large to preview (${(stat.size / 1024 / 1024).toFixed(1)}MB)`,
      path: filePath,
      size: stat.size,
    }, {
      status: 422,
      headers: { ETag: etag },
    });
  }

  const content = readFileSync(fullPath, "utf-8");
  return NextResponse.json(
    { content, path: filePath, size: stat.size, mtime: stat.mtime.toISOString() },
    { headers: { ETag: etag } },
  );
}
```

### Resizable Panes — Implementation Reference

```typescript
// ResizablePanes.tsx
//
// Uses CSS grid with three columns. Drag handles sit between columns.
// State: [leftPercent, rightPercent] — middle is computed as (100 - left - right).
//
// Collapse: when a pane is collapsed, its column becomes "32px" (fixed).
// The freed space is distributed to the remaining expanded panes.

interface PaneConfig {
  id: string;
  label: string;
  icon: string;          // emoji or SVG for collapsed strip
  defaultPercent: number; // default width as percentage of container
  minPercent: number;     // minimum before it collapses (e.g. 8%)
}

const PANE_DEFAULTS: PaneConfig[] = [
  { id: "files",    label: "FILES",    icon: "📁", defaultPercent: 20, minPercent: 8 },
  { id: "preview",  label: "PREVIEW",  icon: "📄", defaultPercent: 40, minPercent: 15 },
  { id: "terminal", label: "TERMINAL", icon: "▶",  defaultPercent: 40, minPercent: 15 },
];

// localStorage key: "ao:workspace:panes:{sessionId}"
// Stored value: JSON { sizes: [20, 40, 40], collapsed: [false, false, false] }
```

**Drag handler pattern:**
```typescript
function onDragStart(separatorIndex: number, e: React.MouseEvent) {
  e.preventDefault(); // prevent text selection

  const startX = e.clientX;
  const containerWidth = containerRef.current!.clientWidth;
  const startSizes = [...sizes]; // current percentages

  function onMouseMove(moveEvent: MouseEvent) {
    const deltaX = moveEvent.clientX - startX;
    const deltaPct = (deltaX / containerWidth) * 100;

    // separatorIndex 0 = between pane 0 and pane 1
    // separatorIndex 1 = between pane 1 and pane 2
    const newSizes = [...startSizes];
    newSizes[separatorIndex] = Math.max(PANE_DEFAULTS[separatorIndex].minPercent, startSizes[separatorIndex] + deltaPct);
    newSizes[separatorIndex + 1] = Math.max(PANE_DEFAULTS[separatorIndex + 1].minPercent, startSizes[separatorIndex + 1] - deltaPct);

    setSizes(newSizes);
  }

  function onMouseUp() {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    // Persist to localStorage
    savePaneSizes(sizes);
  }

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  document.body.style.cursor = "col-resize";
  document.body.style.userSelect = "none";
}
```

**CSS approach:**
```css
.workspace-panes {
  display: grid;
  /* Columns set via inline style based on state */
  height: calc(100vh - 40px); /* viewport minus compact top bar */
  overflow: hidden;
}

.workspace-pane-header {
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-tertiary);
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface);
}

.workspace-separator {
  width: 4px;
  cursor: col-resize;
  background: var(--color-border-subtle);
  transition: background 0.15s;
}
.workspace-separator:hover {
  background: var(--color-accent);
}

.workspace-collapsed-strip {
  width: 32px;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 8px;
  gap: 8px;
  cursor: pointer;
  background: var(--color-bg-surface);
  border-right: 1px solid var(--color-border-subtle);
}
```

**Grid columns inline style (computed from state):**
```typescript
function getGridColumns(sizes: number[], collapsed: boolean[]): string {
  // Example: [20, 40, 40] with collapsed=[false, false, false]
  // → "20fr 4px 40fr 4px 40fr"
  // With collapsed=[true, false, false]
  // → "32px 0px 55fr 4px 45fr"  (redistributed)

  const parts: string[] = [];
  const expandedTotal = sizes.reduce((sum, s, i) => sum + (collapsed[i] ? 0 : s), 0);

  for (let i = 0; i < sizes.length; i++) {
    if (i > 0) {
      // Separator between panes (0px if left pane is collapsed)
      parts.push(collapsed[i - 1] || collapsed[i] ? "0px" : "4px");
    }
    if (collapsed[i]) {
      parts.push("32px");
    } else {
      // Redistribute so expanded panes fill remaining space
      const normalized = (sizes[i] / expandedTotal) * 100;
      parts.push(`${normalized}fr`);
    }
  }
  return parts.join(" ");
}
```

### CompactTopBar — Data & Props

The workspace page fetches session data the same way the existing session detail page does — poll `/api/sessions/{id}` every 5s. Pass the `DashboardSession` object to `CompactTopBar`:

```typescript
// CompactTopBar.tsx
import type { DashboardSession, DashboardPR } from "@/lib/types";

interface CompactTopBarProps {
  session: DashboardSession;
}

// Extract these from session (same as existing SessionDetail.tsx):
// - session.id                          → "app-1"
// - session.activity                    → "active" | "ready" | etc.
// - session.branch                      → "feat/fix-auth-bug"
// - session.pr?.number                  → 89
// - session.pr?.url                     → "https://github.com/..."
// - session.pr?.additions / deletions   → +42 / -8
// - session.pr?.ciStatus                → "passing" | "failing" | "pending"

// Activity colors (reuse from SessionDetail.tsx):
const activityMeta: Record<string, { label: string; color: string }> = {
  active:        { label: "Active",            color: "var(--color-status-working)" },
  ready:         { label: "Ready",             color: "var(--color-status-ready)" },
  idle:          { label: "Idle",              color: "var(--color-status-idle)" },
  waiting_input: { label: "Waiting for input", color: "var(--color-status-attention)" },
  blocked:       { label: "Blocked",           color: "var(--color-status-error)" },
  exited:        { label: "Exited",            color: "var(--color-status-error)" },
};
```

### DirectTerminal — How to Reuse

Import and render in the terminal pane with these props (same as `SessionDetail.tsx` lines 345-352):

```typescript
import { DirectTerminal } from "@/components/DirectTerminal";

// Inside the terminal pane:
<DirectTerminal
  sessionId={session.id}
  variant={isOrchestrator ? "orchestrator" : "agent"}
  height="100%"  // fill the pane (unlike session detail which uses clamp())
  isOpenCodeSession={session.metadata["agent"] === "opencode"}
  reloadCommand={
    session.metadata["agent"] === "opencode" && session.metadata["opencodeSessionId"]
      ? `/exit\nopencode --session ${session.metadata["opencodeSessionId"]}\n`
      : undefined
  }
/>
```

Note: in the workspace layout, `height` should be `"100%"` since the pane itself controls the height (via CSS grid), unlike the existing session detail page which uses `clamp()`.

### File Preview — Markdown Rendering

```typescript
// FilePreview.tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
// Import a dark highlight.js theme in workspace.css:
// @import "highlight.js/styles/github-dark.css";

// For markdown files:
<ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
  {content}
</ReactMarkdown>

// For non-markdown files — plain code with line numbers:
function CodeViewer({ content, fileName }: { content: string; fileName: string }) {
  const lines = content.split("\n");
  const gutterWidth = String(lines.length).length;
  return (
    <pre className="workspace-code-viewer">
      {lines.map((line, i) => (
        <div key={i} className="workspace-code-line">
          <span className="workspace-code-gutter">
            {String(i + 1).padStart(gutterWidth)}
          </span>
          <span className="workspace-code-content">{line}</span>
        </div>
      ))}
    </pre>
  );
}

// For binary/too-large errors (422 from API):
function UnsupportedPreview({ error }: { error: string }) {
  return (
    <div className="workspace-empty-state">
      <span className="workspace-empty-icon">🚫</span>
      <p>{error}</p>
    </div>
  );
}
```

### Live Updates

- **Session data (CompactTopBar):** Poll `GET /api/sessions/{id}` every 5s — same pattern as existing `(with-sidebar)/sessions/[id]/page.tsx` (see lines 61-79 and 115-121 in that file).
- **File tree:** Poll `GET /api/sessions/{id}/files` every 5s. Compare JSON response with previous — only update state if tree structure or git status changed.
- **File content:** Poll `GET /api/sessions/{id}/files/{path}` every 5s with `If-None-Match: {etag}` header. Server returns `304` if unchanged (no data transfer). Only re-render when content actually changes.
- **Terminal:** Already live via existing WebSocket infrastructure — no polling needed.

### Auto-select File on First Visit

When loading the workspace page without a `?file=` param, auto-select the first markdown file found in the tree root. Priority order:

1. `plan.md` or `PLAN.md` (case-insensitive)
2. First `*.md` file in root directory
3. `README.md`
4. Nothing (show empty state)

---

## Navigation Between Views

All routes live within the `(with-sidebar)` layout, so the `ProjectSidebar` is always visible.

```
Dashboard (/)
  └── ProjectSidebar: click session → /sessions/[id] (existing detail page)
                      click "workspace" icon → /sessions/[id]/workspace (new IDE view)

Session Detail (/sessions/[id])
  └── "Open Workspace" button/link → /sessions/[id]/workspace

Workspace (/sessions/[id]/workspace)
  └── CompactTopBar back arrow → /sessions/[id] (or /)
  └── ProjectSidebar still visible — click another session to switch
```

---

## Implementation Plan

### Phase 1: API Endpoints (0.5 day)
- [ ] `GET /api/sessions/[id]/files` — directory tree + git status
- [ ] `GET /api/sessions/[id]/files/[...path]` — file content with ETag
- [ ] Tests for both endpoints

### Phase 2: Workspace Page Shell (0.5 day)
- [ ] `/sessions/[id]/workspace/page.tsx` — fetches session data, renders layout
- [ ] `CompactTopBar.tsx` — single-line header with all existing elements
- [ ] `ResizablePanes.tsx` — three-pane grid with drag handles
- [ ] `usePaneSizes.ts` — localStorage persistence

### Phase 3: File Tree (1 day)
- [ ] `FileTree.tsx` — collapsible tree with expand/collapse
- [ ] Git status color indicators on files and directories
- [ ] `useFileTree.ts` — fetch + poll hook
- [ ] Click handler updates `?file=` query param

### Phase 4: File Preview (1 day)
- [ ] `FilePreview.tsx` — markdown rendering with `react-markdown` + `remark-gfm`
- [ ] Code file viewer with syntax highlighting and line numbers
- [ ] `useFileContent.ts` — fetch + poll with ETag
- [ ] Empty state

### Phase 5: Integration & Polish (1 day)
- [ ] Terminal pane reusing `DirectTerminal`
- [ ] "Open Workspace" link from existing session detail + dashboard cards
- [ ] Responsive fallback for narrow viewports
- [ ] Pane collapse/expand behavior

**Total estimate: 4 days**

---

## Modularity Strategy

All new code is isolated so `gb-personal` and `main` branch changes don't conflict:

| What | Where | Touches existing code? |
|------|-------|----------------------|
| Workspace page | `app/(with-sidebar)/sessions/[id]/workspace/page.tsx` | ❌ New file |
| All components | `components/workspace/*.tsx` | ❌ New directory |
| File API | `app/api/sessions/[id]/files/` | ❌ New directory |
| CSS styles | `components/workspace/workspace.css` (standalone) | ❌ New file |
| Navigation links | Minor: add icon in `ProjectSidebar.tsx` + `SessionDetail.tsx` | ✅ Small, optional |

The only touch to existing code is optional navigation links — which can be deferred or done as a tiny separate patch. Zero CSS conflicts with upstream.

---

## Future Enhancements (Out of Scope for MVP)

- **Search:** Ctrl+P style fuzzy file finder
- **Diff view:** Show git diff for modified files inline
- **Editing:** Write API to enable editing files directly
- **Code-server link:** Configurable URL prefix to open any file in code-server
- **Minimap:** Code preview minimap like VSCode
- **Multiple tabs in preview pane:** Open several files at once
- **File watching via WebSocket:** Replace polling with `fs.watch` for instant updates
- **Breadcrumb bar:** Show path breadcrumb above preview pane
