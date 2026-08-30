package systemexec

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestRunInstallClosesStdinAndSetsControlledEnvironment(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	err := (Adapter{}).RunInstall(context.Background(), ports.InstallCommand{
		Argv: []string{"sh", "-c", `if IFS= read -r value; then echo "stdin:$value"; else echo "stdin:eof"; fi; printf 'ci:%s noninteractive:%s' "$CI" "$NONINTERACTIVE"`},
		Env:  []string{"CI=1", "NONINTERACTIVE=1"},
	}, &output, &output)
	if err != nil {
		t.Fatalf("RunInstall: %v", err)
	}
	got := output.String()
	if !strings.Contains(got, "stdin:eof") || !strings.Contains(got, "ci:1 noninteractive:1") {
		t.Fatalf("output = %q, want closed stdin and controlled env", got)
	}
}

func TestPathWritableUsesEffectiveFilesystemPermissions(t *testing.T) {
	t.Parallel()
	adapter := Adapter{}
	writable := t.TempDir()
	if !adapter.PathWritable(writable) {
		t.Fatalf("PathWritable(%q) = false, want true", writable)
	}
	if adapter.PathWritable(writable+"/missing/child") != true {
		t.Fatalf("PathWritable should accept a missing destination below a writable ancestor")
	}
}
