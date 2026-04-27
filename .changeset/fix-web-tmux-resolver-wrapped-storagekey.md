---
"@aoagents/ao-web": patch
---

Fix DirectTerminal "can't find session" when the project uses a wrapped storageKey. `ao-core` names tmux sessions as `{storageKey}-{sessionId}`, where `storageKey` can be either a bare 12-char hash or the legacy wrapped form `{hash}-{projectName}` (e.g. `361287ebbad1-smx-foundation`). The web resolver only handled the bare-hash form, so lookups for sessions like `sf-orchestrator-1` against the tmux name `361287ebbad1-smx-foundation-sf-orchestrator-1` always returned `null` and the terminal never attached (#1486).

The resolver now looks up the owning storageKey on disk (from the session record at `~/.agent-orchestrator/{storageKey}/sessions/{sessionId}`) and asks tmux for the exact `{storageKey}-{sessionId}` name. The on-disk record is the authoritative disambiguator, so sessions whose IDs happen to be suffixes of other session IDs (e.g. looking up `app-1` while `my-app-1` exists in the same project) cannot be falsely matched. If the on-disk record is missing, the resolver still recovers bare-hash sessions via the tmux session listing as a fallback.
