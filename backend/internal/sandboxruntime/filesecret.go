package sandboxruntime

import "github.com/aoagents/agent-orchestrator/backend/internal/secretfile"

// FileSecret is the sandbox-facing alias of the neutral secretfile Sink.
type FileSecret = secretfile.Sink

// NewFileSecret constructs the neutral owner-only secret file sink.
func NewFileSecret(root string) (*FileSecret, error) {
	return secretfile.NewSink(root)
}
