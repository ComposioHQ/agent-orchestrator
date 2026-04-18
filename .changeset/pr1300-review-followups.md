---
"@aoagents/ao-core": patch
"@aoagents/ao-cli": patch
"@aoagents/ao-web": patch
---

Tighten the session lifecycle review follow-ups by debouncing report-watcher reactions, restoring the shared Geist/JetBrains font setup, wiring recovery validation to real agent activity probes, adding direct coverage for `ao report`, activity-signal classification, and dashboard lifecycle audit panels, fixing the remaining lifecycle-state regressions around legacy merged-session rehydration and malformed canonical payload parsing, making agent-report metadata writes atomic, persisting canonical payloads for legacy sessions on read, stabilizing detecting evidence hashes, and removing the remaining inline-style cleanup debt from the session detail view. Follow-on fixes also split the Session Detail view into smaller components, harden PR URL parsing and wrapper capture for GitHub Enterprise and GitLab-style hosts, redact sensitive observability payload fields, bound on-disk audit logs, and align cleanup wording with the current merged-session lifecycle policy.
