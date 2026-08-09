# Session Topbar Separator and Interface Toggle Design

## Scope

Make two focused presentation changes on session pages without changing terminal tabs, notification behavior, inspector state, interface-transition semantics, or backend APIs:

1. Place the utility separator between Notifications and the right-inspector toggle when a worker inspector is collapsed.
2. Replace the idle interface switcher's visible text with a compact target-specific icon.

## Topbar ordering

Worker sessions with a collapsed inspector use this trailing order:

`Kill → Orchestrator → Notifications → separator → Open inspector`

The separator is not rendered between Orchestrator and Notifications in that state. When the worker inspector is open, its existing panel boundary separates the center actions from the inspector header, so the center action group does not add a replacement separator after Notifications.

Existing non-worker ordering remains unchanged:

- Orchestrator session: `Task → Open Kanban → separator → Notifications`
- Kanban board: `Task → Orchestrator → separator → Notifications`

This is implemented only by making the current separator conditions explicit in `ShellTopbar`; notification and inspector components remain unchanged.

## Interface switch control

The idle interface switcher remains one button with the existing click behavior, disabled states, pending spinner, target-aware accessible name, and explanatory hover text. Its visible text is removed.

The icon communicates the destination:

- Switching to Chat UI uses a chat-bubble icon.
- Switching to Terminal UI uses a terminal-prompt icon.
- A pending switch continues to use the spinner.

The button uses the existing compact ghost-control styling. The full `Switch to chat UI` or `Switch to terminal UI` wording remains available through the accessible label and tooltip/title, so removing visible text does not remove the explanation for keyboard, screen-reader, or hover users.

Active transitions are outside this visual compaction. Their progress text and Cancel action remain visible because they communicate long-running state and recovery options.

## Data and behavior boundaries

No state or data flow changes are required. `SessionView` continues selecting the target interface and providing the transition callbacks. `SessionInterfaceSwitchButton` only chooses the target icon when it renders its idle state. Errors, busy-session policy dialogs, cancellation, and transition notices keep their current behavior.

## Testing

Add focused regression coverage that proves:

- A collapsed worker inspector renders exactly one separator after Notifications and before Open inspector.
- The worker separator is no longer between Orchestrator and Notifications.
- Orchestrator and board separator ordering remains intact.
- The idle switch button has no visible label text, keeps its target-aware accessible name and explanatory title, and renders a destination icon.
- Chat and terminal targets use different icons.
- Pending and active-transition behavior remains unchanged.

Run the focused component suites first, followed by frontend typecheck and the full frontend test suite before updating the draft PR.
