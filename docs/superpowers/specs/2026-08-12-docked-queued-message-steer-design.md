# Docked queued-message steering

## Goal

Make every queued chat prompt visible and actionable while an agent turn is running. Match the supplied reference by presenting queued prompts as compact cards immediately above the composer, independent of timeline scroll position.

## UI behavior

- Render a docked queue list between the live-turn status bar and the composer.
- Each queued prompt is a compact horizontal card containing its text and a `Steer` action.
- `Steer` promotes only that queued turn into the currently running provider turn.
- While promotion is pending, disable that card's action and label it `Steering…`.
- If promotion fails, keep the card queued and show a concise inline error on that card.
- Preserve queue order and support multiple queued cards.
- Keep the existing queued message in the timeline for conversation chronology, but do not render a second steering action there.
- Continue showing the dock after conversation branching.
- Keep `Stop and clear queue` behavior unchanged.
- Do not add delete or overflow actions until corresponding non-destructive queue APIs exist.

## Data flow

`ChatWorkspace` derives queued turns and their human messages from the existing conversation snapshot. It passes each card's turn ID to the existing `onPromoteQueuedTurn` callback. No API or storage changes are required.

The dock is shown only when:

- a provider turn is currently `running`;
- at least one separate turn is `queued`; and
- a matching human message is present in the snapshot.

If steering is unsupported by the harness, cards remain visible as queued prompts but do not show the `Steer` action.

## Testing

Add renderer tests proving that:

- one and multiple queued prompts render in the dock;
- the correct queued turn ID is promoted;
- the dock remains visible when `branchedFromEarlierMessage` is true;
- pending and failure states are scoped to the selected card;
- no duplicate timeline `Steer` action is rendered;
- settled conversations do not render the dock.

Run the focused renderer suite, frontend typecheck, and manually verify the Electron UI with a Claude Code chat session.
