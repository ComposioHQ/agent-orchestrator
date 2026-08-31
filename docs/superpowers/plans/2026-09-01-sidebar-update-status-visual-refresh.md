# Sidebar Update Status Visual Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Match AO's four supplied expanded-sidebar updater states and remove every right-side status dot while preserving updater actions and 24-hour dismissal.

**Architecture:** Keep `UpdateStatusRow` as the single state switch so updater behavior and accessibility remain centralized. Change only the expanded-row markup and Tailwind classes; leave `UpdateStatusRail`, updater state, channel selection, and persistence untouched.

**Tech Stack:** React 19, TypeScript, Tailwind CSS utility classes, Lucide icons, Vitest, Testing Library

---

### Task 1: Lock the four visual states in tests

**Files:**
- Modify: `frontend/src/renderer/components/Sidebar.test.tsx:1970-2070`

- [ ] **Step 1: Add focused assertions for the available and ready layouts**

Add assertions to the existing available-state test that the version is visible, the row is two-line, the dismiss button is unfilled, and no round status dot exists inside the expanded updater:

```tsx
const availableRow = screen.getByTestId("sidebar-update-available");
expect(within(availableRow).getByText("v9.9.9")).toBeVisible();
expect(availableRow.querySelector(".rounded-full")).toBeNull();
expect(screen.getByRole("button", { name: "Hide update v9.9.9 for 24 hours" })).not.toHaveClass("bg-interactive-hover");
```

Add assertions to the staged-state test for the blue card, visible version, and absent dot:

```tsx
const readyRow = screen.getByTestId("sidebar-update-ready");
expect(readyRow).toHaveClass("border", "border-primary/35", "bg-primary/12", "text-primary");
expect(within(readyRow).getByText("v9.9.9 ready")).toBeVisible();
expect(readyRow.querySelector(".rounded-full")).toBeNull();
```

- [ ] **Step 2: Add focused assertions for downloading and failed layouts**

Extend the current downloading and failed-state tests:

```tsx
const downloadingRow = screen.getByTestId("sidebar-update-downloading");
expect(downloadingRow).not.toHaveClass("border");
expect(downloadingRow.querySelector("svg circle")).toBeNull();

const failedRow = screen.getByTestId("sidebar-update-failed");
expect(failedRow).toHaveClass("border", "border-warning/35", "bg-warning/12", "text-warning");
expect(within(failedRow).getByText("Retry update check")).toBeVisible();
expect(failedRow.querySelector(".rounded-full")).toBeNull();
```

Import `within` from `@testing-library/react` if the test does not already import it.

- [ ] **Step 3: Run the focused tests and verify they fail for the old visual structure**

Run:

```bash
cd frontend
npx vitest run --config vite.renderer.config.ts src/renderer/components/Sidebar.test.tsx
```

Expected: FAIL because the updater test IDs and visible version lines do not exist, the downloading ring still contains circles, and available/ready rows still contain round dots.

### Task 2: Restyle the expanded updater row

**Files:**
- Modify: `frontend/src/renderer/components/Sidebar.tsx:2061-2188`
- Test: `frontend/src/renderer/components/Sidebar.test.tsx`

- [ ] **Step 1: Implement the available two-line row and plain dismiss action**

Keep the download and dismiss buttons as siblings. Change the content button to a two-line layout and make the version visible:

```tsx
<div className="flex w-full items-center gap-1" data-testid="sidebar-update-available">
  <button className={cn(NAV_ROW_CLASS, "flex min-w-0 flex-1 items-center text-left [&_svg]:size-icon-md [&_svg]:shrink-0")}>
    <Download aria-hidden="true" className="size-icon-lg shrink-0" />
    <span className="min-w-0 flex-1">
      <span className="block truncate tracking-tight">{t("shell.updateAvailable")}</span>
      {status.version && (
        <span className="block truncate text-caption font-normal text-passive">
          {t("shell.versionAvailable", { version: status.version })}
        </span>
      )}
    </span>
  </button>
  <button className="grid size-8 shrink-0 place-items-center text-muted-foreground transition-colors hover:text-foreground">
    <X aria-hidden="true" className="size-icon-base" />
  </button>
</div>
```

