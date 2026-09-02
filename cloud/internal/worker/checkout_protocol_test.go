package worker

import (
	"context"
	"os/exec"
	"strings"
	"testing"
)

// TestExecGitRunnerForcesProtocolV0 verifies every git invocation pins wire
// protocol v0. Protocol v2 over HTTP/2 fails through some sandbox egress paths
// and crash-loops checkout, so the runner must override it on the command line
// (which config lookups honor).
func TestExecGitRunnerForcesProtocolV0(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git is not available")
	}
	out, err := ExecGitRunner{}.Run(
		context.Background(), t.TempDir(), nil, "config", "--get", "protocol.version",
	)
	if err != nil {
		t.Fatalf("run git config: %v", err)
	}
	if got := strings.TrimSpace(out); got != "0" {
		t.Fatalf("protocol.version = %q, want 0", got)
	}
}
