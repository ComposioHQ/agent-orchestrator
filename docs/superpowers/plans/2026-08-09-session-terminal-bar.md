# Session Terminal Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate the currently routed session's identity and interface action from its terminal navigation by introducing a dedicated terminal row below the main session top bar.

**Architecture:** `SessionView` remains the owner of the routed session, selected terminal target, interface transition, and terminal mutations. It renders a route-level `ShellTopbar` containing a compact session identity card and the interface switch, followed by the existing portal host for a terminal-only row. `CenterPane` and `ChatWorkspace` continue owning their respective terminal font/fullscreen state, but use a shared `SessionTerminalBar` frame and no longer receive session-level header actions.

**Tech Stack:** React 19, TypeScript, TanStack Router, Vitest, Testing Library, Motion React, Lucide React, Tailwind CSS utilities.

## Global Constraints

- Base the stacked PR on `codex/topbar-left-sidebar-polish` (draft PR #3783), not `main`.
- The terminal row is private to the currently routed session; do not add cross-session or cross-project tabs, pickers, routes, or persisted session-tab state.
- Preserve the current agent/reviewer/shell selection logic and existing shell create, close, rename, keyboard-cycle, font-size, wheel-zoom, and fullscreen behavior.
- Move only the interface switch into the session identity card. Keep Kill, Orchestrator, Task, Kanban, Notifications, and inspector controls in the existing right-hand app-topbar action region.
- Do not add drag-and-drop, pinning, persisted ordering, or backend/API changes.
- Keep terminal controls available in terminal fullscreen without duplicating the main session header.
- Keep `design-qa.md` untouched and unstaged.

---

### Task 1: Main top-bar session identity card

**Files:**
- Modify: `frontend/src/renderer/components/ShellTopbar.tsx:60-405`
- Modify: `frontend/src/renderer/components/SessionView.tsx:320-372,678-742`
- Test: `frontend/src/renderer/components/ShellTopbar.test.tsx`
- Test: `frontend/src/renderer/components/SessionView.test.tsx`

**Interfaces:**
- Consumes: the routed `WorkspaceSession`, existing `SessionInterfaceSwitchButton`, and existing `ShellTopbar` session actions.
- Produces: `ShellTopbar({ sessionIdentityAction?: ReactNode })`, a `data-testid="session-identity-card"` region containing the current session's icon/name/status and interface action.

- [ ] **Step 1: Write failing session-card component tests**

Add worker and orchestrator assertions to `ShellTopbar.test.tsx`:

```tsx
renderTopbar({
  sessionId: "sess-1",
  children: <ShellTopbar sessionIdentityAction={<button type="button">Switch interface</button>} />,
});

const card = screen.getByTestId("session-identity-card");
expect(card).toHaveTextContent("do the thing");
expect(card).toContainElement(screen.getByRole("button", { name: "Switch interface" }));
expect(card.querySelector('img[aria-hidden="true"]')).toBeInTheDocument();
expect(card).not.toHaveTextContent("ao/sess-1");
```

The orchestrator case must assert the card shows `Orchestrator` with its orchestrator icon and retains the project-board navigation affordance outside the identity copy.

- [ ] **Step 2: Run the focused test and verify RED**

Run `npm test -- src/renderer/components/ShellTopbar.test.tsx` from `frontend/`.

Expected: FAIL because `ShellTopbar` has no `sessionIdentityAction` prop or session identity card and the worker lead still renders branch/status as separate elements.

- [ ] **Step 3: Implement the compact identity card**

Add `sessionIdentityAction?: ReactNode` to `ShellTopbar`. For a session route, render one compact bordered/surface card containing:

```tsx
<div data-testid="session-identity-card">
  <AgentAvatar decorative provider={session.provider} />
  <span>{isOrchestrator ? t("shell.orchestrator") : session.title}</span>
  <SessionStatusPill session={session} />
  {sessionIdentityAction}
</div>
```

Use the established top-bar sizes (`h-control-md`, `size-icon-xs`, `text-micro`) and keep the existing board-navigation behavior and right-side action zone unchanged. Remove the worker branch label from this lead.

- [ ] **Step 4: Write failing SessionView wiring test**

Update the `ShellTopbar` mock in `SessionView.test.tsx` to render received `sessionIdentityAction`, then assert the interface switch is inside the route header and not inside the terminal-bar host:

```tsx
const identityCard = screen.getByTestId("session-identity-card");
expect(identityCard).toContainElement(screen.getByRole("button", { name: "Switch to chat UI" }));
expect(screen.getByTestId("session-topbar-host")).not.toContainElement(
  screen.getByRole("button", { name: "Switch to chat UI" }),
);
```

- [ ] **Step 5: Run the focused test and verify RED**

Run `npm test -- src/renderer/components/SessionView.test.tsx` from `frontend/`.

Expected: FAIL because SessionView currently passes the switch through `topbarActions`/`headerActions` into the terminal row and renders no route-level `ShellTopbar`.

- [ ] **Step 6: Move SessionView's interface action to the route header**

Render `<ShellTopbar sessionIdentityAction={interfaceSwitchAction} />` immediately above `SessionTopbarHost`. Remove the `SessionInterfaceActionGroup` wrapper and embedded `<ShellTopbar embedded />` from `sessionHeaderActions`; stop passing session header actions to the terminal and Chat surfaces.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run `npm test -- src/renderer/components/ShellTopbar.test.tsx src/renderer/components/SessionView.test.tsx` from `frontend/`.

Expected: both suites pass and existing Kill/Orchestrator/Notifications/inspector assertions remain green.

- [ ] **Step 8: Commit the session header change**

```bash
git add frontend/src/renderer/components/ShellTopbar.tsx frontend/src/renderer/components/ShellTopbar.test.tsx frontend/src/renderer/components/SessionView.tsx frontend/src/renderer/components/SessionView.test.tsx
git commit -m "feat(frontend): add session identity topbar card"
```

### Task 2: Dedicated terminal-only row

**Files:**
- Create: `frontend/src/renderer/components/SessionTerminalBar.tsx`
- Create: `frontend/src/renderer/components/SessionTerminalBar.test.tsx`
- Modify: `frontend/src/renderer/components/CenterPane.tsx:24-43,220-390`
- Modify: `frontend/src/renderer/components/CenterPane.test.tsx:280-350`
- Modify: `frontend/src/renderer/components/SessionView.tsx:696-733`

**Interfaces:**
- Consumes: terminal-tab and terminal-control children plus `fullscreen: boolean`.
- Produces: `SessionTerminalBar({ children, fullscreen?: boolean })`, which portals the dedicated row to `SessionTopbarHost` normally and renders it inside the terminal pane during terminal fullscreen.

- [ ] **Step 1: Write the failing shared-frame tests**

Create `SessionTerminalBar.test.tsx` with one normal and one fullscreen case:

```tsx
render(
  <SessionTopbarProvider>
    <SessionTopbarHost data-testid="host" />
    <SessionTerminalBar><span>Terminal tabs</span></SessionTerminalBar>
  </SessionTopbarProvider>,
);
expect(screen.getByTestId("host")).toHaveTextContent("Terminal tabs");
expect(screen.getByText("Terminal tabs").closest("[data-session-terminal-bar]"))
  .toHaveClass("h-inspector-tabs");
```

The fullscreen case must assert the content renders without a mounted host.

- [ ] **Step 2: Run the focused test and verify RED**

Run `npm test -- src/renderer/components/SessionTerminalBar.test.tsx` from `frontend/`.

Expected: FAIL because `SessionTerminalBar` does not exist.

- [ ] **Step 3: Implement the shared terminal-row frame**

Create a focused component that builds the row once:

```tsx
export function SessionTerminalBar({ children, fullscreen = false }: Props) {
  const row = (
    <div className="session-terminal-bar flex h-inspector-tabs w-full shrink-0 items-stretch bg-sidebar"
         data-session-terminal-bar>
      {children}
    </div>
  );
  return fullscreen ? row : <SessionTopbarPortal>{row}</SessionTopbarPortal>;
}
```

- [ ] **Step 4: Write failing CenterPane ownership tests**

Replace the existing combined-header assertion with behavior that catches session actions leaking back into the terminal row:

```tsx
const terminalBar = screen.getByTestId("session-terminal-bar");
expect(terminalBar).toContainElement(screen.getByRole("tablist", { name: "Open terminals" }));
expect(terminalBar).toContainElement(screen.getByRole("button", { name: "New terminal" }));
expect(terminalBar).toContainElement(screen.getByRole("toolbar", { name: "Terminal display controls" }));
expect(screen.queryByTestId("session-action-region")).not.toBeInTheDocument();
```

Keep the existing fullscreen test, but assert the terminal bar and display controls remain visible after `fullscreenchange`.

- [ ] **Step 5: Run CenterPane tests and verify RED**

Run `npm test -- src/renderer/components/CenterPane.test.tsx` from `frontend/`.

Expected: FAIL because CenterPane still owns `topbarActions`, emits `session-action-region`, and has no shared terminal-bar marker.

- [ ] **Step 6: Convert CenterPane to the dedicated row**

Remove the `topbarActions` prop and ReactNode import. Wrap only tabs, add-terminal, font-size, and fullscreen controls in `SessionTerminalBar`. Preserve current-session agent/reviewer/shell tabs, overflow behavior, keyboard selection, resize measurement, and terminal body unchanged. Use `data-testid="session-terminal-bar"` on the row content for integration assertions.

- [ ] **Step 7: Run CenterPane and SessionView tests and verify GREEN**

Run `npm test -- src/renderer/components/SessionTerminalBar.test.tsx src/renderer/components/CenterPane.test.tsx src/renderer/components/SessionView.test.tsx` from `frontend/`.

Expected: all suites pass; the current session's add-terminal mutation remains the only `+` behavior.

- [ ] **Step 8: Commit the terminal-row extraction**

```bash
git add frontend/src/renderer/components/SessionTerminalBar.tsx frontend/src/renderer/components/SessionTerminalBar.test.tsx frontend/src/renderer/components/CenterPane.tsx frontend/src/renderer/components/CenterPane.test.tsx frontend/src/renderer/components/SessionView.tsx frontend/src/renderer/components/SessionView.test.tsx
git commit -m "feat(frontend): move terminal controls into dedicated bar"
```

### Task 3: Chat-mode parity and stacked PR verification

**Files:**
- Modify: `frontend/src/renderer/components/chat/ChatWorkspace.tsx:600-710`
- Modify: `frontend/src/renderer/components/chat/ChatWorkspace.test.tsx`
- Modify: `frontend/src/renderer/components/chat/SessionChatSurface.tsx`
- Modify: `frontend/src/renderer/components/chat/SessionChatSurface.test.tsx`
- Modify: `frontend/src/renderer/components/SessionView.test.tsx`
- Verify: `frontend/src/renderer/components/SessionInterfaceSwitch.test.tsx`

**Interfaces:**
- Consumes: `SessionTerminalBar`, existing Chat terminal tabs, add-terminal handler, Chat font-size state, and fullscreen state.
- Produces: the same terminal-only row contract in Chat mode, without `headerActions`/`session-action-region` props.

- [ ] **Step 1: Write failing Chat ownership tests**

Add assertions to `ChatWorkspace.test.tsx` that its tab list, New terminal button, font controls, and fullscreen control are inside `session-terminal-bar`, while `session-action-region` is absent. Add a fullscreen assertion proving the terminal row remains rendered without the portal host.

- [ ] **Step 2: Run the Chat tests and verify RED**

Run `npm test -- src/renderer/components/chat/ChatWorkspace.test.tsx src/renderer/components/chat/SessionChatSurface.test.tsx` from `frontend/`.

Expected: FAIL because ChatWorkspace still appends `headerActions` to the combined header and does not use `SessionTerminalBar`.

- [ ] **Step 3: Convert ChatWorkspace to the shared terminal row**

Remove `headerActions` from `ChatWorkspace` and `SessionChatSurface` props. Wrap Chat's existing primary tab, shell tabs, add-terminal control, font-size controls, and fullscreen control with `SessionTerminalBar`, preserving all conversation/controller behavior.

- [ ] **Step 4: Run all focused suites and verify GREEN**

Run:

```bash
npm test -- src/renderer/components/SessionTerminalBar.test.tsx src/renderer/components/CenterPane.test.tsx src/renderer/components/SessionView.test.tsx src/renderer/components/ShellTopbar.test.tsx src/renderer/components/SessionInterfaceSwitch.test.tsx src/renderer/components/chat/ChatWorkspace.test.tsx src/renderer/components/chat/SessionChatSurface.test.tsx
```

Expected: all focused suites pass.

- [ ] **Step 5: Commit Chat parity**

```bash
git add frontend/src/renderer/components/chat/ChatWorkspace.tsx frontend/src/renderer/components/chat/ChatWorkspace.test.tsx frontend/src/renderer/components/chat/SessionChatSurface.tsx frontend/src/renderer/components/chat/SessionChatSurface.test.tsx frontend/src/renderer/components/SessionView.test.tsx
git commit -m "refactor(frontend): align chat terminal bar"
```

- [ ] **Step 6: Run repository-level frontend verification**

From `frontend/`, run `npm run typecheck`, `npm test`, and `npm run build`.

Expected: typecheck and build exit 0; all frontend tests pass with only pre-existing skips.

- [ ] **Step 7: Check patch hygiene and base ownership**

From the repository root, run:

```bash
git diff --check codex/topbar-left-sidebar-polish...HEAD
git diff --stat codex/topbar-left-sidebar-polish...HEAD
git status --short
```

Expected: only this feature's frontend files and plan are changed; `design-qa.md` remains untracked and unstaged.

- [ ] **Step 8: Push and open the stacked draft PR**

Push `codex/session-terminal-bar` and create a draft PR with base `codex/topbar-left-sidebar-polish`. The PR body must state that drag/drop, pinning, persisted ordering, and cross-session tabs are deliberately deferred.