Retain the existing labels, handlers, `tabIndex`, and `type` attributes. Delete the red dot.

- [ ] **Step 2: Replace the downloading ring with the supplied simple row**

Use the ordinary download icon and percentage text:

```tsx
<div
  aria-live="polite"
  className={cn(NAV_ROW_CLASS, "flex w-full items-center text-left [&_svg]:size-icon-md [&_svg]:shrink-0")}
  data-testid="sidebar-update-downloading"
  role="status"
>
  <Download aria-hidden="true" className="size-icon-lg shrink-0" />
  <span className="min-w-0 flex-1 truncate tabular-nums">
    {t("settings.updates.downloading", { percent })}
  </span>
</div>
```

- [ ] **Step 3: Keep the failed card and identify it for focused verification**

Add `data-testid="sidebar-update-failed"` to the existing warning button. Preserve its orange border, tint, icon, two-line copy, retry handler, accessible label, and focus behavior.

- [ ] **Step 4: Implement the blue staged-update card with a visible version**

Replace the generic navigation-row styling and dot with the supplied card treatment:

```tsx
<button
  className={cn(
    "flex w-full items-center gap-2.5 rounded-lg border border-primary/35 bg-primary/12 p-2.5 text-left text-control font-medium text-primary transition-colors hover:bg-primary/18 [&_svg]:text-primary",
    escalated && "border-working/35 bg-working/12 text-working hover:bg-working/18 [&_svg]:text-working",
  )}
  data-testid="sidebar-update-ready"
>
  <RefreshCw aria-hidden="true" className="size-icon-lg shrink-0" />
  <span className="min-w-0 flex-1">
    <span className="block truncate tracking-tight">{t("shell.restartToUpdate")}</span>
    {status.version && (
      <span className="block truncate text-caption font-normal">
        {t("shell.versionReady", { version: status.version })}
      </span>
    )}
  </span>
</button>
```

Retain the existing accessible label, install handler, `tabIndex`, and `type`. Delete the right-side dot.

- [ ] **Step 5: Run the Sidebar tests and verify they pass**

Run:

```bash
cd frontend
npx vitest run --config vite.renderer.config.ts src/renderer/components/Sidebar.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the visual refresh**

```bash
git add frontend/src/renderer/components/Sidebar.tsx frontend/src/renderer/components/Sidebar.test.tsx
git commit -m "fix(updates): match sidebar update status designs"
```

### Task 3: Verify behavior and relaunch the desktop demo

**Files:**
- Verify: `frontend/src/renderer/components/Sidebar.tsx`
- Verify: `frontend/src/renderer/hooks/useSidebarUpdateDismissal.ts`

- [ ] **Step 1: Run the focused updater suite**

Run:

```bash
cd frontend
npx vitest run --config vite.renderer.config.ts \
  src/renderer/components/Sidebar.test.tsx \
  src/renderer/hooks/useSidebarUpdateDismissal.test.ts \
  src/main/auto-updater.test.ts
```

Expected: all focused tests PASS.

- [ ] **Step 2: Run frontend typecheck**

Run:

```bash
cd frontend
npm run typecheck
```

Expected: exit code 0.

- [ ] **Step 3: Relaunch the isolated desktop preview**

Sync the two changed renderer files into the isolated demo worktree, preserve its demo-only updater status/profile overrides, and run:

```bash
cd /Users/psudokit/.ao/sidebar-update-demo-source/frontend
AO_DATA_DIR=/Users/psudokit/.ao/sidebar-update-demo-data \
AO_DEMO_USER_DATA_DIR=/Users/psudokit/.ao/sidebar-update-demo-data/electron \
AO_DEMO_UPDATE_VERSION=0.11.1 \
npx electron-forge start
```

Expected: the app opens with the available two-line updater row, a plain ×, and no right-side dot.
