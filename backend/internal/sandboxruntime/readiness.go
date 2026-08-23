package sandboxruntime

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

const DefaultReadyPath = "/run/ao/ready.json"

var readyPayload = []byte("{\"ready\":true}\n")

// PublishReady atomically creates a metadata-free, owner-only readiness
// signal. It contains no session, workspace, runtime, route, or provider data.
// The signal is private filesystem state, not a public /readyz response.
func PublishReady(path string) error {
	if !filepath.IsAbs(path) {
		return errors.New("sandbox ready file path must be absolute")
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create sandbox ready directory: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".ready-*")
	if err != nil {
		return fmt.Errorf("create sandbox ready file: %w", err)
	}
	temporaryPath := temporary.Name()
	removeTemporary := true
	defer func() {
		_ = temporary.Close()
		if removeTemporary {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return fmt.Errorf("secure sandbox ready file: %w", err)
	}
	if _, err := temporary.Write(readyPayload); err != nil {
		return fmt.Errorf("write sandbox ready file: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("sync sandbox ready file: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close sandbox ready file: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("publish sandbox ready file: %w", err)
	}
	removeTemporary = false
	return nil
}

// ClearReady removes the private signal during shutdown. A missing signal is
// already clear.
func ClearReady(path string) error {
	err := os.Remove(path)
	if err == nil || errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return fmt.Errorf("clear sandbox ready file: %w", err)
}
