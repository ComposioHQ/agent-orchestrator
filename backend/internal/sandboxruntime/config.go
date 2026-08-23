package sandboxruntime

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
)

// CapabilityFile is the only launch-time capability input. Its path is safe in
// argv; the 0600 file contents never appear in argv, environment, or logs.
type CapabilityFile struct {
	SandboxID             string `json:"sandboxId"`
	WorkspaceID           string `json:"workspaceId"`
	SessionID             string `json:"sessionId"`
	ControlPlaneRedeemURL string `json:"controlPlaneRedeemUrl"`
}

// ReadCapabilityFile reads and validates an owner-only launch capability.
func ReadCapabilityFile(path string) (CapabilityFile, error) {
	if path == "" {
		return CapabilityFile{}, errors.New("capability file path is required")
	}
	info, err := os.Stat(path)
	if err != nil {
		return CapabilityFile{}, fmt.Errorf("stat capability file: %w", err)
	}
	if info.Mode().Perm() != fs.FileMode(0o600) {
		return CapabilityFile{}, errors.New("capability file mode must be 0600")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return CapabilityFile{}, fmt.Errorf("read capability file: %w", err)
	}
	var cfg CapabilityFile
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return CapabilityFile{}, errors.New("decode capability file")
	}
	if cfg.SandboxID == "" || cfg.WorkspaceID == "" || cfg.SessionID == "" || cfg.ControlPlaneRedeemURL == "" {
		return CapabilityFile{}, errors.New("capability file is incomplete")
	}
	return cfg, nil
}
