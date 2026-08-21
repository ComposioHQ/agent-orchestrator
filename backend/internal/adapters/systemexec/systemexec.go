// Package systemexec adapts host PATH lookup and child-process execution to
// the narrow ports consumed by the system requirement/install services.
package systemexec

import (
	"context"
	"io"
	"os/exec"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Adapter implements the host executable and command-runner ports.
type Adapter struct{}

var (
	_ ports.ExecutableFinder = Adapter{}
	_ ports.CommandRunner    = Adapter{}
)

// LookPath resolves file against the daemon process PATH.
func (Adapter) LookPath(file string) (string, error) {
	return exec.LookPath(file)
}

// Run executes argv with ctx and connects its output to the supplied writers.
func (Adapter) Run(ctx context.Context, argv []string, stdout, stderr io.Writer) error {
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...) //nolint:gosec // G204: argv is built from systeminstall's fixed target allowlist.
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	return cmd.Run()
}
