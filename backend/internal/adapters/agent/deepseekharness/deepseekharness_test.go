package deepseekharness

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// writeFakeExecutable creates an executable file at path. On Unix a tiny shell
// script is sufficient; on Windows the test skips any binary-execution step
// because POSIX shims do not exist there.
func writeFakeExecutable(t *testing.T, path string, script string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake executable test is POSIX-only")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestManifestID(t *testing.T) {
	m := New().Manifest()
	if m.ID != "deepseek-harness" {
		t.Fatalf("manifest ID = %q, want %q", m.ID, "deepseek-harness")
	}
	if m.Name != "DeepSeek" {
		t.Fatalf("manifest Name = %q, want %q", m.Name, "DeepSeek")
	}
	if !strings.Contains(m.Description, "DeepSeek CLI") {
		t.Fatalf("manifest Description = %q, want it to mention DeepSeek CLI", m.Description)
	}
	hasAgent := false
	for _, c := range m.Capabilities {
		if c == adapters.CapabilityAgent {
			hasAgent = true
		}
	}
	if !hasAgent {
		t.Fatal("manifest missing CapabilityAgent")
	}
}

func TestLaunchCommand(t *testing.T) {
	tests := []struct {
		name        string
		prompt      string
		kind        domain.SessionKind
		want        []string
		wantErrText string
		wantErrIs   error
	}{
		{
			name:   "valid prompt",
			prompt: "write tests",
			want:   []string{"deepseek", "--prompt-interactive", "write tests"},
		},
		{
			name: "promptless orchestrator",
			kind: domain.KindOrchestrator,
			want: []string{"deepseek", "--prompt-interactive", "Start an AO orchestrator session for this workspace."},
		},
		{
			name:   "empty prompt opens interactive CLI",
			prompt: "",
			want:   []string{"deepseek"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := &Plugin{resolvedBinary: "deepseek"}
			cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
				Prompt: tt.prompt,
				Kind:   tt.kind,
			})
			if tt.wantErrText != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil (cmd=%#v)", tt.wantErrText, cmd)
				}
				if !strings.Contains(err.Error(), tt.wantErrText) {
					t.Fatalf("err = %v, want substring %q", err, tt.wantErrText)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(cmd, tt.want) {
				t.Fatalf("cmd = %#v, want %#v", cmd, tt.want)
			}
		})
	}
}

func TestLaunchCommandMissingBinary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("missing-binary test is POSIX-only")
	}
	if hasSystemDeepSeek(t) {
		t.Skip("a real deepseek exists at a UnixPath on this machine; cannot assert missing-binary behavior")
	}
	binDir := t.TempDir()
	t.Setenv("PATH", binDir)

	// Clear env-derived paths so the resolver does not find a system deepseek.
	t.Setenv("HOME", binDir)
	t.Setenv("USERPROFILE", binDir)
	t.Setenv("XDG_DATA_HOME", binDir)
	t.Setenv("APPDATA", binDir)
	t.Setenv("LOCALAPPDATA", binDir)
	t.Setenv("VOLTA_HOME", "")
	t.Setenv("FNM_DIR", "")

	// Hide any real nvm/fnm installs the test runner might have on disk.
	t.Setenv("NVM_DIR", binDir)

	p := &Plugin{}
	_, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{Prompt: "do the thing"})
	if err == nil {
		t.Fatal("expected error when deepseek binary is absent, got nil")
	}
	if !errors.Is(err, ports.ErrAgentBinaryNotFound) {
		t.Fatalf("err = %v, want ports.ErrAgentBinaryNotFound", err)
	}
}

