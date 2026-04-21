---
"@aoagents/ao-core": minor
---

Add centralized lifecycle transitions and report watcher for agent monitoring.

- **Lifecycle transitions (#137)**: Centralize all lifecycle state mutations through `applyLifecycleDecision()` for consistent timestamp handling, atomic metadata persistence, and observability.
- **Detecting bounds (#138)**: Add time-based (5 min) and attempt-based (3 attempts) bounds to detecting state with evidence hashing to prevent counter reset on unchanged probe results.
- **Report watcher (#140)**: Background trigger system that audits agent reports for anomalies (no_acknowledge, stale_report, agent_needs_input) and integrates with the reaction engine.

New exports:
- `applyLifecycleDecision`, `applyDecisionToLifecycle`, `buildTransitionMetadataPatch`, `createStateTransitionDecision`
- `DETECTING_MAX_ATTEMPTS`, `DETECTING_MAX_DURATION_MS`, `hashEvidence`, `isDetectingTimedOut`
- `auditAgentReports`, `checkAcknowledgeTimeout`, `checkStaleReport`, `checkBlockedAgent`, `shouldAuditSession`, `getReactionKeyForTrigger`, `DEFAULT_REPORT_WATCHER_CONFIG`, `REPORT_WATCHER_METADATA_KEYS`
