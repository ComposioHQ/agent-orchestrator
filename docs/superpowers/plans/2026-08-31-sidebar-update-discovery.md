# Sidebar Update Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Always discover updates from the user's selected Stable or Nightly channel, preserve Automatic Updates as the auto-download preference, and let users dismiss an available sidebar update for 24 hours.

**Architecture:** Keep feed selection, serialized checks, and download policy in Electron's main-process updater. Make periodic discovery unconditional while deriving `autoUpdater.autoDownload` from the existing `enabled` preference. Keep the 24-hour dismissal in a focused renderer hook backed by Electron local storage, then use that hook to gate both expanded and collapsed sidebar affordances without suppressing updater state or telemetry.

**Tech Stack:** Electron, TypeScript, React 19, Vitest, Testing Library, i18next, electron-updater.

---

## File structure

- Modify `frontend/src/main/auto-updater.ts` — separate periodic discovery from automatic downloading.
- Modify `frontend/src/main/auto-updater.test.ts` — regression coverage for disabled Stable/Nightly discovery and runtime preference changes.
- Create `frontend/src/renderer/hooks/useSidebarUpdateDismissal.ts` — parse, persist, expire, and apply one version-scoped dismissal.
- Create `frontend/src/renderer/hooks/useSidebarUpdateDismissal.test.tsx` — deterministic storage and 24-hour timer tests.
- Modify `frontend/src/renderer/components/Sidebar.tsx` — connect dismissal state to expanded/rail update affordances and add the × control.
- Modify `frontend/src/renderer/components/Sidebar.test.tsx` — integrated download/dismiss behavior and non-dismissible progress/staged states.
- Modify `frontend/src/renderer/i18n/{de,en,es,fr,ja,ko,pt-BR,zh-CN}.json` — accessible dismiss label in every supported locale.

### Task 1: Make update discovery independent of automatic downloading

**Files:**
- Modify: `frontend/src/main/auto-updater.test.ts:197-442,1580-1656`
- Modify: `frontend/src/main/auto-updater.ts:765-905`

- [ ] **Step 1: Replace the disabled-updater regression with failing Stable and Nightly discovery tests**

Replace the test that expects no check while disabled with these tests:

```ts
it("checks stable on launch and hourly when automatic downloads are disabled", async () => {
  vi.useFakeTimers();
  const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
  const { module, autoUpdater } = await importAutoUpdater({
    enabled: false,
    channel: "latest",
    nightlyAck: false,
    feature: null,
  });

  await module.startAutoUpdates(stateDir);

  expect(autoUpdater.autoDownload).toBe(false);
  expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  const { delay } = latestInterval(setIntervalSpy);
  expect(delay).toBe(60 * 60 * 1000);
  await vi.advanceTimersByTimeAsync(delay);
  expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
});

it("checks nightly every 15 minutes when automatic downloads are disabled", async () => {
  vi.useFakeTimers();
  const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
  const { module, autoUpdater } = await importAutoUpdater({
    enabled: false,
    channel: "nightly",
    nightlyAck: true,
    feature: null,
  });

  await module.startAutoUpdates(stateDir);

  expect(autoUpdater.channel).toBe("nightly");
  expect(autoUpdater.allowPrerelease).toBe(true);
  expect(autoUpdater.autoDownload).toBe(false);
  expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  expect(latestInterval(setIntervalSpy).delay).toBe(15 * 60 * 1000);
});
```

Update the runtime-settings test so disabling automatic downloads keeps the timer and later checks alive:

```ts
await module.setUpdateSettings(stateDir, { ...current, enabled: false });
expect(latestInterval(setIntervalSpy).delay).toBe(15 * 60 * 1000);
await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
expect(autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
expect(autoUpdater.autoDownload).toBe(false);
```

- [ ] **Step 2: Run the focused tests and confirm the old policy fails**

Run:

```bash
cd frontend
npx vitest run src/main/auto-updater.test.ts
```

