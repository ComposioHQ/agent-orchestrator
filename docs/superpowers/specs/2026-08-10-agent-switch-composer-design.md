# Agent Switch Composer Design

Date: 2026-08-10

## Outcome

Agent switching should feel like creating a task: the user enters an optional note, chooses the target agent and model in one compact composer, then starts the switch. After admission, the full-window modal disappears and progress continues in a card over the blurred agent terminal only.

The selected model is functional for both a fresh target session and a resumed provider-native session.

## Configuration dialog

- Use the same Radix modal overlay, `w-dialog-xl` frame, title treatment, composer surface, segmented run controls, button sizing, spacing, and entry/exit motion as `NewTaskDialog` and `TaskComposer`.
- Keep the full application dimmed and blurred while the configuration dialog is open.
- Show `Switch agent` as the title and a small, muted, live `Source agent → Target agent` line below it.
- Use the main composer textarea for the optional handoff note. It is capped at 4,096 characters and has no resize handle.
- Reuse the New task agent/model control presentation:
  - the first segment selects a target agent;
  - the current agent is visible but disabled;
  - Claude Code and Codex are enabled;
  - unsupported agents remain disabled and marked as coming soon;
  - the second segment uses AO's existing target-agent model catalog;
  - changing the target agent clears the previous target's model selection and resolves the new target's default.
- `Use <agent>'s default` sends no model override.
- Replace New task's attachment and primary actions with `Cancel` and `Switch` buttons.
- Remove switch history from this dialog.
- Keep admission errors inside the composer without closing it.
- While admission is pending, disable the note, selectors, Cancel, close affordance, and Switch action. This avoids representing an accepted durable operation as cancelable.

## Progress presentation

When the daemon accepts the switch with `202 Accepted`:

1. Close the configuration dialog and remove its full-window overlay.
2. Keep navigation, the sidebar, inspector, and auxiliary shells usable.
3. Lock and blur only the affected agent terminal.
4. Center a bordered transition card inside that terminal overlay.
5. Put the source avatar, animated transfer line with a static arrowhead, target avatar, current title, description, and four-stage progress track inside the card.
6. Preserve reduced-motion behavior by replacing movement and blinking with static emphasis.

Permission-required, completed, failed, and recovery states continue to use their existing truthful terminal-scoped behavior. They adopt the same card surface where applicable; this change does not add cancellation or retry semantics.

## Functional model selection

Extend the switch request with an optional `model` string limited to 256 characters, matching task creation.

- Normalize the value with surrounding whitespace removed.
- Include the normalized model in the request fingerprint so an idempotency key cannot be replayed with a different model choice.
- Carry the override through the service and session-manager command.
- Merge it over the effective project/worker agent configuration only for this target activation.
- Pass the resulting configuration to both `GetLaunchCommand` and `GetRestoreCommand`.
- An empty model preserves the target provider's configured/default behavior.
- Do not persist a display phase or duplicate model catalog data. The existing durable switch saga remains the source of progress truth.
- No SQLite migration is required: the accepted process-local worker owns the request configuration, and existing startup reconciliation handles daemon interruption rather than replaying the unfinished launch request.

## Component boundaries

- Extract the reusable model picker and compact agent/model control styling from `TaskComposer` instead of duplicating it.
- Keep task creation behavior inside `TaskComposer`.
- Keep switch-specific target restrictions, note handling, request submission, and durable-state rendering inside `SwitchAgentDialog` and the existing switch hooks.
- Keep terminal-only progress rendering inside `CenterPane`; do not move switch lifecycle logic into React.
- Keep API validation and launch configuration resolution in the Go daemon.

## Error and accessibility behavior

- Invalid or oversized model values are rejected before durable admission using the existing API error envelope.
- Model catalog failures leave the provider selection usable and show the existing catalog warning/fallback behavior.
- The dialog retains an accessible title and description, labelled agent/model controls, keyboard submission, focus trapping, and Escape behavior before submission.
- The terminal progress card remains one polite atomic status region. Permission, failure, and recovery states use alerts only when user attention is required.
- Background blur and transfer animation honor reduced-motion and do not carry meaning by motion or color alone.

## Verification

- Component tests cover composer parity, removal of history, target/model resetting, default-model omission, selected-model submission, admission locking, and error retention.
- API/service/session-manager tests cover model validation, normalization, fingerprint mismatch, fresh launch, and native-session resume.
- Generated OpenAPI and frontend schema artifacts are updated together.
- Native Electron verification covers both Claude Code to Codex and Codex to Claude Code: open dialog, select model, cancel before admission, start switch, observe full-window blur ending after acceptance, and observe terminal-only transition progress.

## Non-goals

- Supporting target agents beyond Claude Code and Codex.
- Canceling an accepted switch.
- Changing handoff construction, transcript fallback, durable switch states, recovery policy, or provider-native session retention.
- Adding switch history elsewhere in the UI.
- Redesigning New task itself.
