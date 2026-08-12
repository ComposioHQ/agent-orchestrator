package domain

import (
	"encoding/json"
	"time"
)

// Desired sandbox states. These record user or control-plane intent and are the
// only states an API handler ever writes; the reconciler converges reality onto
// them and never edits them itself.
const (
	SandboxDesiredRunning = "running"
	SandboxDesiredStopped = "stopped"
	SandboxDesiredPaused  = "paused"
	SandboxDesiredDeleted = "deleted"
)

// Observed sandbox states. These record what the control plane last saw and are
// written only by the reconciler and by a worker heartbeat. A sandbox is
// `running` only once its worker has checked in: the provider's opinion that a
// machine booted is not evidence that the session is usable.
const (
	SandboxObservedRequested     = "requested"
	SandboxObservedProvisioning  = "provisioning"
	SandboxObservedBootstrapping = "bootstrapping"
	SandboxObservedReady         = "ready"
	SandboxObservedRunning       = "running"
	SandboxObservedStopping      = "stopping"
	SandboxObservedStopped       = "stopped"
	SandboxObservedDisconnected  = "disconnected"
	SandboxObservedFailed        = "failed"
	SandboxObservedDeleting      = "deleting"
	SandboxObservedDeleted       = "deleted"
)

// ResourceProfile is the compute a sandbox is asked for or reported to hold.
// Memory and Disk are gibibytes so a provider that speaks mebibytes converts at
// its own boundary rather than leaking its unit into the domain.
type ResourceProfile struct {
	CPU    int
	Memory int
	Disk   int
}

// Sandbox is the durable record of one session's compute: the intent, the last
// observation, and the provider handle that ties the two together.
type Sandbox struct {
	SessionID             string
	OrgID                 string
	Provider              string
	ProviderEnvironmentID string
	ProviderConnectionID  string
	DesiredState          string
	ObservedState         string
	ResourceProfile       json.RawMessage
	BootstrapContext      json.RawMessage
	AutoStopMinutes       int
	// WorkerLastSeenAt is nil until a worker has checked in at least once,
	// which is what distinguishes "never started" from "went silent" and
	// selects the startup deadline over the heartbeat deadline.
	WorkerLastSeenAt *time.Time
	LastError        string
	UpdatedAt        time.Time
}

// AccessTicket is a one-time, capability-scoped grant. Only its SHA-256 hash is
// stored; the plaintext is handed to a sandbox once and never persisted.
type AccessTicket struct {
	ID          string
	OrgID       string
	SessionID   string
	Purpose     string
	Scopes      []string
	WorkerEpoch int64
	ExpiresAt   time.Time
}

// WorkerLaunch is the durable session context a bootstrapped worker needs in
// order to clone the repository and start a harness.
type WorkerLaunch struct {
	OrgID         string
	SessionID     string
	ProjectID     string
	Kind          string
	Harness       string
	DisplayName   string
	Branch        string
	RepositoryURL string
	DefaultBranch string
}
