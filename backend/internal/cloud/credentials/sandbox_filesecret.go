package credentials

import "github.com/aoagents/agent-orchestrator/backend/internal/sandboxruntime"

// Compile-time contract with worker 181. No adapter or secret copy is needed:
// its FileSecret writes atomically at 0600 and purges idempotently.
var _ SecretFileSink = (*sandboxruntime.FileSecret)(nil)
