# AGY Modern Hooks Design

## Goal

Restore reliable AGY Kanban activity tracking against the current Antigravity CLI hook contract while keeping integration state workspace-local and preserving user customizations.

## Scope

The AGY adapter will migrate from the obsolete `.gemini/hooks.json` Gemini-style contract to the modern Antigravity workspace contract at `.agents/hooks.json`.

The adapter will report:

- `PreInvocation` as active, because the model is starting or continuing work.
- `PostToolUse` as active, because tool completion means the execution loop is still progressing.
- `Stop` as idle, because the current execution loop has reached an attention boundary.

Process exit remains derived from AO runtime facts rather than an AGY hook. Permission-wait or question states are intentionally excluded because AGY 1.1.13 does not document a lifecycle event that reliably distinguishes a real user decision from normal tool execution.

SCM-derived statuses such as In Review, CI Failed, Changes Requested, Ready to Merge, and Merged remain handled by AO's shared SCM observer and are outside this adapter change.

## Hook Configuration

AO will own one named hook entry inside `.agents/hooks.json`, using a stable name such as `agent-orchestrator`. Its shape will follow AGY's documented schema:

```json
{
  "agent-orchestrator": {
    "PreInvocation": [
      { "type": "command", "command": "ao hooks agy pre-invocation" }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "ao hooks agy post-tool-use" }
        ]
      }
    ],
    "Stop": [
      { "type": "command", "command": "ao hooks agy stop" }
    ]
  }
}
```

Installation will replace only AO's named entry, making upgrades idempotent. Other top-level named hooks and unknown fields will be preserved semantically as raw JSON values while the document itself is decoded and re-encoded. Uninstall will remove only AO's named entry and leave the rest of the file intact. If no entries remain, the file may remain as an empty JSON object to avoid deleting a path the user may manage externally.

The `.agents/hooks.json` path will be added to the workspace-local `.agents/.gitignore` using the existing hook utility. The obsolete `.gemini/hooks.json` path will not be written.

## Activity Mapping

`DeriveActivityState` will accept only the normalized modern subcommands:

- `pre-invocation` → `ActivityActive`
- `post-tool-use` → `ActivityActive`
- `stop` → `ActivityIdle`

Legacy event mappings will be removed so tests cannot accidentally validate a contract AGY no longer emits.

The adapter will advertise submit activity capability because `PreInvocation` provides an active signal after submitted work reaches the execution loop. It will continue to report no blocked-activity capability, preventing AO from sending unsafe Enter nudges when a permission dialog cannot be observed.

## Error Handling

- Missing or empty hook files are treated as empty configuration.
- Malformed JSON returns a descriptive installation error without overwriting the file.
- A non-object top-level document is rejected.
- Writes use the existing atomic file helper.
- Existing non-AO named hook entries are never deleted or overwritten.

## Testing

Regression tests will first demonstrate that the existing adapter writes the wrong path/schema and maps obsolete events. Implementation tests will then cover:

- Installation at `.agents/hooks.json` with the exact modern event structure.
- Absence of AO writes under `.gemini/hooks.json`.
- Idempotent reinstall.
- Preservation of user named hooks and unknown fields.
- AO-only uninstall behavior.
- Malformed JSON refusal.
- Modern activity mappings and rejection of legacy event names.
- Submit/blocked capability declarations.

The focused AGY adapter suite will run first, followed by activity dispatch, session-manager safety, and full backend tests where practical.

## Compatibility Decision

This change intentionally supports the current AGY contract only. Installing both legacy and modern files could create duplicate signals on transitional versions and would retain two incompatible configuration models. Users of obsolete AGY releases must upgrade to the repository-supported current CLI.
