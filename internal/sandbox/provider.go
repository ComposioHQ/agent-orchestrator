package sandbox

import (
	"context"
	"errors"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
)

// ErrNotFound indicates that a provider environment does not exist. It is the
// only error the reconciler accepts as proof that an environment is gone; every
// other failure leaves observed reality untouched.
var ErrNotFound = errors.New("sandbox environment not found")

// ErrAtCapacity indicates the provider rejected a create because the account
// has hit its concurrent-sandbox quota. A provider wraps it (so errors.Is finds
// it) whenever it can tell a rejection apart from a permanent failure. The
// reconciler treats it as a transient wait, not a failed session: the sandbox
// stays desired-running and is retried on a later tick, so a session at the
// ceiling queues for a freed slot instead of dying.
var ErrAtCapacity = errors.New("sandbox provider at capacity")

// ID uniquely identifies a provider sandbox.
type ID string

// Spec describes a sandbox to create.
type Spec struct {
	Name              string
	SessionID         string
	OrgID             string
	ResourceProfile   domain.ResourceProfile
	Shape             string
	RootFS            string
	Ingress           string
	Environment       map[string]string
	Labels            map[string]string
	AutoDeleteMinutes int
	// AutoPauseSeconds asks the provider to pause the sandbox after this many
	// seconds with no activity. Pausing an idle sandbox stops its compute
	// billing and frees the account's concurrency slot while preserving state,
	// so a worker suspended here resumes in place. Zero leaves the sandbox
	// running until AO or the user stops it explicitly.
	AutoPauseSeconds int
}

// Environment is the provider-neutral view of a sandbox. State is always one of
// the AO vocabulary values the reconciler switches on, never a provider string.
type Environment struct {
	ID       ID
	Name     string
	State    string
	Target   string
	Resource domain.ResourceProfile
}

// WorkerBootstrap contains the worker executable and launch environment.
type WorkerBootstrap struct {
	Binary      []byte
	Destination string
	Environment map[string]string
}

// Bootstrapper installs and starts an AO worker in an existing sandbox.
// Providers implement it when they expose an authenticated exec/file API,
// which lets the reconciler repair a live sandbox instead of replacing it.
type Bootstrapper interface {
	BootstrapWorker(context.Context, ID, WorkerBootstrap) error
}

// Recreator re-establishes compute with a fresh worker launch.
type Recreator interface {
	Recreate(context.Context, ID, Spec) (Environment, error)
}

// Provider manages the lifecycle of cloud sandbox environments.
type Provider interface {
	Create(context.Context, Spec) (Environment, error)
	Get(context.Context, ID) (Environment, error)
	FindBySession(context.Context, string) (Environment, bool, error)
	Start(context.Context, ID) error
	Stop(context.Context, ID) error
	Pause(context.Context, ID) error
	Resume(context.Context, ID) error
	Delete(context.Context, ID) error
}

// Provider-neutral environment states. Every provider maps its own vocabulary
// onto these; anything unrecognized must become StateProvisioning, never
// StateRunning, because reporting a sandbox as running before its worker has
// checked in suppresses the startup deadline.
const (
	StateProvisioning = "provisioning"
	StateRunning      = "running"
	StateStopped      = "stopped"
	StatePaused       = "paused"
	StateDeleting     = "deleting"
	StateDeleted      = "deleted"
)
