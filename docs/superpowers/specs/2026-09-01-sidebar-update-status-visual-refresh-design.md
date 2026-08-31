# Sidebar Update Status Visual Refresh

## Goal

Restyle the expanded sidebar updater so its four visible states match the supplied AO references. Remove the right-side status dot from every state while preserving the updater behavior already implemented on this branch.

## Visual contract

### Update available

- Show the download icon on the left.
- Show `Update available` as the primary line and the full version as a secondary line when a version exists.
- Make the content area download the update when clicked.
- Keep a plain × action at the far right that dismisses only the current version for 24 hours.
- Do not give the × its own filled square and do not show a status dot.

### Downloading

- Show the download icon followed by `Downloading… {percent}%` on one line.
- Use the standard sidebar surface without a bordered or tinted card.
- Do not show a status dot or dismissal action.

### Restart to update

- Show a blue-tinted, blue-bordered rounded card with the refresh icon on the left.
- Show `Restart to update` as the primary line and the available version as a secondary truncated line.
- The whole card installs the staged update when clicked.
- Do not show a status dot or dismissal action.
- Preserve the existing escalated-state semantic color where applicable, but never reintroduce a dot.

### Update check failed

- Show an orange-tinted, orange-bordered rounded card with the warning icon on the left.
- Show `Update check failed` as the primary line and `Retry update check` as the secondary line.
- The whole card retries the check when clicked.
- Do not show a status dot or dismissal action.

## Collapsed sidebar

Keep the existing icon-rail interactions and tooltips. The request applies to the expanded status component shown in the references; no dots are present in the rail today.

## Accessibility and behavior

- Retain the existing accessible labels for download, dismiss, retry, and install.
- Keep download progress announced as a polite live status.
- Keep downloading and staged updates non-dismissible.
- Preserve Stable/Nightly discovery and 24-hour version dismissal behavior unchanged.

## Verification

- Update sidebar tests to assert the visible version line and absence of status-dot elements.
- Verify available, downloading, downloaded, escalated, and failed states.
- Run the focused Sidebar tests, updater dismissal tests, and frontend typecheck.
- Relaunch the isolated desktop demo with an available update so the revised row can be inspected visually.
