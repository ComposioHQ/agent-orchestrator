# Feature Plan: Flatten workspace file-tree & preview theme

**Issue:** change-theme-correct-one
**Branch:** `feat/change-theme-correct-one`
**Status:** WIP

---

## Problem

- File-tree and preview panels show a gradient "wash" behind their content — distracting and inconsistent with the rest of the flat dark UI
- Markdown preview is overly colourful (6+ distinct VSCode-like hues for headings, links, italics, table headers, syntax tokens), clashing with the minimalist palette
- No affordances on code blocks: no language label, no copy button — unlike the Multica PR #700 reference

## Research

### Root of the "gradient background"

- **File:** `packages/web/src/components/workspace/workspace.css:15` — `.workspace-container { background: var(--color-bg); }`
- **File:** `packages/web/src/components/workspace/workspace.css:227` — `.workspace-code-viewer { background: var(--color-bg); }`
- **File:** `packages/web/src/components/workspace/workspace.css:567` — `.workspace-diff-viewer { background: var(--color-bg); }`
- **Trigger:** `--color-bg` **does not exist** in `globals.css` — the design system uses `--color-bg-base`, `--color-bg-surface`, `--color-bg-elevated`. The undefined var resolves to `initial` → transparent.
- **Why the wash appears:** `packages/web/src/app/globals.css:404-414` sets a body radial gradient in dark mode. Because the workspace panes are transparent (broken var), the body gradient bleeds through both panes.
- **Risk:** LOW — purely cosmetic; fixing by binding to `--color-bg-base` is a one-token swap.

### Markdown preview colour sprawl

- **File:** `packages/web/src/components/workspace/workspace.css:297-522`
- **Observations:**
  - Headings use 5 distinct hard-coded hues (`#e2e2e2`, `#4fc1ff`, `#dcdcaa`, `#9cdcfe`, `#c586c0`)
  - Inline `em` renders pink (`#c586c0`), strong renders near-white — inconsistent with body `#d4d4d4`
  - Table headers render in bright blue (`#4fc1ff`), blockquotes in accent blue
  - hljs tokens use full VSCode palette (`#569cd6`, `#ce9178`, `#4ec9b0`, `#b5cea8`, `#dcdcaa`, `#9cdcfe`, `#6a9955`, …)
  - All colours are hard-coded hex, none reference design tokens → light-mode support broken, theming impossible
- **Risk:** MEDIUM — CSS-only change but needs coverage of every markdown element; regressions show up on real README files.

### Code block renderer

- **File:** `packages/web/src/components/workspace/FilePreview.tsx:19-26`
- **Current:** `markdownComponents` only handles `code` (to detect `language-mermaid` and short-circuit to `MermaidDiagram`); `pre` falls through to the default ReactMarkdown renderer with no wrapping header.
- **Trigger:** Fenced code blocks render as a bare `<pre><code class="language-xxx">...</code></pre>` — no language label, no copy button.
- **Risk:** LOW — isolated to one file; mermaid short-circuit must be preserved.

### File-tree hover/selected colours

- **File:** `packages/web/src/components/workspace/workspace.css:113-177`
- **Current:** Hard-coded `rgba(255, 255, 255, 0.04)` (hover) and `rgba(255, 255, 255, 0.08)` (selected); these render OK but don't reference tokens and fight the new flat background.
- **Risk:** LOW — purely visual.

### Design tokens already available (dark theme)

- `--color-bg-base: #0a0d12` — darkest (pane background)
- `--color-bg-surface: #11161d`
- `--color-bg-elevated: #171d26` — next brightness level (code block bg, hover)
- `--color-bg-elevated-hover: #1c2430` — selected row
- `--color-text-primary: #eef3ff` — body text, headings
- `--color-text-secondary: #a5afc4` — subtext, hljs keywords/identifiers
- `--color-text-tertiary: #6f7c94` — muted, comments, gutter
- `--color-border-subtle/default/strong`
- `--color-accent: #8fb4ff` — links, strings, active state
- These already form a 4-level brightness ladder — exactly what the flat theme wants.

### Existing tests

