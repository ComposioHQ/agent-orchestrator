package runtime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/capability"
)

// Capabilities is the credential half of the compute plane, kept as an
// interface so the lifecycle can be tested without a capability store.
// *capability.Authority satisfies it.
type Capabilities interface {
	Issue(ctx context.Context, scope capability.Scope, ttl time.Duration) (capability.Grant, error)
	RevokeScope(ctx context.Context, selector capability.Selector) (int, error)
}

// Secrets are the per-launch credentials a sandbox needs (an SCM token, an
// agent API key). Env values land in the sandbox environment; Files are
// written inside the sandbox with owner-only permissions. Neither ever reaches
// a command line — CreateRequest.Validate enforces that mechanically.
type Secrets struct {
	Env   map[string]string
	Files map[string]string
}

// SecretSource mints and purges the short-lived credentials placed inside a
// sandbox. It is owned outside this package (SCM installations, agent keys);
// the compute plane only needs to know when to ask for them and when to
// destroy them. A nil source means the deployment injects no secrets.
type SecretSource interface {
	SandboxSecrets(ctx context.Context, ref Ref) (Secrets, error)
	PurgeSandboxSecrets(ctx context.Context, ref Ref) error
}

// RouteRegistry publishes and releases the network path that reaches a
// sandbox (a terminal relay route, a preview host). A nil registry means the
// deployment has no published routes yet.
type RouteRegistry interface {
	PublishRoute(ctx context.Context, ref Ref, sandbox Sandbox) error
	ReleaseRoutes(ctx context.Context, ref Ref) error
}

// Options configures a Manager.
type Options struct {
	Store    Store
	Provider Provider
	// Capabilities is required: a sandbox with no scoped credential cannot
	// talk to the control plane at all, and a deployment that "temporarily"
	// runs without one would have to fall back to a shared secret.
	Capabilities Capabilities
	Secrets      SecretSource
	Routes       RouteRegistry
	// Deployment names this control plane. It is stamped on every sandbox so
	// two deployments can share a provider account without reaping each other.
	Deployment string
	// PublicURL is the base URL sandboxes call back on. It is handed to the
	// sandbox in its environment together with its capability.
	PublicURL string
	// Snapshots names the prebuilt image per role.
	Snapshots map[Role]string
	// Resources is the requested shape for new sandboxes.
	Resources Resources
	// CapabilityTTL bounds how long a freshly injected capability lives.
	CapabilityTTL time.Duration
	// AutoStopInterval and AutoDeleteInterval are the provider-side idle
	// guards requested at creation.
	AutoStopInterval   time.Duration
	AutoDeleteInterval time.Duration
	Quotas             Quotas
	Clock              func() time.Time
	Logger             *slog.Logger
}

// Manager owns sandbox lifecycle: idempotent create, start, stop, and cascade
// delete, under per-org and per-user quotas.
type Manager struct {
	store         Store
	provider      Provider
	capabilities  Capabilities
	secrets       SecretSource
	routes        RouteRegistry
	deployment    string
	publicURL     string
	snapshots     map[Role]string
	resources     Resources
	capabilityTTL time.Duration
	autoStop      time.Duration
	autoDelete    time.Duration
	quotas        Quotas
	now           func() time.Time
	logger        *slog.Logger
}

const defaultCapabilityTTL = 12 * time.Hour

