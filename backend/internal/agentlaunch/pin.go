package agentlaunch

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

var pinMu sync.Mutex

// pinDirectory uses the install directory only when it contains no sibling
// executables. Shared installs get a shim so pinning ao cannot promote node,
// git, or other tools ahead of the agent's selected runtime.
func pinDirectory(exe string) (string, error) {
	dir := pinnedDirForExecutable(exe)
	if dir == "" {
		return "", nil
	}
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return dir, nil
	}
	if err != nil {
		return "", fmt.Errorf("inspect AO install directory: %w", err)
	}
	shared := false
	for _, entry := range entries {
		if entry.Name() == filepath.Base(exe) || entry.IsDir() {
			continue
		}
		info, statErr := os.Stat(filepath.Join(dir, entry.Name()))
		if statErr != nil {
			continue
		}
		if !info.Mode().IsRegular() {
			continue
		}
		if runtime.GOOS == "windows" {
			switch strings.ToLower(filepath.Ext(entry.Name())) {
			case ".exe", ".com", ".cmd", ".bat":
				shared = true
			}
		} else if info.Mode()&0o111 != 0 {
			shared = true
		}
	}
	if !shared {
		return dir, nil
	}
	dataDir := os.Getenv("AO_DATA_DIR")
	if dataDir == "" {
		home, homeErr := os.UserHomeDir()
		if homeErr != nil {
			return "", homeErr
		}
		dataDir = filepath.Join(home, ".ao")
	}
	absolute, err := filepath.Abs(exe)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256([]byte(absolute))
	shimDir := filepath.Join(dataDir, "runtime", "ao-path", fmt.Sprintf("%x", sum[:16]))
	name := "ao"
	script := "#!/bin/sh\nexec '" + strings.ReplaceAll(absolute, "'", `'"'"'`) + "' \"$@\"\n"
	if runtime.GOOS == "windows" {
		name = "ao.cmd"
		script = "@echo off\r\n\"" + strings.ReplaceAll(absolute, "%", "%%") + "\" %*\r\n"
	}
	pinMu.Lock()
	defer pinMu.Unlock()
	if err := os.MkdirAll(shimDir, 0o700); err != nil {
		return "", err
	}
	target := filepath.Join(shimDir, name)
	if content, err := os.ReadFile(target); err == nil && string(content) == script {
		return shimDir, nil
	}
	temp, err := os.CreateTemp(shimDir, ".ao-*")
	if err != nil {
		return "", err
	}
	tempPath := temp.Name()
	defer func() { _ = os.Remove(tempPath) }()
	if _, err := temp.WriteString(script); err != nil {
		_ = temp.Close()
		return "", err
	}
	if err := temp.Close(); err != nil {
		return "", err
	}
	if err := os.Chmod(tempPath, 0o700); err != nil {
		return "", err
	} //nolint:gosec // executable AO shim
	if err := os.Rename(tempPath, target); err != nil {
		return "", err
	}
	return shimDir, nil
}
