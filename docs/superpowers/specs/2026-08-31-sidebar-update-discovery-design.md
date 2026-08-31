# Sidebar Update Discovery Design

## Goal

Make desktop update discovery independent of automatic downloading. AO must
check the user's selected release channel even when Automatic Updates is off,
surface every newer matching release in the sidebar, and let the user dismiss
an available release for 24 hours.

## User-visible behavior

- AO checks for updates at launch and on the existing periodic cadence.
- Stable (`latest`) users check only the stable feed. Nightly users check only
  the nightly feed. Existing feature-release pin behavior is unchanged.
- Automatic Updates controls downloading, not discovery:
  - when enabled, a discovered release downloads automatically and the sidebar
    advances through download progress to **Restart to update**;
  - when disabled, a discovered release remains as an actionable **Update
    available** sidebar row until the user clicks it.
- The expanded **Update available** row includes a separate dismiss (×) action.
  Dismissing does not download or reject the release; it only hides that exact
  version from the sidebar for 24 hours.
- A dismissed version returns after exactly 24 hours if it remains the newest
  matching release. A different version appears immediately, even during the
  prior version's dismissal window.
- Downloading and **Restart to update** states cannot be dismissed because the
  update is already in progress or staged.
- The collapsed icon rail continues to expose the update action. Temporary
  dismissal is offered from the expanded row, where the × action can be shown
  without creating an ambiguous icon-only control.

## Architecture and data flow

### Main-process updater policy

`frontend/src/main/auto-updater.ts` continues to own feed selection, updater
serialization, and periodic scheduling. The launch-time/background check no
longer exits or removes its timer when `UpdateSettings.enabled` is false.
Instead it always configures the selected feed and calls
`autoUpdater.checkForUpdates()`.

Before each background check, `autoUpdater.autoDownload` is set from
`settings.enabled`. This preserves the existing Automatic Updates preference:
enabled checks download automatically; disabled checks stop at the existing
`available` status, which is already broadcast to renderers and actionable in
the sidebar. The existing stable hourly and nightly 15-minute cadences remain
unchanged.

Settings writes always keep the periodic discovery timer scheduled. Changing
Stable/Nightly continues to run the existing immediate, serialized channel
check. Manual checks and feature-release transitions retain their current
request ownership and auto-progression rules.

### Sidebar dismissal

Dismissal is renderer-only presentation state because it must not suppress
updater checks, Settings status, downloading, telemetry, or installation. Store
one record in the existing Electron renderer local storage:

```ts
type DismissedSidebarUpdate = {
  version: string;
  dismissedUntil: number;
};
```

The storage key is scoped to AO update UI and the data remains below the
packaged app's pinned `~/.ao/electron` user-data directory. Version identity is
sufficient because stable, nightly, and feature versions are distinct release
versions; feature-release behavior is otherwise unchanged.

The sidebar compares an `available` status version with the stored record:

1. Different version: show immediately.
2. Same version before `dismissedUntil`: hide the expanded row and collapsed
   rail action.
3. Same version at or after `dismissedUntil`: clear the record and show again.

A timer for the remaining dismissal duration updates the mounted sidebar at
expiry, so the row returns without requiring a restart or a fresh updater
event. Invalid, incomplete, or unparseable stored data is ignored and removed.

The available row becomes a non-nested action group: the main button downloads
the update, while the adjacent × button dismisses it. This avoids invalid
button nesting and gives both controls independent accessible labels and focus
targets.

## Error handling

- Background-check errors continue through the existing consecutive-failure
  counters and sidebar retry guidance; disabling automatic downloads no longer
  disables those safety signals.
- A missing update version cannot be safely keyed for dismissal, so the × is
  omitted while the update action remains available.
- Local-storage failures must not hide an update. Reads fall back to visible;
  failed writes leave the row visible.
- Existing updater operation serialization prevents a scheduled check, channel
  switch, manual check, or download from racing another updater operation.

## Testing

Main-process regression tests will verify:

- Automatic Updates off still performs an immediate check and schedules the
  stable periodic cadence with `autoDownload = false`.
- Automatic Updates off on Nightly uses the nightly feed/cadence with
  `autoDownload = false`.
- Automatic Updates on retains automatic downloading.
- Toggling the preference no longer removes the discovery timer.

Sidebar tests will verify:

- the available row exposes independent download and dismiss controls;
- dismissing hides the same version for 24 hours;
- the same version returns at expiry without a new updater event;
- a newer version bypasses an active dismissal;
- malformed persisted dismissal data fails open;
- downloading and downloaded states remain visible and non-dismissible;
- the collapsed rail follows the same temporary visibility decision.

The focused updater/sidebar tests run first, followed by frontend typecheck and
the repository's relevant frontend test/build gates.

## Out of scope

- Changing stable/nightly release cadence or feed generation.
- Changing feature-release installation behavior.
- Adding daemon or backend API state for a renderer-only dismissal.
- Making downloaded/staged updates dismissible.
- Redesigning the Settings Updates section beyond the policy change described
  above.