- `packages/web/src/components/workspace/__tests__/fileTreeFilter.test.ts` — pure function, unaffected
- `packages/web/src/components/workspace/__tests__/diffParse.test.ts` — pure function, unaffected
- No Vitest/RTL coverage for `FilePreview` currently — new code-block component will need its own test.

## Root Cause

- Broken `var(--color-bg)` reference lets the body radial gradient bleed into both workspace panels.
- Markdown preview CSS was written with hard-coded VSCode hues instead of design tokens; never aligned with the monochromatic flat theme.
- `FilePreview.tsx` never implemented a code-block wrapper, so there is no language/copy affordance.

## Approach

### Fix 1: Kill the gradient bleed

- Replace `var(--color-bg)` → `var(--color-bg-base)` in `workspace.css:15,227,567`
- Add explicit `background: var(--color-bg-base)` to file-tree & preview pane wrappers (`workspace-file-tree-list`, inline `previewScrollRef` div) via a new `.workspace-preview-scroll` class on `WorkspaceLayout.tsx:485-491`
- **Behavioural difference:** panes now paint their own solid surface; body gradient is confined to the dashboard and never leaks into the IDE view.

### Fix 2: Flatten markdown preview to a token-driven monochromatic palette

- Rewrite `.workspace-markdown-preview` block in `workspace.css:297-492` to use only design tokens + brightness:
  - Body / `li` / `p` / `td`: `var(--color-text-primary)`
  - `h1`: `var(--color-text-primary)` + 700 weight + bottom border `var(--color-border-default)`
  - `h2`: `var(--color-text-primary)` + 600 weight + bottom border `var(--color-border-subtle)`
  - `h3`: `var(--color-text-primary)` + 600 weight (no border)
  - `h4/h5/h6`: `var(--color-text-secondary)` + 600 weight, progressively smaller
  - `em`: `var(--color-text-secondary)` italic (drop the pink)
  - `strong`: `var(--color-text-primary)` + 600
  - `a`: `var(--color-accent)`, underline on hover
  - `blockquote`: `background: color-mix(in srgb, var(--color-bg-elevated) 70%, transparent)` + `border-left: 3px solid var(--color-border-default)` + `color: var(--color-text-secondary)`
  - `table th`: `var(--color-text-primary)` bold, background `var(--color-bg-elevated)`
  - `table td/th borders`: `var(--color-border-subtle)`
  - `hr`: `var(--color-border-subtle)`
  - `li::marker`: `var(--color-text-tertiary)`
- **Inline code** (not inside `pre`) — slightly different hue per user request:
  - Background: `color-mix(in srgb, var(--color-accent) 12%, var(--color-bg-elevated))`
  - Colour: `color-mix(in srgb, var(--color-accent) 65%, var(--color-text-primary))`
  - Uses the accent hue subtly so `` `code` `` spans stand out from prose without blaring.
- **Block code** (`pre`/`pre code`):
  - Background: `var(--color-bg-elevated)`
  - Border: `1px solid var(--color-border-subtle)`
  - Colour: `var(--color-text-primary)` (default)
- **hljs tokens — grayscale + 1 accent**, overriding the imported `github-dark.css`:
  - `hljs-keyword`, `hljs-literal`, `hljs-built_in`, `hljs-type`, `hljs-meta`: `var(--color-text-primary)` 600 weight
  - `hljs-string`, `hljs-regexp`, `hljs-number`, `hljs-symbol`: `var(--color-accent)` (the single accent pop)
  - `hljs-function`, `hljs-title`, `hljs-title.function_`, `hljs-attr`, `hljs-variable`, `hljs-params`, `hljs-property`, `hljs-template-variable`: `var(--color-text-secondary)`
  - `hljs-comment`, `hljs-doctag`: `var(--color-text-tertiary)` italic
  - Diff tokens (`hljs-addition`/`deletion`): keep semantic green/red tints but via `color-mix` with accent-green/accent-red tokens.
- **Key behavioural difference:** the preview collapses from ~8 hues to 3 brightness tiers + 1 accent. Inline ``code`` is the only element that uses a distinct hue from the rest.

### Fix 3: Flatten non-markdown CodeViewer syntax highlight