// NewManager validates the compute-plane dependencies and builds a Manager.
func NewManager(options Options) (*Manager, error) {
	if options.Store == nil || options.Provider == nil || options.Capabilities == nil {
		return nil, errors.New("compute plane requires a store, a provider, and a capability authority")
	}
	if strings.TrimSpace(options.Deployment) == "" {
		return nil, errors.New("compute plane requires a deployment name for provider labelling")
	}
	if strings.TrimSpace(options.PublicURL) == "" {
		return nil, errors.New("compute plane requires the public control-plane URL sandboxes call back on")
	}
	for _, role := range []Role{RoleCoordinator, RoleWorker} {
		if strings.TrimSpace(options.Snapshots[role]) == "" {
			return nil, fmt.Errorf("compute plane requires a %s sandbox snapshot", role)
		}
	}
	if err := options.Quotas.Validate(); err != nil {
		return nil, err
	}
	if options.CapabilityTTL <= 0 {
		options.CapabilityTTL = defaultCapabilityTTL
	}
	if options.Clock == nil {
		options.Clock = time.Now
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	snapshots := make(map[Role]string, len(options.Snapshots))
	for role, snapshot := range options.Snapshots {
		snapshots[role] = strings.TrimSpace(snapshot)
	}
	return &Manager{
		store:         options.Store,
		provider:      options.Provider,
		capabilities:  options.Capabilities,
		secrets:       options.Secrets,
		routes:        options.Routes,
		deployment:    strings.TrimSpace(options.Deployment),
		publicURL:     strings.TrimRight(strings.TrimSpace(options.PublicURL), "/"),
		snapshots:     snapshots,
		resources:     options.Resources,
		capabilityTTL: options.CapabilityTTL,
		autoStop:      options.AutoStopInterval,
		autoDelete:    options.AutoDeleteInterval,
		quotas:        options.Quotas,
		now:           options.Clock,
		logger:        options.Logger,
	}, nil
}

// Placement is what Ensure returns.
type Placement struct {
	Record Record
	// Sandbox is the provider's view when the call touched the provider.
	Sandbox Sandbox
	// Capability carries a bearer token ONLY when this call minted one, which
	// happens exactly when the sandbox was created or booted by this call. An
	// attach to an already-running sandbox returns a zero Grant: the running
	// sandbox already holds its credential and has no way to receive a new one
	// out of band. Callers must treat a zero Token as "nothing to deliver",
	// never as an error.
	Capability capability.Grant
	// Created reports whether this call inserted the placement row.
	Created bool
}

// Ensure is the idempotent entry point for "this session needs a sandbox".
//
// Concurrent and repeated calls for the same ref converge on one sandbox: the
// placement row is the mutual-exclusion point, and the row is written before
// the provider is contacted so a lost create response leaves a labelled
// orphan the reconciler can attribute, never an untracked one.
func (m *Manager) Ensure(ctx context.Context, ref Ref) (Placement, error) {
	ref = ref.Normalize()
	if err := ref.ValidateForPlacement(); err != nil {
		return Placement{}, err
	}
	now := m.now().UTC()

	existing, err := m.store.Get(ctx, ref)
	switch {
	case err == nil:
		if existing.State == StateDeleting {
			return Placement{}, fmt.Errorf("%w: %s", ErrDeleting, ref)
		}
		return m.ensureExisting(ctx, existing, now)
	case errors.Is(err, ErrNotFound):
	default:
		return Placement{}, err
	}

	// Quotas are checked only on the path that adds compute. An attach or a
	// repair of an existing placement must never fail because a limit was
	// lowered underneath a running session.
	if err := m.quotas.check(ctx, m.store, ref); err != nil {
		return Placement{}, err
	}
	record, created, err := m.store.Ensure(ctx, ref, now)
	if err != nil {
		return Placement{}, err
	}
	if !created {
		if record.State == StateDeleting {
			return Placement{}, fmt.Errorf("%w: %s", ErrDeleting, ref)
		}
		// Another caller won the insert race; converge on its row.
		return m.ensureExisting(ctx, record, now)
	}
	placement, err := m.provision(ctx, record, now)
	placement.Created = true
	return placement, err
}

// ensureExisting converges an existing placement. It reconciles against the
// provider first, because the row's State is only ever a cached observation.
func (m *Manager) ensureExisting(ctx context.Context, record Record, now time.Time) (Placement, error) {
	if record.ProviderID == "" {
		// The row was inserted but the provider call never completed. Resume.
		return m.provision(ctx, record, now)
	}
	sandbox, err := m.provider.Get(ctx, record.ProviderID)
	if errors.Is(err, ErrSandboxNotFound) {
		// The sandbox is gone. Re-provision onto the same row so the runtime
		// id, and therefore the provider labels, stay stable.
		m.logger.Warn("cloud sandbox disappeared from the provider; re-provisioning",
			"runtime", record.ID, "placement", record.Ref().String(), "provider_sandbox", record.ProviderID)
		record.ProviderID = ""
		record.State = StateProvisioning
		record.Error = ""
		record.UpdatedAt = now
		saved, saveErr := m.store.Save(ctx, record)
		if saveErr != nil {
			return Placement{}, saveErr
		}
		return m.provision(ctx, saved, now)
	}
	if err != nil {
		return Placement{}, providerFailure("get sandbox", err)
	}

	switch sandbox.State {
	case ProviderRunning, ProviderStarting:
		updated, err := m.observe(ctx, record, sandbox, now)
		return Placement{Record: updated, Sandbox: sandbox}, err
	default:
		// Stopped or broken: boot it, which is also when a fresh capability is
		// minted, because the restart is the only moment the sandbox can
		// receive one.
		return m.boot(ctx, record, now)
	}
}

// provision issues a capability, gathers secrets, and creates the sandbox.
func (m *Manager) provision(ctx context.Context, record Record, now time.Time) (Placement, error) {
	grant, request, err := m.launchRequest(ctx, record)
	if err != nil {
		return Placement{}, m.markFailed(ctx, record, now, err)
	}
	sandbox, err := m.provider.Create(ctx, request)
	if err != nil {
		return Placement{}, m.markFailed(ctx, record, now, providerFailure("create sandbox", err))
	}
	record.ProviderID = sandbox.ID
	updated, err := m.observe(ctx, record, sandbox, now)
	if err != nil {
		return Placement{}, err
	}
	if err := m.publishRoute(ctx, updated.Ref(), sandbox); err != nil {
		return Placement{}, err
	}
	return Placement{Record: updated, Sandbox: sandbox, Capability: grant}, nil
}

// boot starts an existing stopped sandbox with a freshly minted capability.
// The old capabilities for this placement are revoked first: a restarted
// sandbox must not be reachable with the credential its previous incarnation
// held, and the local pattern (relaunching a worker rotates its browser
// capability) is the same rule.
func (m *Manager) boot(ctx context.Context, record Record, now time.Time) (Placement, error) {
	// Booting IS the intent to run. Without this, a session resumed after the
	// reaper stopped it for idleness would keep DesiredState stopped, and the
	// next reconciliation pass would immediately stop it again.
	record.DesiredState = StateRunning
	if err := m.revokeCapabilities(ctx, record.Ref()); err != nil {
		return Placement{}, err
	}
	grant, err := m.issueCapability(ctx, record)
	if err != nil {
		return Placement{}, m.markFailed(ctx, record, now, err)
	}
	sandbox, err := m.provider.Start(ctx, record.ProviderID)
	if err != nil {
		if errors.Is(err, ErrSandboxNotFound) {
			return m.ensureExisting(ctx, record, now)
		}
		return Placement{}, m.markFailed(ctx, record, now, providerFailure("start sandbox", err))
	}
	updated, err := m.observe(ctx, record, sandbox, now)
	if err != nil {
		return Placement{}, err
	}
	if err := m.publishRoute(ctx, updated.Ref(), sandbox); err != nil {
		return Placement{}, err
	}
	return Placement{Record: updated, Sandbox: sandbox, Capability: grant}, nil
}

// Start boots the sandbox behind an existing placement.
func (m *Manager) Start(ctx context.Context, ref Ref) (Placement, error) {
	record, err := m.load(ctx, ref)
	if err != nil {
		return Placement{}, err
	}
	if record.State == StateDeleting {
		return Placement{}, fmt.Errorf("%w: %s", ErrDeleting, ref)
	}
	record.DesiredState = StateRunning
	now := m.now().UTC()
	if record.ProviderID == "" {
		return m.provision(ctx, record, now)
	}
	return m.boot(ctx, record, now)
}

// Stop suspends a sandbox and revokes its capabilities. Stopping is not
// deleting: the row and the sandbox disk survive, so the session can resume,
// but the credential does not, because a stopped sandbox has no legitimate
// reason to hold a live capability and Start mints a fresh one.
func (m *Manager) Stop(ctx context.Context, ref Ref) (Record, error) {
	record, err := m.load(ctx, ref)
	if err != nil {
		return Record{}, err
	}
	if record.State == StateDeleting {
		return Record{}, fmt.Errorf("%w: %s", ErrDeleting, ref)
	}
	now := m.now().UTC()
	record.DesiredState = StateStopped
	if record.ProviderID == "" {
		record.State = StateStopped
		record.UpdatedAt = now
		return m.store.Save(ctx, record)
	}
	if err := m.revokeCapabilities(ctx, record.Ref()); err != nil {
		return Record{}, err
	}
	sandbox, err := m.provider.Stop(ctx, record.ProviderID)
	if err != nil && !errors.Is(err, ErrSandboxNotFound) {
		return Record{}, providerFailure("stop sandbox", err)
	}
	if errors.Is(err, ErrSandboxNotFound) {
		sandbox = Sandbox{ID: record.ProviderID, State: ProviderStopped}
	}
	return m.observe(ctx, record, sandbox, now)
}

// Delete tears one placement down completely and idempotently.
//
// The order is credentials, secrets, routes, provider, row. Killing the
// credential first means a sandbox that survives the provider call — because
// the provider is down, or because the delete is being retried after a crash —
// can no longer act on the control plane. Deleting the row last means a
// failure anywhere leaves a row in StateDeleting that the reconciler will
// finish, instead of an untracked sandbox nobody will ever bill or reap.
func (m *Manager) Delete(ctx context.Context, ref Ref) error {
	ref = ref.Normalize()
	if err := ref.Validate(); err != nil {
		return err
	}
	record, err := m.store.Get(ctx, ref)
	if errors.Is(err, ErrNotFound) {
		// Still purge the scoped credentials and routes: a row may have been
		// removed by a partial earlier attempt while grants survived.
		return m.purgeDetached(ctx, ref)
	}
	if err != nil {
		return err
	}
	return m.finishDelete(ctx, record)
}

// finishDelete drives a placement to removal from whatever state it is in.
// The reconciler calls it directly for rows already marked deleting.
func (m *Manager) finishDelete(ctx context.Context, record Record) error {
	now := m.now().UTC()
	if record.State != StateDeleting {
		record.State = StateDeleting
		record.DesiredState = StateDeleting
		record.UpdatedAt = now
		saved, err := m.store.Save(ctx, record)
		if err != nil {
			return err
		}
		record = saved
	}
	ref := record.Ref()
	if err := m.revokeCapabilities(ctx, ref); err != nil {
		return err
	}
	if m.secrets != nil {
		if err := m.secrets.PurgeSandboxSecrets(ctx, ref); err != nil {
			return fmt.Errorf("purge sandbox secrets: %w", err)
		}
	}
	if m.routes != nil {
		if err := m.routes.ReleaseRoutes(ctx, ref); err != nil {
			return fmt.Errorf("release sandbox routes: %w", err)
		}
	}
	if record.ProviderID != "" {
		if err := m.provider.Delete(ctx, record.ProviderID); err != nil && !errors.Is(err, ErrSandboxNotFound) {
			return providerFailure("delete sandbox", err)
		}
	}
	return m.store.Delete(ctx, record.ID, record.Generation)
}

// purgeDetached revokes credentials and routes for a ref with no surviving
// row, so a half-finished delete cannot leave a live capability behind.
func (m *Manager) purgeDetached(ctx context.Context, ref Ref) error {
	if err := m.revokeCapabilities(ctx, ref); err != nil {
		return err
	}
	if m.secrets != nil {
		if err := m.secrets.PurgeSandboxSecrets(ctx, ref); err != nil {
			return fmt.Errorf("purge sandbox secrets: %w", err)
		}
	}
	if m.routes != nil {
		if err := m.routes.ReleaseRoutes(ctx, ref); err != nil {
			return fmt.Errorf("release sandbox routes: %w", err)
		}
	}
	return nil
}

// DeleteWorkspace cascades a workspace teardown across every placement it
// owns, then revokes any workspace-scoped grant whose row is already gone.
// Errors are collected so one wedged sandbox cannot strand the rest.
func (m *Manager) DeleteWorkspace(ctx context.Context, orgID, workspaceID string) error {
	orgID = strings.TrimSpace(orgID)
	workspaceID = strings.TrimSpace(workspaceID)
	if orgID == "" || workspaceID == "" {
		return fmt.Errorf("%w: organization and workspace are required", ErrInvalid)
	}
	records, err := m.store.List(ctx, Filter{OrgID: orgID, WorkspaceID: workspaceID})
	if err != nil {
		return err
	}
	var failures []error
	for _, record := range records {
		if err := m.finishDelete(ctx, record); err != nil {
			failures = append(failures, fmt.Errorf("%s: %w", record.Ref(), err))
		}
	}
	if _, err := m.capabilities.RevokeScope(ctx, capability.Selector{OrgID: orgID, WorkspaceID: workspaceID}); err != nil {
		failures = append(failures, fmt.Errorf("revoke workspace capabilities: %w", err))
	}
	return errors.Join(failures...)
}

// Get returns the placement row for a ref.
func (m *Manager) Get(ctx context.Context, ref Ref) (Record, error) { return m.load(ctx, ref) }

// Heartbeat records an authenticated sandbox check-in and reports the state
// the control plane wants the sandbox in, so a sandbox learns about a pending
// stop without the control plane holding a connection open.
func (m *Manager) Heartbeat(ctx context.Context, ref Ref, at time.Time) (Record, error) {
	record, err := m.load(ctx, ref)
	if err != nil {
		return Record{}, err
	}
	if at.IsZero() {
		at = m.now().UTC()
	}
	record.LastHeartbeatAt = at.UTC()
	record.UpdatedAt = at.UTC()
	return m.store.Save(ctx, record)
}

// ReportState records the sandbox's own view of itself. It is advisory: the
// provider remains the authority for whether a sandbox is running, and a
// sandbox may not report itself into or out of deletion.
func (m *Manager) ReportState(ctx context.Context, ref Ref, state State, failure string) (Record, error) {
	if !state.Valid() || state == StateDeleting || state == StateProvisioning {
		return Record{}, fmt.Errorf("%w: a sandbox may only report running, stopped, or failed", ErrInvalid)
	}
	record, err := m.load(ctx, ref)
	if err != nil {
		return Record{}, err
	}
	if record.State == StateDeleting {
		return Record{}, fmt.Errorf("%w: %s", ErrDeleting, ref)
	}
	now := m.now().UTC()
	record.State = state
	record.Error = strings.TrimSpace(failure)
	record.LastHeartbeatAt = now
	record.UpdatedAt = now
	return m.store.Save(ctx, record)
}

func (m *Manager) load(ctx context.Context, ref Ref) (Record, error) {
	ref = ref.Normalize()
	if err := ref.Validate(); err != nil {
		return Record{}, err
	}
	return m.store.Get(ctx, ref)
}

// observe folds a provider view into the placement row.
func (m *Manager) observe(ctx context.Context, record Record, sandbox Sandbox, now time.Time) (Record, error) {
	record.ProviderID = sandbox.ID
	record.State = stateFor(sandbox.State)
	if record.DesiredState == "" || record.DesiredState == StateProvisioning {
		record.DesiredState = StateRunning
	}
	if record.State == StateFailed {
		record.Error = sandbox.Error
	} else {
		record.Error = ""
	}
	record.UpdatedAt = now
	return m.store.Save(ctx, record)
}

// markFailed records a launch failure on the row and returns the original
// error. The row survives so the reconciler can retry or reap it; a failure
// that deleted its own row would leak the provider sandbox it may have made.
func (m *Manager) markFailed(ctx context.Context, record Record, now time.Time, cause error) error {
	record.State = StateFailed
	record.Error = cause.Error()
	record.UpdatedAt = now
	if _, err := m.store.Save(ctx, record); err != nil {
		return errors.Join(cause, err)
	}
	return cause
}

func (m *Manager) publishRoute(ctx context.Context, ref Ref, sandbox Sandbox) error {
	if m.routes == nil {
		return nil
	}
	if err := m.routes.PublishRoute(ctx, ref, sandbox); err != nil {
		return fmt.Errorf("publish sandbox route: %w", err)
	}
	return nil
}

func (m *Manager) revokeCapabilities(ctx context.Context, ref Ref) error {
	if _, err := m.capabilities.RevokeScope(ctx, capability.Selector{
		OrgID:       ref.OrgID,
		WorkspaceID: ref.WorkspaceID,
		SessionID:   ref.SessionID,
	}); err != nil {
		return fmt.Errorf("revoke sandbox capabilities: %w", err)
	}
	return nil
}

func stateFor(state ProviderState) State {
	switch state {
	case ProviderRunning:
		return StateRunning
	case ProviderStarting:
		return StateProvisioning
	case ProviderStopped:
		return StateStopped
	default:
		return StateFailed
	}
}
