package runtime

import (
	"context"
	"fmt"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/capability"
)

// Environment variables handed to a sandbox at launch. They mirror the local
// daemon's AO_* launch environment (session_manager.runtimeEnv) so the agent
// harness inside the sandbox sees the same shape it sees locally.
const (
	// EnvControlPlaneURL is the base URL the sandbox calls back on.
	EnvControlPlaneURL = "AO_CLOUD_URL"
	// EnvCapability carries the sandbox's opaque scoped capability. It is the
	// ONLY credential the sandbox gets for the control plane, and it is
	// injected through the environment because a command line is readable by
	// every process in the sandbox and by provider audit logs.
	EnvCapability = "AO_CLOUD_CAPABILITY"
	// EnvOrgID, EnvWorkspaceID, EnvSessionID, and EnvRole identify the
	// placement. They are conveniences for the harness: the control plane
	// authorizes from the capability's scope and never from these values.
	EnvOrgID       = "AO_CLOUD_ORG_ID"
	EnvWorkspaceID = "AO_CLOUD_WORKSPACE_ID"
	EnvSessionID   = "AO_CLOUD_SESSION_ID"
	EnvRole        = "AO_CLOUD_ROLE"
	// EnvRuntimeID is the placement row id, used for support correlation.
	EnvRuntimeID = "AO_CLOUD_RUNTIME_ID"
)

// coordinatorOperations is what a workspace coordinator may do. It may read
// its workspace and ask for worker sandboxes; it may not read or write another
// session's data, and it holds no operation that would let it mint credentials.
var coordinatorOperations = []capability.Operation{
	capability.OpSandboxHeartbeat,
	capability.OpSandboxReportState,
	capability.OpCapabilityRotate,
	capability.OpWorkspaceRead,
	capability.OpWorkerProvision,
}

// workerOperations is what one worker agent may do: keep itself alive and act
// on its OWN session. It cannot enumerate the workspace and cannot provision
// more compute, so a compromised worker cannot fan out.
var workerOperations = []capability.Operation{
	capability.OpSandboxHeartbeat,
	capability.OpSandboxReportState,
	capability.OpCapabilityRotate,
	capability.OpSessionRead,
	capability.OpSessionWrite,
}

// CapabilityScope builds the scope for one placement. It is exported so the
// integrator's HTTP layer can assert that a request's granted scope matches
// the placement it names, rather than re-deriving the operation lists.
func CapabilityScope(ref Ref) capability.Scope {
	operations := workerOperations
	if ref.Role == RoleCoordinator {
		operations = coordinatorOperations
	}
	return capability.Scope{
		OrgID:       ref.OrgID,
		WorkspaceID: ref.WorkspaceID,
		SessionID:   ref.SessionID,
		Role:        string(ref.Role),
		Operations:  operations,
	}
}

func (m *Manager) issueCapability(ctx context.Context, record Record) (capability.Grant, error) {
	grant, err := m.capabilities.Issue(ctx, CapabilityScope(record.Ref()), m.capabilityTTL)
	if err != nil {
		return capability.Grant{}, fmt.Errorf("issue sandbox capability: %w", err)
	}
	if grant.Token == "" {
		return capability.Grant{}, fmt.Errorf("%w: capability authority returned an empty credential", ErrInvalid)
	}
	return grant, nil
}

// launchRequest mints the sandbox's capability, collects its secrets, and
// assembles the provider create request.
//
// Ordering matters: the capability is issued BEFORE the provider call, so the
// verifier is durable before any sandbox could present the token. That is the
// same race the local daemon closes by persisting the browser capability
// verifier before the worker runtime starts.
func (m *Manager) launchRequest(ctx context.Context, record Record) (capability.Grant, CreateRequest, error) {
	ref := record.Ref()
	grant, err := m.issueCapability(ctx, record)
	if err != nil {
		return capability.Grant{}, CreateRequest{}, err
	}
	env := map[string]string{
		EnvControlPlaneURL: m.publicURL,
		EnvCapability:      grant.Token,
		EnvOrgID:           ref.OrgID,
		EnvWorkspaceID:     ref.WorkspaceID,
		EnvSessionID:       ref.SessionID,
		EnvRole:            string(ref.Role),
		EnvRuntimeID:       record.ID,
	}
	var files map[string]string
	if m.secrets != nil {
		secrets, err := m.secrets.SandboxSecrets(ctx, ref)
		if err != nil {
			return capability.Grant{}, CreateRequest{}, fmt.Errorf("collect sandbox secrets: %w", err)
		}
		for name, value := range secrets.Env {
			// Deployment-supplied secrets must not silently replace the
			// control-plane variables: an env override of AO_CLOUD_CAPABILITY
			// would hand the sandbox a credential the control plane did not
			// issue.
			if _, reserved := env[name]; reserved {
				return capability.Grant{}, CreateRequest{}, fmt.Errorf("%w: secret source may not override %s", ErrInvalid, name)
			}
			env[name] = value
		}
		files = secrets.Files
	}
	request := CreateRequest{
		Ref:                ref,
		Labels:             Labels(m.deployment, ref, record.ID),
		Snapshot:           m.snapshots[ref.Role],
		Env:                env,
		SecretFiles:        files,
		Resources:          m.resources,
		AutoStopInterval:   m.autoStop,
		AutoDeleteInterval: m.autoDelete,
		// The placement row id is stable across retries of the same launch, so
		// a provider that honours idempotency keys collapses a retried create
		// into the original sandbox instead of leaking a second one.
		IdempotencyKey: record.ID,
	}
	if err := request.Validate(); err != nil {
		return capability.Grant{}, CreateRequest{}, err
	}
	return grant, request, nil
}
