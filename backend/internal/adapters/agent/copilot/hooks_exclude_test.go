package copilot

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func gitRepoWithExclude(t *testing.T, existing string) string {
	t.Helper()
	ws := t.TempDir()
	info := filepath.Join(ws, ".git", "info")
	if err := os.MkdirAll(info, 0o750); err != nil {
		t.Fatal(err)
	}
	if existing != "" {
		if err := os.WriteFile(filepath.Join(info, "exclude"), []byte(existing), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return ws
}

func readExclude(t *testing.T, ws string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(ws, ".git", "info", "exclude"))
	if err != nil {
		t.Fatalf("read exclude: %v", err)
	}
	return string(b)
}

// The profile filename carries the session id, so excluding the literal path
// added one line per session to the user's real repository and never removed
// any. One glob covers every session instead.
func TestIgnoreCopilotPathWritesOneGlobForAllSessions(t *testing.T) {
	ws := gitRepoWithExclude(t, "")
	for i := 0; i < 3; i++ {
		if err := ignoreCopilotPath(ws, copilotAgentExcludePattern); err != nil {
			t.Fatalf("ignoreCopilotPath: %v", err)
		}
	}
	got := readExclude(t, ws)
	if n := strings.Count(got, copilotAgentExcludePattern); n != 1 {
		t.Fatalf("pattern appears %d times, want exactly 1:\n%s", n, got)
	}
}

// Lines earlier versions wrote are superseded by the glob and must be cleaned
// up, or the leak simply stops growing instead of being repaired.
func TestIgnoreCopilotPathPrunesPerSessionLines(t *testing.T) {
	existing := "# user's own rules\n/build\n" +
		"# agent-orchestrator Copilot session files\n" +
		"/.github/agents/ao-work-1.agent.md\n" +
		"/.github/agents/ao-work-2.agent.md\n"
	ws := gitRepoWithExclude(t, existing)

	if err := ignoreCopilotPath(ws, copilotAgentExcludePattern); err != nil {
		t.Fatalf("ignoreCopilotPath: %v", err)
	}
	got := readExclude(t, ws)

	if strings.Contains(got, "ao-work-1.agent.md") || strings.Contains(got, "ao-work-2.agent.md") {
		t.Fatalf("per-session lines survived:\n%s", got)
	}
	if !strings.Contains(got, copilotAgentExcludePattern) {
		t.Fatalf("glob missing:\n%s", got)
	}
	// The user's own entries must never be touched.
	if !strings.Contains(got, "/build") || !strings.Contains(got, "# user's own rules") {
		t.Fatalf("user's own exclude entries were removed:\n%s", got)
	}
}
