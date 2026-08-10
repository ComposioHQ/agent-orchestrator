package systeminstall

import (
	"context"
	"errors"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// lookPathFound returns a lookPath fake that resolves only the names present
// in paths (defaulting each found name to "/usr/bin/<name>" when the map
// value is empty), and errors for everything else — mirroring the
// systemcheck test fake.
func lookPathFound(names ...string) func(string) (string, error) {
	set := make(map[string]bool, len(names))
	for _, n := range names {
		set[n] = true
	}
	return func(name string) (string, error) {
		if set[name] {
			return "/usr/bin/" + name, nil
		}
		return "", errors.New("exec: " + name + ": executable file not found in $PATH")
	}
}

func newTestService(goos string, found ...string) *Service {
	return &Service{
		jobs:     make(map[Target]*Job),
		lookPath: lookPathFound(found...),
		goos:     goos,
		commandFunc: func(argv []string) *exec.Cmd {
			return exec.Command(argv[0], argv[1:]...) //nolint:gosec // test-only, deterministic argv
		},
	}
}

func TestPlanFor(t *testing.T) {
	tests := []struct {
		name            string
		target          Target
		goos            string
		found           []string
		wantUnsupported bool
		wantReasonHas   string
		wantCommand     []string
	}{
		{
			name: "tmux windows is unsupported", target: TargetTmux, goos: "windows",
			wantUnsupported: true, wantReasonHas: "not required on Windows",
		},
		{
			name: "tmux darwin uses brew", target: TargetTmux, goos: "darwin", found: []string{"brew"},
			wantCommand: []string{"brew", "install", "tmux"},
		},
		{
			name: "tmux darwin without brew is unsupported", target: TargetTmux, goos: "darwin",
			wantUnsupported: true, wantReasonHas: "Homebrew was not found",
		},
		{
			name: "tmux linux apt-get", target: TargetTmux, goos: "linux", found: []string{"apt-get", "dnf"},
			wantCommand: []string{"apt-get", "install", "-y", "tmux"},
		},
		{
			name: "tmux linux dnf", target: TargetTmux, goos: "linux", found: []string{"dnf", "zypper"},
			wantCommand: []string{"dnf", "install", "-y", "tmux"},
		},
		{
			name: "tmux linux pacman", target: TargetTmux, goos: "linux", found: []string{"pacman"},
			wantCommand: []string{"pacman", "-S", "--noconfirm", "tmux"},
		},
		{
			name: "tmux linux zypper", target: TargetTmux, goos: "linux", found: []string{"zypper"},
			wantCommand: []string{"zypper", "install", "-y", "tmux"},
		},
		{
			name: "tmux linux no package manager is unsupported", target: TargetTmux, goos: "linux",
			wantUnsupported: true, wantReasonHas: "No supported Linux package manager",
		},
		{
			name: "gh windows uses winget", target: TargetGH, goos: "windows", found: []string{"winget"},
			wantCommand: []string{"winget", "install", "-e", "--id", "GitHub.cli"},
		},
		{
			name: "gh windows without winget is unsupported", target: TargetGH, goos: "windows",
			wantUnsupported: true, wantReasonHas: "winget was not found",
		},
		{
			name: "gh darwin uses brew", target: TargetGH, goos: "darwin", found: []string{"brew"},
			wantCommand: []string{"brew", "install", "gh"},
		},
		{
			name: "gh linux apt-get uses gh package", target: TargetGH, goos: "linux", found: []string{"apt-get"},
			wantCommand: []string{"apt-get", "install", "-y", "gh"},
		},
		{
			name: "gh linux pacman uses github-cli package", target: TargetGH, goos: "linux", found: []string{"pacman"},
			wantCommand: []string{"pacman", "-S", "--noconfirm", "github-cli"},
		},
		{
			name: "claude uses npm on every platform", target: TargetClaude, goos: "darwin", found: []string{"npm"},
			wantCommand: []string{"npm", "install", "-g", "@anthropic-ai/claude-code"},
		},
		{
			name: "codex without npm is unsupported", target: TargetCodex, goos: "linux",
			wantUnsupported: true, wantReasonHas: "npm was not found",
		},
		{
			name: "copilot uses npm", target: TargetCopilot, goos: "windows", found: []string{"npm"},
			wantCommand: []string{"npm", "install", "-g", "@github/copilot"},
		},
		{
			name: "opencode windows uses winget", target: TargetOpencode, goos: "windows", found: []string{"winget"},
			wantCommand: []string{"winget", "install", "-e", "--id", "SST.opencode"},
		},
		{
			name: "opencode darwin uses the curl pipeline", target: TargetOpencode, goos: "darwin", found: []string{"curl", "bash"},
			wantCommand: []string{"sh", "-c", "curl -fsSL https://opencode.ai/install | bash"},
		},
		{
			name: "opencode linux accepts sh when bash is absent", target: TargetOpencode, goos: "linux", found: []string{"curl", "sh"},
			wantCommand: []string{"sh", "-c", "curl -fsSL https://opencode.ai/install | bash"},
		},
		{
			name: "opencode without curl is unsupported", target: TargetOpencode, goos: "linux", found: []string{"bash"},
			wantUnsupported: true, wantReasonHas: "curl was not found",
		},
		{
			name: "opencode without bash or sh is unsupported", target: TargetOpencode, goos: "linux", found: []string{"curl"},
			wantUnsupported: true, wantReasonHas: "bash or sh was not found",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestService(tt.goos, tt.found...)
			plan := s.planFor(tt.target)
			if plan.Target != tt.target {
				t.Fatalf("Target = %q, want %q", plan.Target, tt.target)
			}
			if plan.Unsupported != tt.wantUnsupported {
				t.Fatalf("Unsupported = %v, want %v (reason=%q)", plan.Unsupported, tt.wantUnsupported, plan.Reason)
			}
			if tt.wantReasonHas != "" && !strings.Contains(plan.Reason, tt.wantReasonHas) {
				t.Fatalf("Reason = %q, want substring %q", plan.Reason, tt.wantReasonHas)
			}
			if tt.wantCommand != nil {
				if strings.Join(plan.Command, " ") != strings.Join(tt.wantCommand, " ") {
					t.Fatalf("Command = %v, want %v", plan.Command, tt.wantCommand)
				}
			}
		})
	}
}

