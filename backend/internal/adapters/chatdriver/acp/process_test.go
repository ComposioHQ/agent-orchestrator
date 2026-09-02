package acp

import (
	"fmt"
	"runtime"
	"strings"
	"testing"
)

// A runtime that dies before answering the ACP handshake reports the reason on
// stderr and nowhere else. Discarding it reduced an aborting Node runtime to
// "peer disconnected before response" (#4442).
func TestSpawnAgentRetainsStderrTail(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses a POSIX shell to script the failure")
	}
	proc, err := spawnAgent(Launch{
		Command: "sh",
		Args:    []string{"-c", "echo 'fatal: v8 SetPermissions' >&2; exit 133"},
	}, t.TempDir())
	if err != nil {
		t.Fatalf("spawnAgent: %v", err)
	}
	t.Cleanup(func() { _ = proc.stop() })

	if tail := proc.stderrSnapshot(); !strings.Contains(tail, "fatal: v8 SetPermissions") {
		t.Fatalf("stderr tail = %q, want it to carry the adapter's fatal message", tail)
	}
}

// Draining must still be unbounded so a chatty adapter cannot fill its OS pipe
// and deadlock the protocol; only what is retained is capped.
func TestTailBufferRetainsLastBytesOnly(t *testing.T) {
	tail := &tailBuffer{}
	if _, err := fmt.Fprint(tail, strings.Repeat("a", stderrTailLimit)); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := fmt.Fprint(tail, "TRAILING"); err != nil {
		t.Fatalf("write: %v", err)
	}

	got := tail.String()
	if len(got) != stderrTailLimit {
		t.Fatalf("len = %d, want %d", len(got), stderrTailLimit)
	}
	if !strings.HasSuffix(got, "TRAILING") {
		t.Fatalf("tail lost the most recent output: %q", got[len(got)-32:])
	}
}

func TestFormatStderrTail(t *testing.T) {
	if got := formatStderrTail("   \n  "); got != "" {
		t.Fatalf("blank stderr = %q, want no suffix", got)
	}

	lines := make([]string, 0, stderrTailLines+5)
	for i := range stderrTailLines + 5 {
		lines = append(lines, fmt.Sprintf("frame %d", i))
	}
	got := formatStderrTail(strings.Join(lines, "\n"))

	if strings.Contains(got, "frame 0") {
		t.Fatalf("expected the oldest frames to be dropped, got %q", got)
	}
	if !strings.Contains(got, fmt.Sprintf("frame %d", stderrTailLines+4)) {
		t.Fatalf("expected the newest frame to survive, got %q", got)
	}
	if want := stderrTailLines - 1; strings.Count(got, "; ") != want {
		t.Fatalf("joined %d separators, want %d: %q", strings.Count(got, "; "), want, got)
	}
}