- The existing `.hljs-*` overrides in `workspace.css:501-522` are global — they already apply to the `CodeViewer` too. Rewriting them (Fix 2) automatically flattens the raw-file preview. No separate change needed.
- Also update `.workspace-code-line:hover` to `background: var(--color-bg-elevated)` so raw-file row hover matches the flat palette.

### Fix 4: Code block header with language label + copy button

- Add a new client component `CodeBlock.tsx` in `packages/web/src/components/workspace/`:
  - Props: `{ className?: string; children: ReactNode }`
  - Extracts language id by stripping `language-` prefix off `className` (default: `"text"`)
  - Extracts raw code string by walking `children` and concatenating text nodes (ReactMarkdown passes the highlighted DOM; we need the text for clipboard, so accept the plain `children` string via a secondary `raw` prop populated from `node`).
  - Approach: use ReactMarkdown's `components.pre` override — `pre` receives the full `code` element as `children`; we can read `node.children[0].children[0].value` (the raw fenced text) off the mdast hast node, which ReactMarkdown passes via the `node` prop.
  - Renders:
    ```
    <div class="workspace-md-code-block">
      <div class="workspace-md-code-block-header">
        <span class="workspace-md-code-block-lang">{lang}</span>
        <button class="workspace-md-code-block-copy" onClick={copy}>
          {copied ? "✓ Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
    ```
  - Copy handler: `navigator.clipboard.writeText(raw)`, flip `copied` state for 1500 ms (`setTimeout`), no external animation lib (C-07).
- Wire into `FilePreview.tsx` `markdownComponents`: add `pre: CodeBlock` alongside existing `code` handler. The existing `code` handler short-circuits mermaid **before** the block is wrapped — need to ensure mermaid blocks skip the wrapper. Handle via: in `CodeBlock`, detect if the child `code` has `className` containing `language-mermaid` and just return `{children}` unwrapped (so mermaid renders as today, no header).
- **Behavioural difference:** every fenced block (except mermaid) gains a header row with the language name and a clickable copy-to-clipboard button.

### Fix 5: File-tree hover/selected via tokens

- `.workspace-file-tree-item:hover` → `background-color: var(--color-bg-elevated);` (drop hard-coded `rgba(255,255,255,0.04)`)
- `.workspace-file-tree-item--selected` → `background-color: var(--color-bg-elevated-hover);` + `color: var(--color-text-primary);`
- `.workspace-file-tree-item--selected .workspace-file-tree-name` → keep `var(--color-accent)`
- **Behavioural difference:** hover/selected states track the theme tokens and sit on the new flat surface.

## Files to Modify

| File | Change |
|------|--------|
| `packages/web/src/components/workspace/workspace.css` | Replace `var(--color-bg)`→`var(--color-bg-base)`; rewrite `.workspace-markdown-preview` + `.hljs-*` using tokens; add `.workspace-md-code-block*` styles; swap file-tree hover/selected to tokens |
| `packages/web/src/components/workspace/FilePreview.tsx` | Import & wire `CodeBlock` into `markdownComponents.pre`; keep mermaid short-circuit |
| `packages/web/src/components/workspace/CodeBlock.tsx` | **New** — client component for the language label + copy button wrapper |
| `packages/web/src/components/workspace/WorkspaceLayout.tsx` | Add `workspace-preview-scroll` class to preview scroll `<div>` so CSS can set `background: var(--color-bg-base)` |
| `packages/web/src/components/workspace/__tests__/CodeBlock.test.tsx` | **New** — renders header/label, copy button flips to ✓ Copied, mermaid short-circuits |

## Risks / Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | **Does `@import "highlight.js/styles/github-dark.css"` override our `.hljs-*` rules?** | Our rules come after the `@import` in the same file, so specificity ties — source-order wins → ours apply. Verified by current code already overriding hljs tokens this way (`workspace.css:501-522`). |
| 2 | **Can ReactMarkdown's `components.pre` access the raw fenced text?** | Yes — `react-markdown` passes a `node` prop pointing at the hast node; walking `node.children[0].children` gives the raw text. Alternative: re-stringify via React children. First approach is cleaner. |
| 3 | **Mermaid still works after adding `pre` override?** | Yes — `CodeBlock` inspects child `code.props.className` and returns unwrapped children for `language-mermaid`. The existing `code` override then kicks in and renders `MermaidDiagram`. |
| 4 | **Clipboard API in non-HTTPS dev?** | `navigator.clipboard` is available on `localhost` even over HTTP (secure context exception). Fallback: no-op + silently keep the text selected — acceptable. |
| 5 | **Light mode** | Plan uses tokens only, so light theme will inherit correctly. Verify the inline-code `color-mix` looks readable on white. |
| 6 | **C-02 (no inline styles)** | New pane-scroll background goes via a class, not `style=`. Copy button uses class + state; no inline style needed. |