Expected: the new disabled Stable/Nightly tests fail because `checkForUpdates()` is skipped and no discovery timer is scheduled.

- [ ] **Step 3: Implement unconditional discovery with preference-controlled downloading**

Simplify `runAutomaticUpdateCheck` and scheduler reconciliation to this policy:

```ts
async function runAutomaticUpdateCheck(stateDir: string): Promise<number> {
  let nextIntervalMs =
    automaticUpdateTimerIntervalMs ?? STABLE_AUTOMATIC_UPDATE_CHECK_INTERVAL_MS;
  try {
    await runSerializedUpdaterOperation("automatic-check", async () => {
      const settings = await reconcileAndPersist(
        stateDir,
        await readUpdateSettings(stateDir),
      );
      nextIntervalMs = automaticUpdateCheckInterval(settings);
      escalationStateDir = stateDir;
      wireUpdaterEvents();
      configureFeed(settings);
      autoUpdater.autoDownload = settings.enabled;
      applyInstallOnQuitPolicy();
      const restoreFeed = usesDirectNightlyFeed(settings)
        ? await configureDirectNightlyFeed(settings)
        : undefined;
      try {
        const result = await autoUpdater.checkForUpdates();
        if (settings.enabled && result?.downloadPromise) {
          await result.downloadPromise;
        }
      } catch (err) {
        recordAutomaticCheckFailure(err);
        restoreAutomaticCheckPreviousStatus();
        publishFailingChecks();
        throw err;
      } finally {
        restoreFeed?.();
      }
    });
  } catch (err) {
    console.error("auto-update check failed:", err);
  }
  return nextIntervalMs;
}

function reconcileAutomaticUpdateSchedule(
  stateDir: string,
  settings: UpdateSettings,
): void {
  schedulePeriodicAutomaticUpdateCheck(
    stateDir,
    automaticUpdateCheckInterval(settings),
  );
}
```

Keep `startAutoUpdates` scheduling the returned interval, and update comments so `enabled` is described as auto-download rather than check opt-in.

- [ ] **Step 4: Run the updater tests**

Run:

```bash
cd frontend
npx vitest run src/main/auto-updater.test.ts
```

Expected: all updater tests pass, including disabled Stable/Nightly discovery, enabled auto-download, serialization, failure streaks, and runtime scheduling.

- [ ] **Step 5: Commit the updater-policy change**

```bash
git add frontend/src/main/auto-updater.ts frontend/src/main/auto-updater.test.ts
git commit -m "fix(updates): discover releases when auto-download is off"
```

### Task 2: Add version-scoped 24-hour sidebar dismissal

**Files:**
- Create: `frontend/src/renderer/hooks/useSidebarUpdateDismissal.ts`
- Create: `frontend/src/renderer/hooks/useSidebarUpdateDismissal.test.tsx`

- [ ] **Step 1: Write failing hook tests for persistence, expiry, and newer versions**

Create the test file with Testing Library's `renderHook` and fake timers:

