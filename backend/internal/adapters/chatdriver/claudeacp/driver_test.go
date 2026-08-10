package claudeacp

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	acpdriver "github.com/aoagents/agent-orchestrator/backend/internal/adapters/chatdriver/acp"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestClaudeSessionMetaAppendsWithoutReplacingPreset(t *testing.T) {
	if got := claudeSessionMeta(acpdriver.LaunchConfig{}); got != nil {
		t.Fatalf("empty prompt metadata = %#v", got)
	}
	meta := claudeSessionMeta(acpdriver.LaunchConfig{SystemPrompt: "AO standing instructions"})
	prompt, ok := meta["systemPrompt"].(map[string]any)
	if !ok {
		t.Fatalf("systemPrompt = %#v", meta["systemPrompt"])
	}
	if prompt["type"] != "preset" || prompt["preset"] != "claude_code" || prompt["append"] != "AO standing instructions" {
		t.Fatalf("systemPrompt = %#v", prompt)
	}
}

func TestClaudeSessionModeUsesAdapterModeIDs(t *testing.T) {
	tests := map[ports.PermissionMode]string{
		ports.PermissionModeDefault:           "",
		ports.PermissionModeAcceptEdits:       "acceptEdits",
		ports.PermissionModeAuto:              "auto",
		ports.PermissionModeBypassPermissions: "bypassPermissions",
	}
	for permission, want := range tests {
		if got := claudeSessionMode(permission); got != want {
			t.Errorf("mode(%q) = %q, want %q", permission, got, want)
		}
	}
}

func TestClaudeSessionOptionsUseACPConfigIDs(t *testing.T) {
	got := claudeSessionOptions(ports.ChatTurnSettings{Model: "sonnet", Effort: "high"})
	want := []acpdriver.SessionOption{{ID: "model", Value: "sonnet"}, {ID: "effort", Value: "high"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("options = %#v, want %#v", got, want)
	}
}

func TestRuntimeCommandOverride(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("AO_CLAUDE_ACP_COMMAND", executable)
	launch, err := resolveRuntime(context.Background())
	if err != nil {
		t.Fatalf("resolveRuntime: %v", err)
	}
	if launch.command != executable || len(launch.args) != 0 {
		t.Fatalf("runtime = %#v", launch)
	}
}

// writeCmd writes a .cmd shim file in a temp dir and returns its path.
func writeCmd(t *testing.T, name, content string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return p
}

// resolveClaudeExe is Windows-gated (runtime.GOOS != "windows" → pass-through).
// Tests that depend on the .cmd branch still run on all platforms: the GOOS
// check inside resolveClaudeExe returns the input unchanged on non-Windows,
// which is the correct pass-through behavior. Windows-only branches (sibling
// .exe, quoted %dp0%) are exercised when the test binary runs on Windows; on
// other platforms the same cases assert the pass-through, so the suite stays
// green everywhere while covering the Windows paths when run there.

func TestResolveClaudeExePassThroughNonCmd(t *testing.T) {
	ctx := context.Background()
	if got := resolveClaudeExe(ctx, "/usr/local/bin/claude"); got != "/usr/local/bin/claude" {
		t.Errorf("non-.cmd path = %q, want pass-through", got)
	}
	if got := resolveClaudeExe(ctx, ""); got != "" {
		t.Errorf("empty path = %q, want pass-through", got)
	}
}

func TestResolveClaudeExeCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	// Even a .cmd path returns immediately when ctx is already cancelled.
	cmd := writeCmd(t, "claude.cmd", "@echo off\n")
	if got := resolveClaudeExe(ctx, cmd); got != cmd {
		t.Errorf("cancelled ctx = %q, want %q (pass-through)", got, cmd)
	}
}

func TestResolveClaudeExeMissingFile(t *testing.T) {
	ctx := context.Background()
	// A .cmd path that does not exist on disk returns the original path.
	missing := filepath.Join(t.TempDir(), "nonexistent.cmd")
	if got := resolveClaudeExe(ctx, missing); got != missing {
		t.Errorf("missing .cmd = %q, want %q (pass-through)", got, missing)
	}
}

func TestResolveClaudeExeSiblingExe(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("sibling .exe resolution is Windows-gated")
	}
	ctx := context.Background()
	dir := t.TempDir()
	cmdPath := filepath.Join(dir, "claude.cmd")
	if err := os.WriteFile(cmdPath, []byte("@echo off"), 0o644); err != nil {
		t.Fatal(err)
	}
	exePath := filepath.Join(dir, "claude.exe")
	if err := os.WriteFile(exePath, []byte("fake"), 0o755); err != nil {
		t.Fatal(err)
	}
	if got := resolveClaudeExe(ctx, cmdPath); got != exePath {
		t.Errorf("sibling .exe = %q, want %q", got, exePath)
	}
}

func TestResolveClaudeExeQuotedDp0Target(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("dp0 expansion is Windows-gated")
	}
	ctx := context.Background()
	dir := t.TempDir()
	// Simulate an npm .cmd shim that delegates to a nested .exe.
	targetExe := filepath.Join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
	if err := os.MkdirAll(filepath.Dir(targetExe), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetExe, []byte("fake"), 0o755); err != nil {
		t.Fatal(err)
	}
	cmdContent := "@echo off\n" +
		"\"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe\" %*\n"
	cmdPath := filepath.Join(dir, "claude.cmd")
	if err := os.WriteFile(cmdPath, []byte(cmdContent), 0o644); err != nil {
		t.Fatal(err)
	}
	got := resolveClaudeExe(ctx, cmdPath)
	want, _ := filepath.Abs(targetExe)
	if got != want {
		t.Errorf("quoted %%dp0%% target = %q, want %q", got, want)
	}
}

func TestResolveClaudeExeMalformedCmd(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("malformed .cmd fallback is Windows-gated")
	}
	ctx := context.Background()
	// A .cmd with no valid .exe reference falls through to the original path.
	cmdPath := writeCmd(t, "claude.cmd", "@echo off\nrem no exe here\n")
	if got := resolveClaudeExe(ctx, cmdPath); got != cmdPath {
		t.Errorf("malformed .cmd = %q, want %q (pass-through)", got, cmdPath)
	}
}

func TestResolveClaudeExeUnreadableCmd(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("unreadable .cmd fallback is Windows-gated")
	}
	ctx := context.Background()
	// A .cmd file that exists but cannot be read falls through to the original.
	cmdPath := writeCmd(t, "claude.cmd", "@echo off\n")
	// Remove read permission. On Windows this may not block os.ReadFile for
	// the owner, so the assertion tolerates either outcome: if the file is
	// still readable, resolveClaudeExe parses it and may find no .exe →
	// pass-through; if unreadable, it returns the original path. Either way
	// the result must be the original cmd path (no sibling .exe exists).
	if err := os.Chmod(cmdPath, 0o000); err != nil {
		t.Skipf("chmod unsupported: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(cmdPath, 0o644) })
	if got := resolveClaudeExe(ctx, cmdPath); got != cmdPath {
		t.Errorf("unreadable .cmd = %q, want %q (pass-through)", got, cmdPath)
	}
}
