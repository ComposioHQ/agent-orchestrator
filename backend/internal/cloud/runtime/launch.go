package runtime

import (
	"context"
	"fmt"
	"path/filepath"
)

const (
	// CapabilityFilePath is the exact launch contract consumed by ao-sandbox.
	CapabilityFilePath = "/run/ao-sandbox/capability.json"
	// SandboxRuntimeCommand is baked into the Daytona snapshot image.
	SandboxRuntimeCommand = "/usr/local/bin/ao-sandbox"
	// SandboxReadyFilePath is atomically published once mux and PTY are live.
	SandboxReadyFilePath = "/run/ao-sandbox/ready.json"
	// SandboxSecretDir is a path, not credential material.
	//nolint:gosec // The identifier names the runtime's protected directory.
	SandboxSecretDir = "/run/ao-sandbox/secrets"
	// SandboxWorkspacePath is the checkout root inside compute.
	SandboxWorkspacePath = "/workspace"
	// SandboxRoutePrefix is the authenticated runtime API prefix.
	SandboxRoutePrefix = "/api/sandbox/v1"
	// SandboxRedeemPath atomically consumes opaque operation tickets online.
	SandboxRedeemPath = "/api/internal/sandbox-tickets/redeem"
)

// LaunchSpec is the semantic PTY child command run by the thin sandbox
// runtime. Command is an absolute executable path; Args are preserved as argv
// and never contain credentials.
type LaunchSpec struct {
	Command string
	Args    []string
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
	files, err := m.launchFiles(ctx, record.Ref())
	if err != nil {
		return CreateRequest{}, err
	}
	request := CreateRequest{
		Ref:                   record.Ref(),
		Labels:                Labels(m.deployment, record.Ref(), record.ID),
		Snapshot:              m.snapshots[record.Role],
		SecretFiles:           files,
		CapabilityFilePath:    CapabilityFilePath,
		ControlPlaneRedeemURL: m.publicURL + SandboxRedeemPath,
		Command:               launch.Command,
		Args:                  append([]string(nil), launch.Args...),
		Resources:             m.resources,
		AutoStopInterval:      m.autoStop,
		AutoDeleteInterval:    m.autoDelete,
		IdempotencyKey:        record.ID,
	}
	if err := request.Validate(); err != nil {
		PurgeFileSecrets(request.SecretFiles)
		return CreateRequest{}, err
	}
	return request, nil
}

func (m *Manager) restartRequest(ctx context.Context, record Record, launch LaunchSpec) (StartRequest, error) {
	if err := launch.Validate(); err != nil {
		return StartRequest{}, err
	}
	files, err := m.launchFiles(ctx, record.Ref())
	if err != nil {
		return StartRequest{}, err
	}
	request := StartRequest{
		Ref:                   record.Ref(),
		SecretFiles:           files,
		CapabilityFilePath:    CapabilityFilePath,
		ControlPlaneRedeemURL: m.publicURL + SandboxRedeemPath,
		Command:               launch.Command,
		Args:                  append([]string(nil), launch.Args...),
		BootstrapKey:          fmt.Sprintf("%s-%d", record.ID, record.Generation),
	}
	if err := request.Validate(); err != nil {
		PurgeFileSecrets(request.SecretFiles)
		return StartRequest{}, err
	}
	return request, nil
}

func (m *Manager) launchFiles(ctx context.Context, ref Ref) ([]FileSecret, error) {
	if m.secrets == nil {
		return nil, nil
	}
	secrets, err := m.secrets.SandboxSecrets(ctx, ref)
	if err != nil {
		return nil, fmt.Errorf("collect sandbox secrets: %w", err)
	}
	return secrets.Files, nil
}
