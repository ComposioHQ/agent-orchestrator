# Draft persistence split: review evidence

Original PR: https://github.com/Untrivial-ai/agent-orchestrator/pull/4463

The five numbered feature slices are text persistence, staged attachments, queued edit receipts, inline edit receipts, and steer receipt recovery. The xterm disposal fix is a prerequisite. Each feature folder contains a successful Chromium renderer recording, screenshot, run log, and recorded contract requests. These use the production renderer with deterministic daemon/preload/PTY fixtures; the recordings do not establish a live provider delivery.

The native folder is a separate real Electron Forge build of the cumulative final stack, with its real Go daemon and native preload, isolated data/profile under `~/.ao/dev/pr4463-split`, and a real Codex scratch session. Screenshots verify text, actual daemon-staged image descriptors, inline edits, accepted draft clearing, and a native terminal. Native assertions reported no page exceptions. It is a development build, not the signed packaged-app gate.

`receipt-restart-tests.txt` is real Go service/SQLite evidence: uncertain steer and inline delivery reservations survive retries/controller restarts without repeating provider actions. Provider behavior in those tests is an injected fake counted at the service boundary.

Captures contain isolated QA data and exclude credentials. QA captures are kept on this evidence branch so they do not inflate the six implementation diffs. Full validation results and PR links will be added as final checks complete.