func TestLaunchCommandIncludesModelOverride(t *testing.T) {
	p := &Plugin{resolvedBinary: "deepseek"}
	cmd, err := p.GetLaunchCommand(context.Background(), ports.LaunchConfig{
		Config: ports.AgentConfig{Model: "deepseek-chat"},
		Prompt: "write tests",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"deepseek", "--model", "deepseek-chat", "--prompt-interactive", "write tests"}
	if !reflect.DeepEqual(cmd, want) {
		t.Fatalf("cmd = %#v, want %#v", cmd, want)
	}
}

func TestPromptDeliveryStrategy(t *testing.T) {
	s, err := New().GetPromptDeliveryStrategy(context.Background(), ports.LaunchConfig{})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if s != ports.PromptDeliveryInCommand {
		t.Fatalf("strategy = %q, want %q", s, ports.PromptDeliveryInCommand)
	}
}

func TestRestoreCommand(t *testing.T) {
	p := &Plugin{}
	cmd, ok, err := p.GetRestoreCommand(context.Background(), ports.RestoreConfig{
		Session: ports.SessionRef{
			Metadata: map[string]string{ports.MetadataKeyAgentSessionID: "anything"},
		},
		Prompt: "more work",
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if ok {
		t.Fatalf("ok = true, want false (DeepSeek CLI resume is not wired)")
	}
	if cmd != nil {
		t.Fatalf("cmd = %#v, want nil", cmd)
	}
}

func TestSessionInfo(t *testing.T) {
	p := &Plugin{}
	info, ok, err := p.SessionInfo(context.Background(), ports.SessionRef{
		Metadata: map[string]string{
			ports.MetadataKeyAgentSessionID: "sess-1",
			"title":                         "hello",
			"summary":                       "world",
		},
	})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if !ok {
		t.Fatal("ok = false, want true with metadata")
	}
	if info.AgentSessionID != "sess-1" || info.Title != "hello" || info.Summary != "world" {
		t.Fatalf("SessionInfo = %#v, want populated fields", info)
	}

	// No metadata → ok=false (delegates to agentbase.StandardSessionInfo).
	if _, ok, err := p.SessionInfo(context.Background(), ports.SessionRef{}); err != nil {
		t.Fatalf("err: %v", err)
	} else if ok {
		t.Fatal("ok = true with empty metadata, want false")
	}
}

func TestBinaryResolution(t *testing.T) {
	binDir := t.TempDir()
	fake := filepath.Join(binDir, "deepseek")
	writeFakeExecutable(t, fake, "#!/bin/sh\nexit 0\n")

	t.Run("path hit", func(t *testing.T) {
		// Isolate PATH and home so the resolver finds only our fake deepseek.
		cleanEnv(t, binDir)
		t.Setenv("PATH", binDir)

		p := &Plugin{}
		got, err := p.ResolveBinary(context.Background())
		if err != nil {
			t.Fatalf("ResolveBinary err = %v", err)
		}
		if got != fake {
			t.Fatalf("ResolveBinary = %q, want %q", got, fake)
		}
	})

	t.Run("well-known path hit", func(t *testing.T) {
		if hasSystemDeepSeek(t) {
			t.Skip("a real deepseek exists at a UnixPath on this machine; UnixPaths win over UnixHomePaths")
		}
		// Use a fresh, deepseek-free PATH so the resolver falls through to the
		// well-known UnixHomePaths branch instead of finding the outer fake.
		pathDir := t.TempDir()
		cleanEnv(t, pathDir)
		t.Setenv("PATH", pathDir)

		home := t.TempDir()
		wellKnown := filepath.Join(home, ".npm-global", "bin", "deepseek")
		writeFakeExecutable(t, wellKnown, "#!/bin/sh\nexit 0\n")

		t.Setenv("HOME", home)
		t.Setenv("USERPROFILE", home)
		t.Setenv("XDG_DATA_HOME", home)

		p := &Plugin{}
		got, err := p.ResolveBinary(context.Background())
		if err != nil {
			t.Fatalf("ResolveBinary err = %v", err)
		}
		if got != wellKnown {
			t.Fatalf("ResolveBinary = %q, want %q", got, wellKnown)
		}
	})

	t.Run("missing binary", func(t *testing.T) {
		if hasSystemDeepSeek(t) {
			t.Skip("a real deepseek exists at a UnixPath on this machine; cannot assert missing-binary behavior")
		}
		emptyHome := t.TempDir()
		cleanEnv(t, emptyHome)
		t.Setenv("PATH", emptyHome)
		t.Setenv("HOME", emptyHome)
		t.Setenv("USERPROFILE", emptyHome)
		t.Setenv("XDG_DATA_HOME", emptyHome)

		p := &Plugin{}
		_, err := p.ResolveBinary(context.Background())
		if !errors.Is(err, ports.ErrAgentBinaryNotFound) {
			t.Fatalf("err = %v, want ports.ErrAgentBinaryNotFound", err)
		}
	})
}

func TestAuthStatus(t *testing.T) {
	t.Run("missing binary", func(t *testing.T) {
		if hasSystemDeepSeek(t) {
			t.Skip("a real deepseek exists at a UnixPath on this machine; cannot assert missing-binary behavior")
		}
		emptyHome := t.TempDir()
		cleanEnv(t, emptyHome)
		t.Setenv("PATH", emptyHome)
		t.Setenv("HOME", emptyHome)
		t.Setenv("USERPROFILE", emptyHome)
		t.Setenv("XDG_DATA_HOME", emptyHome)

		p := &Plugin{}
		got, err := p.AuthStatus(context.Background())
		if !errors.Is(err, ports.ErrAgentBinaryNotFound) {
			t.Fatalf("err = %v, want ports.ErrAgentBinaryNotFound", err)
		}
		if got != ports.AgentAuthStatusUnknown {
			t.Fatalf("AuthStatus = %q, want %q", got, ports.AgentAuthStatusUnknown)
		}
	})

	t.Run("binary present", func(t *testing.T) {
		binDir := t.TempDir()
		fake := filepath.Join(binDir, "deepseek")
		// deepseek --version exits 0; the probe only confirms runnability.
		writeFakeExecutable(t, fake, "#!/bin/sh\necho deepseek 1.1.1\nexit 0\n")

		cleanEnv(t, binDir)
		t.Setenv("PATH", binDir)
		t.Setenv("HOME", t.TempDir())
		t.Setenv("USERPROFILE", t.TempDir())

		p := &Plugin{}
		got, err := p.AuthStatus(context.Background())
		if err != nil {
			t.Fatalf("err = %v", err)
		}
		if got != ports.AgentAuthStatusUnknown {
			t.Fatalf("AuthStatus = %q, want %q", got, ports.AgentAuthStatusUnknown)
		}
	})
}

func TestResolveBinaryDelegatesToCachedPath(t *testing.T) {
	binDir := t.TempDir()
	fake := filepath.Join(binDir, "deepseek")
	writeFakeExecutable(t, fake, "#!/bin/sh\nexit 0\n")

	cleanEnv(t, binDir)
	t.Setenv("PATH", binDir)

	p := &Plugin{}

	// First call resolves and caches.
	if _, err := p.ResolveBinary(context.Background()); err != nil {
		t.Fatalf("ResolveBinary (first call) err = %v", err)
	}
	if p.resolvedBinary != fake {
		t.Fatalf("resolvedBinary = %q, want %q", p.resolvedBinary, fake)
	}

	// Second call must not re-resolve: prove it by sabotaging PATH and HOME
	// so a fresh search would fail.
	t.Setenv("PATH", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", t.TempDir())

	got, err := p.ResolveBinary(context.Background())
	if err != nil {
		t.Fatalf("ResolveBinary (cached) err = %v", err)
	}
	if got != fake {
		t.Fatalf("ResolveBinary (cached) = %q, want cached %q", got, fake)
	}
}

func TestExitDetectionUsesProcessSupervisor(t *testing.T) {
	if got := New().ExitDetectionMode(); got != ports.AgentExitDetectionSupervisor {
		t.Fatalf("ExitDetectionMode = %q, want %q", got, ports.AgentExitDetectionSupervisor)
	}
}

func TestGetConfigSpecReportsModel(t *testing.T) {
	spec, err := New().GetConfigSpec(context.Background())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(spec.Fields) != 1 {
		t.Fatalf("spec.Fields = %#v, want one model field", spec.Fields)
	}
	if field := spec.Fields[0]; field.Key != "model" || field.Type != ports.ConfigFieldString {
		t.Fatalf("field = %#v, want model string", field)
	}
}

func TestSuggestedInstallCommand(t *testing.T) {
	got := SuggestedInstallCommand()
	if got != "" {
		t.Fatalf("SuggestedInstallCommand = %q, want no recommendation", got)
	}
}

func TestContextCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if _, err := (&Plugin{}).GetConfigSpec(ctx); err == nil {
		t.Fatal("GetConfigSpec: expected error from cancelled context")
	}
	if _, err := (&Plugin{}).GetLaunchCommand(ctx, ports.LaunchConfig{Prompt: "x"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("GetLaunchCommand err = %v, want context.Canceled", err)
	}
	if _, _, err := (&Plugin{}).GetRestoreCommand(ctx, ports.RestoreConfig{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("GetRestoreCommand err = %v, want context.Canceled", err)
	}
	if _, _, err := (&Plugin{}).SessionInfo(ctx, ports.SessionRef{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("SessionInfo err = %v, want context.Canceled", err)
	}
	if _, err := (&Plugin{}).GetPromptDeliveryStrategy(ctx, ports.LaunchConfig{}); !errors.Is(err, context.Canceled) {
		t.Fatalf("GetPromptDeliveryStrategy err = %v, want context.Canceled", err)
	}
}

// cleanEnv removes env-derived hints the binaryutil resolver consults (nvm
// defaults, fnm defaults, etc.) so tests run against only the paths we
// explicitly set. Each call gets a fresh dir to redirect to.
func cleanEnv(t *testing.T, fallback string) {
	t.Helper()
	for _, name := range []string{
		"VOLTA_HOME",
		"FNM_DIR",
		"NVM_DIR",
		"XDG_DATA_HOME",
		"APPDATA",
		"LOCALAPPDATA",
	} {
		t.Setenv(name, fallback)
	}
}

// hasSystemDeepSeek returns true when a real `deepseek` executable lives at any of the
// absolute UnixPaths the resolver consults. Tests that need a deterministic
// "no binary on disk" environment skip themselves in that case.
func hasSystemDeepSeek(t *testing.T) bool {
	t.Helper()
	if runtime.GOOS == "windows" {
		return false
	}
	for _, p := range deepseekBinarySpec.UnixPaths {
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return true
		}
	}
	return false
}