func TestValid(t *testing.T) {
	for _, target := range []Target{TargetTmux, TargetGH, TargetClaude, TargetCodex, TargetOpencode, TargetCopilot} {
		if !Valid(target) {
			t.Errorf("Valid(%q) = false, want true", target)
		}
	}
	for _, target := range []Target{"", "rm -rf /", "../../etc/passwd", "TMUX", "tmux "} {
		if Valid(target) {
			t.Errorf("Valid(%q) = true, want false", target)
		}
	}
}

func TestStartAndStatus_Succeeded(t *testing.T) {
	s := newTestService("darwin", "brew")
	s.commandFunc = func([]string) *exec.Cmd { return exec.Command("true") }

	job, err := s.Start(context.Background(), TargetTmux)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if job.Status != StatusRunning {
		t.Fatalf("Status = %q, want %q", job.Status, StatusRunning)
	}
	if job.Command != "brew install tmux" {
		t.Fatalf("Command = %q, want %q", job.Command, "brew install tmux")
	}

	waitForStatus(t, s, TargetTmux, StatusSucceeded)

	final, err := s.Status(TargetTmux)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if final.Error != "" {
		t.Fatalf("Error = %q, want empty", final.Error)
	}
	if final.FinishedAt.IsZero() {
		t.Fatalf("FinishedAt is zero, want set")
	}
}

func TestStartAndStatus_Failed(t *testing.T) {
	s := newTestService("darwin", "brew")
	s.commandFunc = func([]string) *exec.Cmd { return exec.Command("false") }

	if _, err := s.Start(context.Background(), TargetTmux); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	waitForStatus(t, s, TargetTmux, StatusFailed)

	final, _ := s.Status(TargetTmux)
	if final.Error == "" {
		t.Fatalf("Error is empty, want the exec failure")
	}
}

func TestStart_Unsupported(t *testing.T) {
	s := newTestService("windows") // no winget on PATH

	job, err := s.Start(context.Background(), TargetTmux)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if job.Status != StatusUnsupported {
		t.Fatalf("Status = %q, want %q", job.Status, StatusUnsupported)
	}
	if job.Error == "" {
		t.Fatalf("Error is empty, want the Unsupported reason")
	}
	if job.FinishedAt.IsZero() {
		t.Fatalf("FinishedAt is zero, want set immediately for an Unsupported job")
	}
}

func TestStart_UnknownTarget(t *testing.T) {
	s := newTestService("darwin")
	if _, err := s.Start(context.Background(), Target("bogus")); err == nil {
		t.Fatalf("Start(bogus) error = nil, want an error")
	}
}

func TestStatus_UnknownTarget(t *testing.T) {
	s := newTestService("darwin")
	if _, err := s.Status(Target("bogus")); err == nil {
		t.Fatalf("Status(bogus) error = nil, want an error")
	}
}

func TestStatus_NeverStartedIsIdle(t *testing.T) {
	s := newTestService("darwin")
	job, err := s.Status(TargetGH)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if job.Status != StatusIdle {
		t.Fatalf("Status = %q, want %q", job.Status, StatusIdle)
	}
	if job.Target != TargetGH {
		t.Fatalf("Target = %q, want %q", job.Target, TargetGH)
	}
}

// TestStart_IdempotentWhileRunning gates the fake install on a channel so the
// test controls exactly when it finishes, then fires two concurrent Starts
// and confirms neither one starts a second run.
func TestStart_IdempotentWhileRunning(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{}, 2)

	s := newTestService("darwin", "brew")
	callCount := 0
	s.commandFunc = func([]string) *exec.Cmd {
		callCount++
		started <- struct{}{}
		<-release
		return exec.Command("true")
	}

	first, err := s.Start(context.Background(), TargetTmux)
	if err != nil {
		t.Fatalf("first Start() error = %v", err)
	}
	if first.Status != StatusRunning {
		t.Fatalf("first Status = %q, want %q", first.Status, StatusRunning)
	}

	<-started // the background goroutine has begun (and is blocked on release)

	second, err := s.Start(context.Background(), TargetTmux)
	if err != nil {
		t.Fatalf("second Start() error = %v", err)
	}
	if second.Status != StatusRunning {
		t.Fatalf("second Status = %q, want %q", second.Status, StatusRunning)
	}

	close(release)
	waitForStatus(t, s, TargetTmux, StatusSucceeded)

	if callCount != 1 {
		t.Fatalf("commandFunc called %d times, want 1 (Start must be idempotent while running)", callCount)
	}
}

func waitForStatus(t *testing.T, s *Service, target Target, want Status) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		job, err := s.Status(target)
		if err != nil {
			t.Fatalf("Status() error = %v", err)
		}
		if job.Status == want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s to reach status %q", target, want)
}
