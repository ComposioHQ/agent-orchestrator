package runtime

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// ErrSandboxNotFound is what a Provider returns when the named sandbox does
// not exist. Delete treats it as success and the reconciler treats it as
// evidence that a row is stale, so adapters must return it rather than a
// generic transport error for a 404.
var ErrSandboxNotFound = errors.New("provider sandbox not found")

// ProviderState is the coarse lifecycle position a provider reports. Adapters
// normalize whatever vocabulary their API uses into these four values; the
// control plane never branches on a vendor-specific string.
type ProviderState string

const (
	// ProviderStarting means the sandbox is being created or booted.
	ProviderStarting ProviderState = "starting"
	// ProviderRunning means the sandbox is executing.
	ProviderRunning ProviderState = "running"
	// ProviderStopped means the sandbox exists but is not executing.
	ProviderStopped ProviderState = "stopped"
	// ProviderError means the provider considers the sandbox broken.
	ProviderError ProviderState = "error"
)

// Sandbox is one provider-side compute unit as the adapter observed it.
type Sandbox struct {
	ID     string
	State  ProviderState
	Labels map[string]string
	// CreatedAt is the provider's creation timestamp. The reconciler uses it
	// for grace periods, so an adapter that cannot supply it must leave it zero
	// rather than substituting "now" (which would make every leak look fresh
	// and permanently un-reapable).
	CreatedAt time.Time
	// LastActivityAt is the provider's own idleness signal when it has one.
	// Zero means "unknown"; idle reaping then relies on control-plane
	// heartbeats alone.
	LastActivityAt time.Time
	// Error is the provider's last failure message, if any.
	Error string
}

// Attribution reads the AO labels off a provider sandbox.
func (s Sandbox) Attribution() (Attribution, bool) { return Attribute(s.Labels) }

// CreateRequest is everything the provider needs to build one sandbox.
//
// Secrets travel in Env and SecretFiles only. There is deliberately no way to
// put a credential on a command line: see Validate.
type CreateRequest struct {
	// Ref and Labels attribute the sandbox. Labels are the discovery and
	// cleanup key, so an adapter must apply them at creation, not afterwards —
	// a create-then-label sequence leaves an unattributable sandbox in the gap.
	Ref    Ref
	Labels map[string]string
	// Snapshot names the prebuilt image the sandbox boots from.
	Snapshot string
	// Env carries configuration and secrets into the sandbox environment.
	Env map[string]string
	// SecretFiles are written inside the sandbox with owner-only permissions.
	// Use them for material that must not appear in the process environment of
	// every child process (private keys, tokens with long lives).
	SecretFiles map[string]string
	// Command and Args, when set, are the sandbox entrypoint. They must never
	// contain secret material.
	Command string
	Args    []string
	// Resources is the requested shape. Zero fields mean provider defaults.
	Resources Resources
	// AutoStopInterval and AutoDeleteInterval ask the provider for its own
	// idle guards. They are belt-and-braces behind the control-plane reaper:
	// if the control plane is down, the provider still stops paying for idle
	// compute. Zero disables the provider-side guard.
	AutoStopInterval   time.Duration
	AutoDeleteInterval time.Duration
	// IdempotencyKey lets an adapter (or the provider) collapse a retried
	// create into the original sandbox instead of a second one.
	IdempotencyKey string
}

// Resources is the requested sandbox shape.
type Resources struct {
	CPU      int
	MemoryGB int
	DiskGB   int
}

// Validate enforces the request invariants the compute plane depends on, above
// all the no-secrets-in-argv rule.
//
// Process arguments are world-readable on a shared host (/proc/*/cmdline),
// land in provider audit logs, and show up in any `ps` a tenant's own agent
// runs inside the sandbox. Environment variables and owner-only files are not
// perfect, but they are not broadcast. This check is mechanical: every secret
// VALUE the request carries must be absent from the command and its arguments.
func (r CreateRequest) Validate() error {
	if err := r.Ref.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(r.Snapshot) == "" {
		return fmt.Errorf("%w: sandbox snapshot is required", ErrInvalid)
	}
	if _, ok := Attribute(r.Labels); !ok {
		return fmt.Errorf("%w: sandbox labels must attribute org, workspace, session, role, and runtime", ErrInvalid)
	}
	if err := guardArgv(r.Command, r.Args, r.Env, r.SecretFiles); err != nil {
		return err
	}
	return nil
}

// minimumGuardedSecretLength keeps the argv scan from rejecting an entrypoint
// because some trivial env value ("1", "true", a short flag word) happens to
// appear in it. Real credentials are long; short values are not secrets worth
// protecting and matching them would only produce false positives.
const minimumGuardedSecretLength = 8

func guardArgv(command string, args []string, secretSets ...map[string]string) error {
	haystack := append([]string{command}, args...)
	names := make([]string, 0)
	for _, secrets := range secretSets {
		for name, value := range secrets {
			if len(value) < minimumGuardedSecretLength {
				continue
			}
			for _, candidate := range haystack {
				if strings.Contains(candidate, value) {
					names = append(names, name)
					break
				}
			}
		}
	}
	if len(names) == 0 {
		return nil
	}
	sort.Strings(names)
	return fmt.Errorf("%w: sandbox arguments must not contain secret values (%s); pass them through the environment or a file",
		ErrInvalid, strings.Join(names, ", "))
}

// Selector filters a provider listing. An empty map matches everything, which
// is what unlabelled-leak discovery needs.
type Selector struct {
	Labels map[string]string
}

// Provider is the compute plane's single outbound port. Implementations must
// be safe for concurrent use, and every method must be idempotent in the sense
// the reconciler relies on: starting a running sandbox, stopping a stopped
// one, and deleting a missing one all succeed.
type Provider interface {
	// Create builds a sandbox and returns it with its provider id and labels.
	Create(ctx context.Context, request CreateRequest) (Sandbox, error)
	// Get returns one sandbox, or ErrSandboxNotFound.
	Get(ctx context.Context, id string) (Sandbox, error)
	// Start boots a stopped sandbox.
	Start(ctx context.Context, id string) (Sandbox, error)
	// Stop suspends a running sandbox without destroying its disk.
	Stop(ctx context.Context, id string) (Sandbox, error)
	// Delete destroys a sandbox. A missing sandbox is success.
	Delete(ctx context.Context, id string) error
	// List enumerates sandboxes matching a selector.
	List(ctx context.Context, selector Selector) ([]Sandbox, error)
}
