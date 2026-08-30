package ports

import (
	"context"
	"io"
	"time"
)

// ExecutableFinder resolves command names against the host PATH. Core
// services depend on this port rather than importing os/exec directly.
type ExecutableFinder interface {
	LookPath(file string) (string, error)
}

// CommandRunner executes an already-resolved argv and streams output to the
// supplied writers. Callers are responsible for constraining argv to a safe
// allowlist before it reaches this boundary.
type CommandRunner interface {
	Run(ctx context.Context, argv []string, stdout, stderr io.Writer) error
}

// AgentInstallJobRecord is the storage-bound representation of a daemon-owned
// harness installation job. Strings keep the persistence adapter independent
// of the systeminstall package's domain types.
type AgentInstallJobRecord struct {
	Target              string
	Status              string
	Method              string
	Command             string
	ExpectedDestination string
	Output              string
	Error               string
	StartedAt           time.Time
	FinishedAt          *time.Time
	UpdatedAt           time.Time
}

// AgentInstallJobStore persists the latest harness installation job per
// target so Settings can recover it after remounts and daemon restarts.
type AgentInstallJobStore interface {
	UpsertAgentInstallJob(ctx context.Context, job AgentInstallJobRecord) error
	GetAgentInstallJob(ctx context.Context, target string) (AgentInstallJobRecord, bool, error)
	ListAgentInstallJobs(ctx context.Context) ([]AgentInstallJobRecord, error)
	InterruptActiveAgentInstallJobs(ctx context.Context, interruptedAt time.Time) error
}