```tsx
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIDEBAR_UPDATE_DISMISSAL_MS,
  SIDEBAR_UPDATE_DISMISSAL_STORAGE_KEY,
  useSidebarUpdateDismissal,
} from "./useSidebarUpdateDismissal";

describe("useSidebarUpdateDismissal", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T00:00:00Z"));
  });

  afterEach(() => vi.useRealTimers());

  it("hides the dismissed version and returns it after 24 hours", () => {
    const { result } = renderHook(() => useSidebarUpdateDismissal("9.9.9"));
    act(() => result.current.dismiss());
    expect(result.current.dismissed).toBe(true);
    expect(JSON.parse(localStorage.getItem(SIDEBAR_UPDATE_DISMISSAL_STORAGE_KEY)!)).toEqual({
      version: "9.9.9",
      dismissedUntil: Date.now() + SIDEBAR_UPDATE_DISMISSAL_MS,
    });

    act(() => vi.advanceTimersByTime(SIDEBAR_UPDATE_DISMISSAL_MS));
    expect(result.current.dismissed).toBe(false);
    expect(localStorage.getItem(SIDEBAR_UPDATE_DISMISSAL_STORAGE_KEY)).toBeNull();
  });

  it("shows a different version immediately", () => {
    const { result, rerender } = renderHook(
      ({ version }) => useSidebarUpdateDismissal(version),
      { initialProps: { version: "9.9.9" as string | undefined } },
    );
    act(() => result.current.dismiss());
    rerender({ version: "9.9.10" });
    expect(result.current.dismissed).toBe(false);
  });

  it("fails open for malformed storage", () => {
    localStorage.setItem(SIDEBAR_UPDATE_DISMISSAL_STORAGE_KEY, "not-json");
    const { result } = renderHook(() => useSidebarUpdateDismissal("9.9.9"));
    expect(result.current.dismissed).toBe(false);
    expect(localStorage.getItem(SIDEBAR_UPDATE_DISMISSAL_STORAGE_KEY)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the hook test and confirm the missing module fails**

Run:

```bash
cd frontend
npx vitest run src/renderer/hooks/useSidebarUpdateDismissal.test.tsx
```

Expected: FAIL because `useSidebarUpdateDismissal.ts` does not exist.

- [ ] **Step 3: Implement the focused dismissal hook**

Create `useSidebarUpdateDismissal.ts`:

```ts
import { useCallback, useEffect, useState } from "react";

export const SIDEBAR_UPDATE_DISMISSAL_STORAGE_KEY =
  "ao.sidebar.dismissed-update";
export const SIDEBAR_UPDATE_DISMISSAL_MS = 24 * 60 * 60 * 1000;

type DismissedSidebarUpdate = {
  version: string;
  dismissedUntil: number;
};

