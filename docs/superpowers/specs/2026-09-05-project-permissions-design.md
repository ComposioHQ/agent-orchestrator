# Project permission defaults

Approved in conversation: new worker and orchestrator sessions use Auto when no explicit project, role, or spawn preference exists. Existing sessions retain their settings. Both chat composers expose permissions, including before the first message. An explicit “Remember for this project” action saves the confirmed current mode for future sessions; selecting a session mode alone does not change project defaults.

Persist through the daemon in the existing project agent configuration. A focused permissions mutation preserves unrelated settings and removes permission-only role overrides so both roles inherit the remembered selection. Provider choices carry a daemon-supplied canonical permission mode when they have an exact supported mapping. Unmapped provider modes cannot be remembered as a different policy. Errors remain visible and retryable.

Scope excludes project token analytics, unrelated UI edits, and automatic changes to already running sessions. Validate inheritance and explicit overrides, persistence boundaries, unsupported provider choices, pending/error states, and empty orchestrator composers.

Codex calls its adapter default “Full access.” When remembering that choice, the daemon stores the portable `bypass-permissions` mode, so a future Claude session also receives full access. Other default selections retain their provider semantics. Existing sessions keep their current mode.
