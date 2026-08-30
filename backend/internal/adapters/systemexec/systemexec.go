// Package systemexec adapts host PATH lookup and child-process execution to
// the narrow ports consumed by the system requirement/install services.
package systemexec

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Adapter implements the host executable and command-runner ports.
type Adapter struct{}

var (
	_ ports.ExecutableFinder       = Adapter{}
	_ ports.CommandRunner          = Adapter{}
	_ ports.InstallCommandRunner   = Adapter{}
	_ ports.InstallCapabilityProbe = Adapter{}
)

// LookPath resolves file against the daemon process PATH.
func (Adapter) LookPath(file string) (string, error) {
	return exec.LookPath(file)
}

// RunInstall executes a server-owned installer command without interactive
// stdin. The small Env list augments the daemon environment rather than
// replacing PATH and the user's package-manager configuration.
func (Adapter) RunInstall(ctx context.Context, command ports.InstallCommand, stdout, stderr io.Writer) error {
	cmd := exec.CommandContext(ctx, command.Argv[0], command.Argv[1:]...) //nolint:gosec // G204: argv is selected from systeminstall's fixed recipes.
	configureProcessGroup(cmd)
	cmd.Cancel = func() error { return killProcessTree(cmd) }
	cmd.WaitDelay = 5 * time.Second
	cmd.Stdin = strings.NewReader("")
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	cmd.Env = append(os.Environ(), command.Env...)
	return cmd.Run()
}

// NPMGlobalPrefix asks npm for the actual global prefix under a short bound;
// locating the npm executable alone says nothing about whether `npm -g` can
// write where it needs to.
func (Adapter) NPMGlobalPrefix() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "npm", "prefix", "-g").Output() //nolint:gosec // fixed read-only argv
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// HomebrewPrefix resolves the installation root whose ownership determines
// whether Homebrew can install without privilege escalation.
func (Adapter) HomebrewPrefix() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "brew", "--prefix").Output() //nolint:gosec // fixed read-only argv
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

// HomebrewPackageInstalled distinguishes a first install from an explicit
// reinstall without mutating package-manager state.
func (Adapter) HomebrewPackageInstalled(name string, cask bool) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	args := []string{"list", "--versions"}
	if cask {
		args = append(args, "--cask")
	}
	args = append(args, name)
	return exec.CommandContext(ctx, "brew", args...).Run() == nil //nolint:gosec // name comes from fixed server-owned recipes.
}

// PathWritable checks the nearest existing ancestor by creating and removing
// a private temporary file. This honors ACLs and ownership more accurately
// than permission-bit inspection.
func (Adapter) PathWritable(path string) bool {
	for {
		if _, err := os.Stat(path); err == nil {
			file, createErr := os.CreateTemp(path, ".ao-write-check-*")
			if createErr != nil {
				return false
			}
			name := file.Name()
			closeErr := file.Close()
			removeErr := os.Remove(name)
			return closeErr == nil && removeErr == nil
		} else if !os.IsNotExist(err) {
			return false
		}
		parent := filepath.Dir(path)
		if parent == path {
			return false
		}
		path = parent
	}
}

// Run executes argv with ctx and connects its output to the supplied writers.
func (Adapter) Run(ctx context.Context, argv []string, stdout, stderr io.Writer) error {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...) //nolint:gosec // G204: argv is built from systeminstall's fixed target allowlist.
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	return cmd.Run()
}
