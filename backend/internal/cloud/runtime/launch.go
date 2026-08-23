package runtime

import (
	"context"
	"fmt"
	"maps"
	"path/filepath"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/capability"
)

const (
	// CapabilityFilePath is the exact launch contract consumed by ao-sandbox.
	CapabilityFilePath = "/run/ao/capability"
	// SandboxRuntimeCommand is baked into the Daytona snapshot image.
	SandboxRuntimeCommand = "/usr/local/bin/ao-sandbox"
	// SandboxReadyFilePath is atomically published once mux and PTY are live.
	SandboxReadyFilePath = "/run/ao/ready.json"
	// SandboxSecretDir is a path, not credential material.
	//nolint:gosec // The identifier names the runtime's protected directory.
	SandboxSecretDir = "/run/ao/secrets"
	// SandboxWorkspacePath is the checkout root inside compute.
	SandboxWorkspacePath = "/workspace"
	// SandboxRoutePrefix is the authenticated runtime API prefix.
	SandboxRoutePrefix = "/api/sandbox/v1"
)

// LaunchSpec is the semantic PTY child command run by the thin sandbox
// runtime. Command is an absolute executable path; Args are preserved as argv
// and never contain credentials.
type LaunchSpec struct {
	Command string
	Args    []string
	// Env is non-secret process configuration applied when the sandbox is
	// created. Credentials must use FileSecret instead.
	Env map[string]string
}

// Validate rejects a launch that ao-sandbox cannot execute semantically.
func (s LaunchSpec) Validate() error {
	if !filepath.IsAbs(s.Command) {
		return fmt.Errorf("%w: sandbox agent command must be absolute", ErrInvalid)
	}
	return nil
}

func (m *Manager) launchRequest(ctx context.Context, record Record, launch LaunchSpec) (CreateRequest, error) {
	if err := launch.Validate(); err != nil {
		return CreateRequest{}, err
	}
	capabilityFile, files, err := m.launchFiles(ctx, record.Ref())
	if err != nil {
		return CreateRequest{}, err
	}
	request := CreateRequest{
		Ref:                record.Ref(),
		Labels:             Labels(m.deployment, record.Ref(), record.ID),
		Snapshot:           m.snapshots[record.Role],
		SecretFiles:        files,
		Capability:         capabilityFile,
		ControlPlaneURL:    m.publicURL,
		Command:            launch.Command,
		Args:               append([]string(nil), launch.Args...),
		Env:                maps.Clone(launch.Env),
		Resources:          m.resources,
		AutoStopInterval:   m.autoStop,
		AutoDeleteInterval: m.autoDelete,
		IdempotencyKey:     record.ID,
	}
	if err := request.Validate(); err != nil {
		PurgeFileSecrets(request.SecretFiles)
		PurgeFileSecrets([]FileSecret{request.Capability})
		return CreateRequest{}, err
	}
	return request, nil
}

func (m *Manager) restartRequest(ctx context.Context, record Record, launch LaunchSpec) (StartRequest, error) {
	if err := launch.Validate(); err != nil {
		return StartRequest{}, err
	}
	capabilityFile, files, err := m.launchFiles(ctx, record.Ref())
	if err != nil {
		return StartRequest{}, err
	}
	request := StartRequest{
		Ref:             record.Ref(),
		SecretFiles:     files,
		Capability:      capabilityFile,
		ControlPlaneURL: m.publicURL,
		Command:         launch.Command,
		Args:            append([]string(nil), launch.Args...),
		BootstrapKey:    fmt.Sprintf("%s-%d", record.ID, record.Generation),
		RuntimeID:       record.ID,
	}
	if err := request.Validate(); err != nil {
		PurgeFileSecrets(request.SecretFiles)
		PurgeFileSecrets([]FileSecret{request.Capability})
		return StartRequest{}, err
	}
	return request, nil
}

func (m *Manager) launchFiles(ctx context.Context, ref Ref) (FileSecret, []FileSecret, error) {
	operations, err := capability.OperationsForRole(string(ref.Role))
	if err != nil {
		return FileSecret{}, nil, err
	}
	raw, err := m.capabilities.IssueSandbox(ctx, capability.Scope{
		OrgID: ref.OrgID, WorkspaceID: ref.WorkspaceID, SessionID: ref.SessionID,
		Role: string(ref.Role), Operations: operations,
	})
	if err != nil {
		return FileSecret{}, nil, fmt.Errorf("issue sandbox capability: %w", err)
	}
	capabilityFile := FileSecret{Path: CapabilityFilePath, Content: raw, Mode: 0o600}
	if m.secrets == nil {
		return capabilityFile, nil, nil
	}
	secrets, err := m.secrets.SandboxSecrets(ctx, ref)
	if err != nil {
		PurgeFileSecrets([]FileSecret{capabilityFile})
		return FileSecret{}, nil, fmt.Errorf("collect sandbox secrets: %w", err)
	}
	return capabilityFile, secrets.Files, nil
}
