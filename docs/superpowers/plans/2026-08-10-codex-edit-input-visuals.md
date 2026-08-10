# Codex Edit Input Visuals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inline human-message editor use the same single-surface visual language as AO's Codex-style main composer while preserving its existing Cancel and Send buttons.

**Architecture:** Keep `HumanMessageEditor` as the focused edit-state component and change only its presentation classes. The editor remains inline and retains all branching, keyboard, attachment-summary, pending, busy, and error behavior.

**Tech Stack:** React 19, TypeScript, Tailwind CSS utility classes, Vitest, Testing Library

## Global Constraints

- Keep the existing icon-only Cancel and Send controls unchanged.
- Do not change backend APIs, branching behavior, keyboard shortcuts, attachment preservation, or the main composer draft.
- Render one bordered composer surface; the textarea itself must be transparent and borderless.
- Use the conversation's readable width and retain bounded textarea growth with internal scrolling.

---

### Task 1: Match the Inline Editor to the Codex Composer Surface

**Files:**
- Modify: `frontend/src/renderer/components/chat/HumanMessageEditor.tsx`
- Test: `frontend/src/renderer/components/chat/HumanMessageEditor.test.tsx`

**Interfaces:**
- Consumes: the existing `HumanMessageEditorProps` interface and existing `Button` controls.
- Produces: unchanged `HumanMessageEditor` behavior with the main composer's shell and textarea visual tokens.

- [ ] **Step 1: Write the failing visual-contract test**

Add this test inside the existing `describe("HumanMessageEditor", ...)` block:

```tsx
it("uses one wide Codex-style composer surface without a nested input border", () => {
	render(
		<HumanMessageEditor
			text="prompt"
			content={[]}
			pending={false}
			busy={false}
			onCancel={vi.fn()}
			onSend={vi.fn()}
		/>,
	);

	const editor = screen.getByRole("textbox", { name: "Edit message" });
	const surface = editor.parentElement;
	expect(surface).toHaveClass("w-full", "max-w-3xl", "border-border-strong", "p-2.5");
	expect(editor).toHaveClass("bg-transparent", "px-1.5", "py-1.5");
	expect(editor).not.toHaveClass("border", "bg-background", "rounded-md");
	expect(screen.getByRole("button", { name: "Cancel edit" })).toHaveClass("size-7");
	expect(screen.getByRole("button", { name: "Send edited message" })).toHaveClass("size-7", "rounded-full");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run from `frontend/`:

```bash
npm test -- src/renderer/components/chat/HumanMessageEditor.test.tsx
```

Expected: FAIL because the surface still uses `max-w-[min(78%,560px)]`, `border-logo-accent/50`, and `p-2`, while the textarea still has its own border and background.

- [ ] **Step 3: Apply the minimal visual change**

Change only the outer surface and textarea class strings in `HumanMessageEditor.tsx`:

```tsx
<div className="cursor-chat-composer relative flex w-full max-w-3xl flex-col gap-2 rounded-[10px] border border-border-strong p-2.5 transition-[background,border-color,box-shadow]">
```

```tsx
className="chat-composer-scrollbar max-h-56 min-h-[3.25rem] w-full resize-none overflow-y-auto overscroll-contain bg-transparent px-1.5 py-1.5 text-sm leading-relaxed text-foreground outline-none"
```

Do not change either `Button` element or its classes.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run from `frontend/`:

```bash
npm test -- src/renderer/components/chat/HumanMessageEditor.test.tsx src/renderer/components/chat/ChatWorkspace.test.tsx
```

Expected: all tests PASS.

- [ ] **Step 5: Verify TypeScript and formatting**

Run from `frontend/`:

```bash
npm run typecheck
```

Run from the repository root:

```bash
git diff --check
```

Expected: both commands exit successfully.

- [ ] **Step 6: Commit the implementation**

```bash
git add frontend/src/renderer/components/chat/HumanMessageEditor.tsx frontend/src/renderer/components/chat/HumanMessageEditor.test.tsx docs/superpowers/plans/2026-08-10-codex-edit-input-visuals.md
git commit -m "fix(chat): match Codex prompt editor surface"
```

- [ ] **Step 7: Restart and exercise AO locally**

Launch the actual Electron app in isolated development mode from this checkout. Open a conversation, select Edit on a human message, and confirm the editor is one wide surface, retains the original text, leaves the bottom composer draft untouched, and keeps the existing Cancel and Send icons.