function readDismissal(): DismissedSidebarUpdate | null {
  try {
    const raw = localStorage.getItem(SIDEBAR_UPDATE_DISMISSAL_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<DismissedSidebarUpdate>;
    if (
      typeof value.version !== "string" ||
      value.version.length === 0 ||
      typeof value.dismissedUntil !== "number" ||
      !Number.isFinite(value.dismissedUntil)
    ) {
      localStorage.removeItem(SIDEBAR_UPDATE_DISMISSAL_STORAGE_KEY);
      return null;
    }
    return { version: value.version, dismissedUntil: value.dismissedUntil };
  } catch {
    try {
      localStorage.removeItem(SIDEBAR_UPDATE_DISMISSAL_STORAGE_KEY);
    } catch {}
    return null;
  }
}

export function useSidebarUpdateDismissal(version: string | undefined) {
  const [dismissal, setDismissal] = useState(readDismissal);
  const dismissed =
    version !== undefined &&
    dismissal?.version === version &&
    dismissal.dismissedUntil > Date.now();

  useEffect(() => {
    if (!dismissed || !dismissal) return;
    const timer = window.setTimeout(() => {
      try {
        localStorage.removeItem(SIDEBAR_UPDATE_DISMISSAL_STORAGE_KEY);
      } catch {}
      setDismissal(null);
    }, dismissal.dismissedUntil - Date.now());
    return () => window.clearTimeout(timer);
  }, [dismissal, dismissed]);

  const dismiss = useCallback(() => {
    if (!version) return;
    const next = {
      version,
      dismissedUntil: Date.now() + SIDEBAR_UPDATE_DISMISSAL_MS,
    };
    try {
      localStorage.setItem(
        SIDEBAR_UPDATE_DISMISSAL_STORAGE_KEY,
        JSON.stringify(next),
      );
      setDismissal(next);
    } catch {
      setDismissal(null);
    }
  }, [version]);

  return { dismissed, dismiss };
}
```

- [ ] **Step 4: Run the hook tests**

Run:

```bash
cd frontend
npx vitest run src/renderer/hooks/useSidebarUpdateDismissal.test.tsx
```

Expected: 3 tests pass with fake time and no network or wall-clock dependency.

- [ ] **Step 5: Commit the dismissal primitive**

```bash
git add frontend/src/renderer/hooks/useSidebarUpdateDismissal.ts frontend/src/renderer/hooks/useSidebarUpdateDismissal.test.tsx
git commit -m "feat(updates): persist temporary sidebar dismissals"
```

### Task 3: Add the accessible × action to the sidebar

**Files:**
- Modify: `frontend/src/renderer/components/Sidebar.tsx:408-430,889-923,2048-2179`
- Modify: `frontend/src/renderer/components/Sidebar.test.tsx:1973-2027`
- Modify: `frontend/src/renderer/i18n/de.json`
- Modify: `frontend/src/renderer/i18n/en.json`
- Modify: `frontend/src/renderer/i18n/es.json`
- Modify: `frontend/src/renderer/i18n/fr.json`
- Modify: `frontend/src/renderer/i18n/ja.json`
- Modify: `frontend/src/renderer/i18n/ko.json`
- Modify: `frontend/src/renderer/i18n/pt-BR.json`
- Modify: `frontend/src/renderer/i18n/zh-CN.json`

- [ ] **Step 1: Add failing Sidebar integration tests**

Extend the available-update test block:

```tsx
it("dismisses only the current available version", async () => {
  updateStatusMock.mockResolvedValue({ state: "available", version: "9.9.9" });
  const { unmount } = renderSidebar();

  await userEvent.click(await screen.findByRole("button", {
    name: "Hide update v9.9.9 for 24 hours",
  }));
  expect(screen.queryByText("Update available")).not.toBeInTheDocument();
  expect(downloadUpdateMock).not.toHaveBeenCalled();

  unmount();
  updateStatusMock.mockResolvedValue({ state: "available", version: "9.9.10" });
  renderSidebar();
  expect(await screen.findByText("Update available")).toBeInTheDocument();
});

it("does not offer dismissal for downloading or staged updates", async () => {
  updateStatusMock.mockResolvedValue({
    state: "downloading",
    version: "9.9.9",
    percent: 42,
  });
  const { unmount } = renderSidebar();
  await screen.findByText("Downloading… 42%");
  expect(screen.queryByLabelText(/Hide update/)).not.toBeInTheDocument();

  unmount();
  updateStatusMock.mockResolvedValue({
    state: "downloaded",
    version: "9.9.9",
    stagedAt: Date.now(),
  });
  renderSidebar();
  expect(await screen.findAllByLabelText("Restart to install update v9.9.9")).not.toHaveLength(0);
  expect(screen.queryByLabelText(/Hide update/)).not.toBeInTheDocument();
});
```

Clear `window.localStorage` in the existing `beforeEach` so dismissal tests do not leak into other sidebar tests.

- [ ] **Step 2: Run the Sidebar test and confirm the missing × action fails**

Run:

```bash
cd frontend
npx vitest run src/renderer/components/Sidebar.test.tsx
```

Expected: FAIL because the dismiss control and visibility gating are absent.

- [ ] **Step 3: Connect the hook and render independent actions**

Import `X` from `lucide-react` and `useSidebarUpdateDismissal`. In `Sidebar`, derive the version only for the available state:

```ts
const availableUpdateVersion =
  updateStatus.state === "available" ? updateStatus.version : undefined;
const updateDismissal = useSidebarUpdateDismissal(availableUpdateVersion);
```

Pass `availableDismissed={updateDismissal.dismissed}` to both `UpdateStatusRow`
and `UpdateStatusRail`, and pass `onDismissAvailable={updateDismissal.dismiss}`
to the expanded row. Update the expanded available branch to return `null` when
dismissed and otherwise render sibling controls:

```tsx
<div className="flex w-full items-center gap-1">
  <button
    aria-label={status.version
      ? t("shell.downloadUpdateVersion", { version: status.version })
      : t("shell.downloadUpdate")}
    className={cn(NAV_ROW_CLASS, "flex min-w-0 flex-1 items-center text-left [&_svg]:size-icon-md [&_svg]:shrink-0")}
    onClick={() => void aoBridge.updates.download()}
    tabIndex={tabIndex}
    type="button"
  >
    <Download aria-hidden="true" className="size-icon-lg shrink-0" />
    <span className="min-w-0 flex-1 truncate tracking-tight">{t("shell.updateAvailable")}</span>
    {status.version && <span className="sr-only">{t("shell.versionAvailable", { version: status.version })}</span>}
    <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-red-500" />
  </button>
  {status.version && (
    <button
      aria-label={t("shell.dismissUpdateVersion", { version: status.version })}
      className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground"
      onClick={onDismissAvailable}
      tabIndex={tabIndex}
      type="button"
    >
      <X aria-hidden="true" className="size-icon-base" />
    </button>
  )}
</div>
```

Return `null` from the rail's available branch when `availableDismissed` is
true. Do not add dismissal to downloading, downloaded, or failing-check states.

- [ ] **Step 4: Add the accessible label to every locale**

Add `shell.dismissUpdateVersion` next to the existing update strings:

```json
// en
"shell.dismissUpdateVersion": "Hide update v{{version}} for 24 hours"
// de
"shell.dismissUpdateVersion": "Update v{{version}} für 24 Stunden ausblenden"
// es
"shell.dismissUpdateVersion": "Ocultar la actualización v{{version}} durante 24 horas"
// fr
"shell.dismissUpdateVersion": "Masquer la mise à jour v{{version}} pendant 24 heures"
// ja
"shell.dismissUpdateVersion": "アップデート v{{version}} を24時間非表示にする"
// ko
"shell.dismissUpdateVersion": "업데이트 v{{version}}을 24시간 숨기기"
// pt-BR
"shell.dismissUpdateVersion": "Ocultar a atualização v{{version}} por 24 horas"
// zh-CN
"shell.dismissUpdateVersion": "将更新 v{{version}} 隐藏 24 小时"
```

- [ ] **Step 5: Run Sidebar and i18n coverage tests**

Run:

```bash
cd frontend
npx vitest run src/renderer/components/Sidebar.test.tsx src/renderer/i18n/renderer-coverage.test.ts
```

Expected: all tests pass; the available update has separate download/dismiss controls, while progress and staged states remain mandatory.

- [ ] **Step 6: Commit the sidebar integration**

```bash
git add frontend/src/renderer/components/Sidebar.tsx frontend/src/renderer/components/Sidebar.test.tsx frontend/src/renderer/i18n/*.json
git commit -m "feat(updates): let users snooze sidebar updates"
```

### Task 4: Verify the complete behavior

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run the complete focused regression suite**

```bash
cd frontend
npx vitest run src/main/auto-updater.test.ts src/renderer/hooks/useSidebarUpdateDismissal.test.tsx src/renderer/components/Sidebar.test.tsx src/renderer/i18n/renderer-coverage.test.ts
```

Expected: all focused tests pass with zero failures.

- [ ] **Step 2: Run frontend typecheck**

```bash
cd frontend
npm run typecheck
```

Expected: exit 0 with no TypeScript errors.

- [ ] **Step 3: Run the production frontend build**

```bash
cd frontend
npm run build
```

Expected: exit 0 and Electron/renderer bundles are produced successfully.

- [ ] **Step 4: Inspect the final diff and working tree**

```bash
git diff origin/main...HEAD --check
git diff origin/main...HEAD --stat
git status --short --branch
```

Expected: no whitespace errors; only the approved design/plan and updater/sidebar files are changed; the branch is clean after commits.

- [ ] **Step 5: Commit any verification-only corrections separately**

If verification required a source correction, stage only the corrected updater/sidebar files and commit with a focused conventional message. If no correction was required, do not create an empty commit.
