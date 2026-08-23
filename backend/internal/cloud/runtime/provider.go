package runtime

import (
	"bytes"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
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
// Secrets travel in SecretFiles only. There is deliberately no credential
// field for argv or environment: see Validate.
type CreateRequest struct {
	// Ref and Labels attribute the sandbox. Labels are the discovery and
	// cleanup key, so an adapter must apply them at creation, not afterwards —
	// a create-then-label sequence leaves an unattributable sandbox in the gap.
	Ref    Ref
	Labels map[string]string
	// Snapshot names the prebuilt image the sandbox boots from.
	Snapshot string
	// Env carries non-secret launch configuration into the sandbox
	// environment. Secret credentials use SecretFiles so they do not survive
	// in the environment of every child process.
	Env map[string]string
	// SecretFiles are transient byte buffers written inside the sandbox with
	// owner-only permissions. Providers must purge Content before Create
	// returns, whether creation succeeds or fails.
	SecretFiles []FileSecret
	// CapabilityFilePath receives the 0600 sandbox-runtime launch metadata.
	// The provider fills in the provider sandbox id after creation.
	CapabilityFilePath    string
	ControlPlaneRedeemURL string
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

// StartRequest supplies the fresh, short-lived launch material needed when a
// stopped sandbox boots again. A revoked capability file must never be reused.
type StartRequest struct {
	SecretFiles           []FileSecret
	Command               string
	Args                  []string
	BootstrapKey          string
	Ref                   Ref
	CapabilityFilePath    string
	ControlPlaneRedeemURL string
}

// Validate enforces fresh launch metadata and secret-free semantic argv.
func (r StartRequest) Validate() error {
	if strings.TrimSpace(r.Command) == "" || strings.TrimSpace(r.BootstrapKey) == "" {
		return fmt.Errorf("%w: restart command and bootstrap key are required", ErrInvalid)
	}
	if err := validateCapabilityFile(r.Ref, r.CapabilityFilePath, r.ControlPlaneRedeemURL); err != nil {
		return err
	}
	if err := validateFileSecrets(r.SecretFiles); err != nil {
		return err
	}
	for _, secret := range r.SecretFiles {
		if secret.Path == r.CapabilityFilePath {
			return fmt.Errorf("%w: secret source may not replace the sandbox capability file", ErrInvalid)
		}
	}
	return guardFileSecretsArgv(r.Command, r.Args, r.SecretFiles)
}

func validateCapabilityFile(ref Ref, path, redeemURL string) error {
	if err := ref.Validate(); err != nil {
		return err
	}
	if strings.TrimSpace(path) != CapabilityFilePath {
		return fmt.Errorf("%w: capability file path must be %s", ErrInvalid, CapabilityFilePath)
	}
	parsed, err := url.Parse(strings.TrimSpace(redeemURL))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return fmt.Errorf("%w: control-plane redemption URL must be absolute HTTPS", ErrInvalid)
	}
	return nil
}

// FileSecret is one short-lived capability or credential delivered through a
// file. Mode must be owner-only; zero means 0600. Content is deliberately a
// byte slice so it can be overwritten after delivery instead of lingering as
// an immutable Go string.
type FileSecret struct {
	Path    string
	Content []byte
	Mode    uint32
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
	if strings.TrimSpace(r.Command) == "" {
		return fmt.Errorf("%w: sandbox command is required", ErrInvalid)
	}
	if err := validateCapabilityFile(r.Ref, r.CapabilityFilePath, r.ControlPlaneRedeemURL); err != nil {
		return err
	}
	if err := validateConfigEnv(r.Env); err != nil {
		return err
	}
	if err := validateFileSecrets(r.SecretFiles); err != nil {
		return err
	}
	for _, secret := range r.SecretFiles {
		if secret.Path == r.CapabilityFilePath {
			return fmt.Errorf("%w: secret source may not replace the sandbox capability file", ErrInvalid)
		}
	}
	if err := guardFileSecretsArgv(r.Command, r.Args, r.SecretFiles); err != nil {
		return err
	}
	return nil
}

func validateFileSecrets(secrets []FileSecret) error {
	seen := make(map[string]struct{}, len(secrets))
	for _, secret := range secrets {
		path := strings.TrimSpace(secret.Path)
		if path == "" || !strings.HasPrefix(path, "/") {
			return fmt.Errorf("%w: secret file path must be absolute", ErrInvalid)
		}
		if len(secret.Content) == 0 {
			return fmt.Errorf("%w: secret file %s is empty", ErrInvalid, path)
		}
		mode := secret.Mode
		if mode == 0 {
			mode = 0o600
		}
		if mode&0o077 != 0 || mode&0o600 != mode {
			return fmt.Errorf("%w: secret file %s mode must be owner-only", ErrInvalid, path)
		}
		if _, duplicate := seen[path]; duplicate {
			return fmt.Errorf("%w: duplicate secret file path %s", ErrInvalid, path)
		}
		seen[path] = struct{}{}
	}
	return nil
}

func validateConfigEnv(env map[string]string) error {
	for name := range env {
		upper := strings.ToUpper(strings.TrimSpace(name))
		if strings.HasSuffix(upper, "_FILE") {
			continue
		}
		for _, marker := range []string{"TOKEN", "SECRET", "PASSWORD", "CREDENTIAL", "API_KEY", "PRIVATE_KEY"} {
			if strings.Contains(upper, marker) {
				return fmt.Errorf("%w: %s looks secret-bearing; deliver credentials through FileSecret", ErrInvalid, name)
			}
		}
	}
	return nil
}

// PurgeFileSecrets overwrites transient secret buffers in place. It is
// exported so managers and provider adapters can both defer it at their trust
// boundary; repeated purges are harmless.
func PurgeFileSecrets(secrets []FileSecret) {
	for i := range secrets {
		clear(secrets[i].Content)
		secrets[i].Content = nil
	}
}

// minimumGuardedSecretLength keeps the argv scan from rejecting an entrypoint
// because a trivial short file value happens to appear in it.
const minimumGuardedSecretLength = 8

func guardFileSecretsArgv(command string, args []string, secrets []FileSecret) error {
	haystack := make([][]byte, 0, len(args)+1)
	haystack = append(haystack, []byte(command))
	for _, arg := range args {
		haystack = append(haystack, []byte(arg))
	}
	leaked := make([]string, 0)
	for _, secret := range secrets {
		if len(secret.Content) < minimumGuardedSecretLength {
			continue
		}
		for _, candidate := range haystack {
			if bytes.Contains(candidate, secret.Content) {
				leaked = append(leaked, secret.Path)
				break
			}
		}
	}
	if len(leaked) == 0 {
		return nil
	}
	sort.Strings(leaked)
	return fmt.Errorf("%w: sandbox arguments must not contain secret file values (%s)", ErrInvalid, strings.Join(leaked, ", "))
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
type Provider = ports.ComputeProvider[CreateRequest, StartRequest, Sandbox, Selector]
