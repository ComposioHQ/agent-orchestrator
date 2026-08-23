package sandboxruntime

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

const (
	DefaultListenAddress = "0.0.0.0:8080"
	DefaultWorkspacePath = "/workspace"
	DefaultSecretDir     = "/run/ao/secrets"
)

// LaunchConfig is the exact non-secret provider-to-ao-sandbox argv contract.
// The rotating capability is intentionally absent: it has one fixed file path
// and can never be supplied in argv or environment.
type LaunchConfig struct {
	ListenAddress   string
	ControlPlaneURL string
	SandboxID       string
	WorkspaceID     string
	SessionID       domain.SessionID
	WorkspacePath   string
	ReadyFile       string
	SecretDir       string
	RoutePrefix     string
	ChildArgv       []string
}

func ParseLaunchConfig(args []string) (LaunchConfig, error) {
	var config LaunchConfig
	flags := flag.NewFlagSet("ao-sandbox", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&config.ListenAddress, "listen", DefaultListenAddress, "sandbox listener address")
	flags.StringVar(&config.ControlPlaneURL, "control-plane-url", "", "verified HTTPS control-plane URL")
	flags.StringVar(&config.SandboxID, "sandbox-id", "", "durable public sandbox handle")
	flags.StringVar(&config.WorkspaceID, "workspace-id", "", "workspace identifier")
	var sessionID string
	flags.StringVar(&sessionID, "session-id", "", "session identifier")
	flags.StringVar(&config.WorkspacePath, "workspace", DefaultWorkspacePath, "materialized workspace root")
	flags.StringVar(&config.ReadyFile, "ready-file", DefaultReadyPath, "private readiness signal")
	flags.StringVar(&config.SecretDir, "secret-dir", DefaultSecretDir, "owner-only launch secret directory")
	flags.StringVar(&config.RoutePrefix, "route-prefix", DefaultRoutePrefix, "private RPC route prefix")
	if err := flags.Parse(args); err != nil {
		return LaunchConfig{}, fmt.Errorf("parse ao-sandbox launch: %w", err)
	}
	config.SessionID = domain.SessionID(strings.TrimSpace(sessionID))
	config.ChildArgv = append([]string(nil), flags.Args()...)
	if err := config.Validate(); err != nil {
		return LaunchConfig{}, err
	}
	return config, nil
}

func (c LaunchConfig) Validate() error {
	if _, err := parseControlPlaneURL(c.ControlPlaneURL); err != nil {
		return err
	}
	host, port, err := net.SplitHostPort(c.ListenAddress)
	if err != nil || host != "0.0.0.0" || port == "" || port == "0" {
		return errors.New("sandbox listener must bind 0.0.0.0 on a non-zero port")
	}
	if strings.TrimSpace(c.SandboxID) == "" || strings.TrimSpace(c.WorkspaceID) == "" || strings.TrimSpace(string(c.SessionID)) == "" {
		return errors.New("sandbox, workspace, and session identifiers are required")
	}
	if c.WorkspacePath != DefaultWorkspacePath {
		return fmt.Errorf("sandbox workspace path must be %s", DefaultWorkspacePath)
	}
	if c.ReadyFile != DefaultReadyPath {
		return fmt.Errorf("sandbox ready file must be %s", DefaultReadyPath)
	}
	if c.SecretDir != DefaultSecretDir {
		return fmt.Errorf("sandbox secret directory must be %s", DefaultSecretDir)
	}
	if c.RoutePrefix != DefaultRoutePrefix {
		return fmt.Errorf("sandbox route prefix must be %s", DefaultRoutePrefix)
	}
	if len(c.ChildArgv) == 0 || !filepath.IsAbs(c.ChildArgv[0]) {
		return errors.New("sandbox child command must be an absolute semantic argv after --")
	}
	return nil
}