## Validation

- **Unit test:** `CodeBlock.test.tsx` — renders language label from `className="language-ts"`; click copy → `navigator.clipboard.writeText` called with raw code; button text flips to `✓ Copied` and back after timeout (fake timers); mermaid child short-circuits (no header rendered).
- **Visual regression (manual):**
  - Open `packages/web/src/app/(with-sidebar)/sessions/[id]/workspace/page.tsx` for an existing session
  - Confirm file-tree and preview panes have solid `#0a0d12` background — no violet/blue radial tint
  - Open a `.md` file — verify headings use brightness ladder, inline code has subtle accent tint, fenced blocks have header with language + copy
  - Click copy → clipboard receives raw text
  - Open a `.ts` file — confirm CodeViewer syntax highlight is grayscale + accent strings
  - Toggle diff mode on a changed file — added/removed rows still legible
  - Open a markdown file containing a mermaid block — mermaid still renders, no header wrapper
- **Regression:** existing hover/selected feel in file tree still obvious; git-status colours on tree items unchanged.
- **Commands before pushing:** `pnpm build && pnpm typecheck && pnpm lint && pnpm -F @composio/ao-web test`

## Checklist

### Phase 1 — Kill gradient bleed

- [ ] **1.1** Replace `var(--color-bg)` → `var(--color-bg-base)` in `workspace.css:15,227,567`
- [ ] **1.2** Add `.workspace-preview-scroll { background: var(--color-bg-base); }` class in `workspace.css`
- [ ] **1.3** Apply `workspace-preview-scroll` class to preview scroll div in `WorkspaceLayout.tsx:485`

### Phase 2 — Flat markdown palette

- [ ] **2.1** Rewrite `.workspace-markdown-preview` h1–h6, p, em, strong, a, blockquote, ul/ol/li, table, hr rules to use tokens (`workspace.css:297-492`)
- [ ] **2.2** Rewrite inline `code` rule to use `color-mix(var(--color-accent), …)` tint
- [ ] **2.3** Rewrite `pre` block rule to use `var(--color-bg-elevated)` + border-subtle
- [ ] **2.4** Rewrite `.hljs-*` rules to grayscale (text-primary/secondary/tertiary) + `var(--color-accent)` for strings/numbers (`workspace.css:501-522`)
- [ ] **2.5** Update `.workspace-code-line:hover` to `var(--color-bg-elevated)`

### Phase 3 — File-tree token alignment

- [ ] **3.1** Swap `.workspace-file-tree-item:hover` to `var(--color-bg-elevated)`
- [ ] **3.2** Swap `.workspace-file-tree-item--selected` to `var(--color-bg-elevated-hover)`

### Phase 4 — Code block language label + copy button

- [ ] **4.1** Create `packages/web/src/components/workspace/CodeBlock.tsx` (client component, mermaid short-circuit, clipboard copy, copied-state flip)
- [ ] **4.2** Add `.workspace-md-code-block`, `.workspace-md-code-block-header`, `.workspace-md-code-block-lang`, `.workspace-md-code-block-copy` styles in `workspace.css`
- [ ] **4.3** Wire `pre: CodeBlock` into `markdownComponents` in `FilePreview.tsx` (keep existing `code` mermaid handler)
- [ ] **4.4** Add `CodeBlock.test.tsx` covering language label, copy flow (fake timers), mermaid short-circuit

### Phase 5 — Verify

- [ ] **5.1** `pnpm -F @composio/ao-web typecheck`
- [ ] **5.2** `pnpm -F @composio/ao-web lint`
- [ ] **5.3** `pnpm -F @composio/ao-web test`
- [ ] **5.4** Manual visual check (see Validation)
