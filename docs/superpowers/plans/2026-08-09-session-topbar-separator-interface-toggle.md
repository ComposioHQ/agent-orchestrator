# Session Topbar Separator and Interface Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct the collapsed worker-inspector separator ordering and replace the idle interface switcher's visible text with a destination-specific icon.

**Architecture:** Keep all state and callbacks unchanged. `ShellTopbar` will render its existing separator in one of two explicit positions based on route/session/inspector state, while `SessionInterfaceSwitchButton` will map its existing `target` prop to an icon in the idle state. Existing active-transition UI remains untouched.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Lucide React, Tailwind CSS utilities.

## Global Constraints

- Do not change terminal tabs, notification behavior, inspector state, interface-transition semantics, or backend APIs.
- Worker collapsed order is `Kill → Orchestrator → Notifications → separator → Open inspector`.
- Orchestrator and Kanban separator ordering remains unchanged.
- The idle switch keeps its target-aware accessible name, hover explanation, disabled state, click behavior, and pending spinner.
- Active transition progress text and Cancel behavior remain visible.

---

### Task 1: Worker session utility separator

**Files:**
- Modify: `frontend/src/renderer/components/ShellTopbar.tsx:370-405`
- Test: `frontend/src/renderer/components/ShellTopbar.test.tsx:176-195,365-382`

**Interfaces:**
- Consumes: `isSessionRoute: boolean`, `isOrchestrator: boolean`, `isInspectorOpen: boolean`, and the existing `NotificationCenter` and inspector-toggle elements.
- Produces: explicit separator placement before notifications for board/orchestrator contexts and after notifications for collapsed worker inspectors.

- [ ] **Step 1: Write failing ordering tests**

Update the worker-action test so an open inspector has no utility separator in the center action group. Extend the collapsed-inspector test with these assertions:

```tsx
const actionRegion = screen.getByTestId("workspace-topbar-actions");
const notification = within(actionRegion).getByRole("button", { name: "Notifications" });
const separator = within(actionRegion).getByTestId("topbar-utility-separator");
const toggle = within(actionRegion).getByRole("button", { name: "Open inspector panel" });

expect(within(actionRegion).getAllByTestId("topbar-utility-separator")).toHaveLength(1);
expect(notification.compareDocumentPosition(separator) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
expect(separator.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
```

- [ ] **Step 2: Run the focused test and verify RED**

Run `npm test -- --run src/renderer/components/ShellTopbar.test.tsx` from `frontend/`.

Expected: FAIL because the current separator precedes Notifications and still renders while a worker inspector is open.

- [ ] **Step 3: Implement explicit separator positions**

In `ShellTopbar`, render the existing pre-notification separator only for project-board or orchestrator-session action zones. After `NotificationCenter`, render the same separator only when `isSessionRoute && !isOrchestrator && !isInspectorOpen`, immediately before the existing Open inspector control.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: all `ShellTopbar` tests pass, including existing project-board and orchestrator actions.

- [ ] **Step 5: Commit the separator change**

```bash
git add frontend/src/renderer/components/ShellTopbar.tsx frontend/src/renderer/components/ShellTopbar.test.tsx
git commit -m "fix(frontend): align session topbar separator"
```

### Task 2: Destination-specific interface switch icon

**Files:**
- Modify: `frontend/src/renderer/components/SessionInterfaceSwitch.tsx:1-132`
- Test: `frontend/src/renderer/components/SessionInterfaceSwitch.test.tsx:53-62`

**Interfaces:**
- Consumes: existing `target: "chat" | "tui"`, `pending`, `supported`, `disabledReason`, and `onClick` props.
- Produces: an icon-only idle button using `MessageSquare` for `chat` and `SquareTerminal` for `tui`, with the existing target-aware `aria-label` and `title`.

- [ ] **Step 1: Write failing icon-only tests**

Replace the visible-copy assertion with target-specific cases:

```tsx
it.each([
  ["chat", "Switch to chat UI", "lucide-message-square"],
  ["tui", "Switch to terminal UI", "lucide-square-terminal"],
] as const)("uses an icon-only destination control for %s", (target, label, iconClass) => {
  render(<SessionInterfaceSwitchButton target={target} supported onClick={vi.fn()} />);
  const button = screen.getByRole("button", { name: label });
  expect(button).toHaveTextContent("");
  expect(button.querySelector("svg")).toHaveClass(iconClass);
  expect(button).toHaveAttribute("title", expect.stringContaining(label));
});
```

Keep the existing click assertion in one case and existing active-transition tests unchanged.

- [ ] **Step 2: Run the focused test and verify RED**

Run `npm test -- --run src/renderer/components/SessionInterfaceSwitch.test.tsx` from `frontend/`.

Expected: FAIL because the button currently contains visible text and always renders `ArrowRightLeft`.

- [ ] **Step 3: Implement the icon-only control**

Import `MessageSquare` and `SquareTerminal`. In the idle branch, choose `const TargetIcon = target === "chat" ? MessageSquare : SquareTerminal`, use the existing spinner when pending, render `TargetIcon` otherwise, remove the visible label span, and use the existing compact icon-button size while retaining `aria-label` and `title`.

- [ ] **Step 4: Run focused interface and session tests and verify GREEN**

Run `npm test -- --run src/renderer/components/SessionInterfaceSwitch.test.tsx src/renderer/components/SessionView.test.tsx` from `frontend/`.

Expected: both suites pass; SessionView continues finding and clicking the control by its accessible name.

- [ ] **Step 5: Commit the interface-control change**

```bash
git add frontend/src/renderer/components/SessionInterfaceSwitch.tsx frontend/src/renderer/components/SessionInterfaceSwitch.test.tsx
git commit -m "fix(frontend): compact interface switch control"
```

### Task 3: Final verification and draft PR update

**Files:**
- Verify: all files changed by Tasks 1 and 2
- Update: draft PR #3783 after successful verification

**Interfaces:**
- Consumes: the two independently passing component changes.
- Produces: a verified branch and updated remote draft PR.

- [ ] **Step 1: Run focused regression suites**

Run `npm test -- --run src/renderer/components/ShellTopbar.test.tsx src/renderer/components/SessionInterfaceSwitch.test.tsx src/renderer/components/SessionView.test.tsx src/renderer/components/SessionsBoard.test.tsx` from `frontend/`.

Expected: all focused tests pass.

- [ ] **Step 2: Run frontend typecheck**

Run `npm run typecheck` from `frontend/`. Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 3: Run the full frontend test suite**

Run `npm test` from `frontend/`. Expected: all frontend suites pass; pre-existing skips remain skips.

- [ ] **Step 4: Check patch hygiene**

Run `git diff --check`, then `git status --short`. Expected: no whitespace errors; the user-owned untracked `design-qa.md` remains untouched and unstaged.

- [ ] **Step 5: Push and verify the draft PR**

Push `codex/topbar-left-sidebar-polish`, then use `gh pr view 3783 --repo Untrivial-ai/agent-orchestrator --json url,isDraft,baseRefName,headRefName,state`.

Expected: PR #3783 remains open and draft, with base `codex/session-inspector-notification-polish` and head `codex/topbar-left-sidebar-polish`.
