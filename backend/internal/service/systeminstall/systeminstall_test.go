package systeminstall

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type commandRunnerFunc func(context.Context, []string, io.Writer, io.Writer) error

func (f commandRunnerFunc) Run(ctx context.Context, argv []string, stdout, stderr io.Writer) error {
	return f(ctx, argv, stdout, stderr)
}

func testCommandRunner(command func(context.Context, []string) *exec.Cmd) commandRunnerFunc {
	return func(ctx context.Context, argv []string, stdout, stderr io.Writer) error {
		cmd := command(ctx, argv)
		cmd.Stdout = stdout
		cmd.Stderr = stderr
		return cmd.Run()
	}
}

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
		jobs:        make(map[Target]*Job),
		executables: executableFinderFunc(lookPathFound(found...)),
		commands: testCommandRunner(func(ctx context.Context, argv []string) *exec.Cmd {
			return exec.CommandContext(ctx, argv[0], argv[1:]...) //nolint:gosec // test-only, deterministic argv
		}),
		goos:           goos,
		installTimeout: 2 * time.Second,
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
			name: "tmux linux apt-get is unsupported with instructions", target: TargetTmux, goos: "linux", found: []string{"apt-get", "dnf"},
			wantUnsupported: true, wantReasonHas: "administrator password",
		},
		{
			name: "tmux linux dnf is unsupported with instructions", target: TargetTmux, goos: "linux", found: []string{"dnf", "zypper"},
			wantUnsupported: true, wantReasonHas: "administrator password",
		},
		{
			name: "tmux linux pacman is unsupported with instructions", target: TargetTmux, goos: "linux", found: []string{"pacman"},
			wantUnsupported: true, wantReasonHas: "administrator password",
		},
		{
			name: "tmux linux zypper is unsupported with instructions", target: TargetTmux, goos: "linux", found: []string{"zypper"},
			wantUnsupported: true, wantReasonHas: "administrator password",
		},
		{
			name: "tmux linux no package manager is unsupported", target: TargetTmux, goos: "linux",
			wantUnsupported: true, wantReasonHas: "No supported Linux package manager",
		},
		{
			name: "gh windows uses pinned winget source", target: TargetGH, goos: "windows", found: []string{"winget"},
			wantCommand: []string{
				"winget", "install", "-e", "--id", "GitHub.cli",
				"--source", "winget",
				"--accept-package-agreements",
				"--accept-source-agreements",
			},
		},
		{
			// gh without winget no longer dead-ends as Unsupported; the
			// direct-download fallback is covered in detail by
			// TestGHWindowsFallsBackToDirectDownload below.
			name: "gh windows without winget still resolves a runnable plan", target: TargetGH, goos: "windows",
			wantCommand: nil,
		},
		{
			name: "gh darwin uses brew", target: TargetGH, goos: "darwin", found: []string{"brew"},
			wantCommand: []string{"brew", "install", "gh"},
		},
		{
			name: "gh linux apt-get is unsupported with instructions for the gh package", target: TargetGH, goos: "linux", found: []string{"apt-get"},
			wantUnsupported: true, wantReasonHas: "administrator password",
		},
		{
			name: "gh linux pacman is unsupported with instructions for the github-cli package", target: TargetGH, goos: "linux", found: []string{"pacman"},
			wantUnsupported: true, wantReasonHas: "administrator password",
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
			name: "opencode windows uses pinned winget source", target: TargetOpencode, goos: "windows", found: []string{"winget"},
			wantCommand: []string{
				"winget", "install", "-e", "--id", "SST.opencode",
				"--source", "winget",
				"--accept-package-agreements",
				"--accept-source-agreements",
			},
		},
		{
			// The direct-download fallback is gh-only: opencode on Windows
			// still requires winget, so a missing winget must stay Unsupported
			// with the manual remedy rather than silently changing install
			// routes for this target.
			name: "opencode windows without winget is unsupported", target: TargetOpencode, goos: "windows",
			wantUnsupported: true, wantReasonHas: "winget was not found",
		},
		{
			name: "opencode darwin uses the curl pipeline via bash", target: TargetOpencode, goos: "darwin", found: []string{"curl", "bash"},
			wantCommand: []string{"bash", "-c", "curl -fsSL https://opencode.ai/install | bash"},
		},
		{
			name: "opencode without curl is unsupported", target: TargetOpencode, goos: "linux", found: []string{"bash"},
			wantUnsupported: true, wantReasonHas: "curl was not found",
		},
		{
			// sh alone must NOT satisfy this: the command always pipes into
			// bash, so a machine with sh but no bash would still fail at the
			// pipe if this were accepted.
			name: "opencode without bash is unsupported even if sh is present", target: TargetOpencode, goos: "linux", found: []string{"curl", "sh"},
			wantUnsupported: true, wantReasonHas: "bash was not found",
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

// TestGHWindowsFallsBackToDirectDownload pins the shape of the no-winget gh
// plan: a hardcoded, fully non-interactive PowerShell run that downloads the
// official windows_amd64 zip from cli/cli GitHub Releases and copies
// bin\*.exe into %LOCALAPPDATA%\Microsoft\WindowsApps — on the default
// per-user PATH, so the post-run LookPath verification succeeds without
// registry edits or shell restarts (#4449).
func TestGHWindowsFallsBackToDirectDownload(t *testing.T) {
	plan := newTestService("windows").planFor(TargetGH)
	if plan.Unsupported {
		t.Fatalf("Unsupported = true, want a runnable fallback plan (reason=%q)", plan.Reason)
	}
	if got := strings.Join(plan.Command, " "); !strings.HasPrefix(got, "powershell -NoProfile -NonInteractive") {
		t.Fatalf("Command = %v, want a non-interactive powershell invocation", plan.Command)
	}
	script := plan.Command[len(plan.Command)-1]
	for _, want := range []string{
		"https://api.github.com/repos/cli/cli/releases/latest",
		"gh_*_windows_amd64.zip",
		"Microsoft\\WindowsApps",
		// The User-scope Path can be unset on a fresh/stripped profile, so the
		// script must coalesce it to '' before appending, or the fallback
		// throws after gh.exe was already copied (#4449 review).
		"$userPath = ''",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("download script missing %q:\n%s", want, script)
		}
	}
	// The plan must record the exact binary it installs so run() can confirm
	// success even when the destination isn't on the daemon's PATH (#4449).
	if plan.InstalledBinaryPath == "" {
		t.Fatal("InstalledBinaryPath is empty, want the concrete gh.exe path")
	}
	if !strings.Contains(plan.InstalledBinaryPath, "WindowsApps") || !strings.HasSuffix(plan.InstalledBinaryPath, "gh.exe") {
		t.Fatalf("InstalledBinaryPath = %q, want a WindowsApps/gh.exe path", plan.InstalledBinaryPath)
	}
}

// TestRun_SucceedsWhenInstalledBinaryRuns covers the reviewer concern from
// #4449: merely existing on disk is not enough — run() must confirm the
// installed binary actually executes, and register its directory on the current
// process PATH so child shells spawned from this already-running daemon inherit
// it, before reporting success.
func TestRun_SucceedsWhenInstalledBinaryRuns(t *testing.T) {
	s := newTestService("windows") // no winget -> gh resolves to the direct-download fallback
	plan := s.planFor(TargetGH)
	if plan.Unsupported {
		t.Fatalf("Unsupported = true, want the download fallback plan")
	}
	if plan.InstalledBinaryPath == "" {
		t.Fatal("InstalledBinaryPath is empty, want the concrete gh.exe path for the fallback")
	}
	binPath := filepath.Join(t.TempDir(), "gh.exe")
	if err := os.WriteFile(binPath, []byte("fake"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	plan.InstalledBinaryPath = binPath

	var ran [][]string
	s.commands = commandRunnerFunc(func(_ context.Context, argv []string, _, _ io.Writer) error {
		ran = append(ran, argv)
		return nil // install script and the version probe both "succeed"
	})
	origPath := os.Getenv("PATH")
	defer os.Setenv("PATH", origPath)

	job := &Job{Target: TargetGH}
	s.run(plan, job)
	if job.Status != StatusSucceeded {
		t.Fatalf("Status = %q, want %q (error=%q)", job.Status, StatusSucceeded, job.Error)
	}
	if len(ran) != 2 {
		t.Fatalf("commands run = %d (%v), want 2 (install then version probe)", len(ran), ran)
	}
	probe := ran[len(ran)-1]
	if probe[0] != binPath || len(probe) != 2 || probe[1] != "--version" {
		t.Fatalf("probe argv = %v, want [%s --version]", probe, binPath)
	}
	if !strings.Contains(os.Getenv("PATH"), filepath.Dir(binPath)) {
		t.Fatalf("PATH = %q, want it to include %s for child processes spawned from this daemon", os.Getenv("PATH"), filepath.Dir(binPath))
	}
}

// TestRun_FailsWhenInstalledBinaryCannotRun confirms that if neither PATH nor a
// runnable installed binary yields the tool, the job is reported failed (and
// the error names the missing binary so the user sees what went wrong).
func TestRun_FailsWhenInstalledBinaryCannotRun(t *testing.T) {
	s := newTestService("windows")
	plan := s.planFor(TargetGH)
	if plan.InstalledBinaryPath == "" {
		t.Fatal("want InstalledBinaryPath set by the fallback")
	}
	missing := filepath.Join(t.TempDir(), "does-not-exist-gh.exe")
	plan.InstalledBinaryPath = missing

	s.commands = commandRunnerFunc(func(_ context.Context, argv []string, _, _ io.Writer) error {
		if argv[0] == plan.Command[0] {
			return nil // install script succeeds
		}
		return errors.New("exec: no such file or directory") // version probe of the missing binary fails
	})
	origPath := os.Getenv("PATH")
	defer os.Setenv("PATH", origPath)

	job := &Job{Target: TargetGH}
	s.run(plan, job)
	if job.Status != StatusFailed {
		t.Fatalf("Status = %q, want %q", job.Status, StatusFailed)
	}
	if !strings.Contains(job.Error, missing) {
		t.Fatalf("Error = %q, want it to name the missing binary path", job.Error)
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
	s := newTestService("darwin", "brew", "tmux")
	s.commands = testCommandRunner(func(context.Context, []string) *exec.Cmd { return exec.Command("true") })

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

	final, err := s.Status(context.Background(), TargetTmux)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if final.Error != "" {
		t.Fatalf("Error = %q, want empty", final.Error)
	}
	if final.FinishedAt == nil {
		t.Fatalf("FinishedAt is nil, want set")
	}
}

func TestStart_ExitZeroWithoutTargetOnPATHFails(t *testing.T) {
	s := newTestService("darwin", "brew")
	s.commands = testCommandRunner(func(context.Context, []string) *exec.Cmd { return exec.Command("true") })

	if _, err := s.Start(context.Background(), TargetTmux); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	waitForStatus(t, s, TargetTmux, StatusFailed)

	final, err := s.Status(context.Background(), TargetTmux)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if !strings.Contains(final.Error, "tmux is still not in PATH") {
		t.Fatalf("Error = %q, want failed PATH verification", final.Error)
	}
}

func TestStartAndStatus_Failed(t *testing.T) {
	s := newTestService("darwin", "brew")
	s.commands = testCommandRunner(func(context.Context, []string) *exec.Cmd { return exec.Command("false") })

	if _, err := s.Start(context.Background(), TargetTmux); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	waitForStatus(t, s, TargetTmux, StatusFailed)

	final, _ := s.Status(context.Background(), TargetTmux)
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
	if job.FinishedAt == nil {
		t.Fatalf("FinishedAt is nil, want set immediately for an Unsupported job")
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
	if _, err := s.Status(context.Background(), Target("bogus")); err == nil {
		t.Fatalf("Status(bogus) error = nil, want an error")
	}
}

func TestStatus_NeverStartedIsIdle(t *testing.T) {
	s := newTestService("darwin", "brew")
	job, err := s.Status(context.Background(), TargetGH)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if job.Status != StatusIdle {
		t.Fatalf("Status = %q, want %q", job.Status, StatusIdle)
	}
	if job.Target != TargetGH {
		t.Fatalf("Target = %q, want %q", job.Target, TargetGH)
	}
	if job.Command != "brew install gh" {
		t.Fatalf("Command = %q, want install preview", job.Command)
	}
}

func TestStatus_LinuxReturnsManualCommandBeforeStart(t *testing.T) {
	s := newTestService("linux", "apt-get")
	job, err := s.Status(context.Background(), TargetTmux)
	if err != nil {
		t.Fatalf("Status() error = %v", err)
	}
	if job.Status != StatusUnsupported {
		t.Fatalf("Status = %q, want %q", job.Status, StatusUnsupported)
	}
	if job.Command != "sudo apt-get install -y tmux" {
		t.Fatalf("Command = %q, want exact sudo command", job.Command)
	}
}

// TestStart_IdempotentWhileRunning gates the fake install on a channel so the
// test controls exactly when it finishes, then fires two concurrent Starts
// and confirms neither one starts a second run.
func TestStart_IdempotentWhileRunning(t *testing.T) {
	release := make(chan struct{})
	started := make(chan struct{}, 2)

	s := newTestService("darwin", "brew", "tmux")
	callCount := 0
	s.commands = testCommandRunner(func(context.Context, []string) *exec.Cmd {
		callCount++
		started <- struct{}{}
		<-release
		return exec.Command("true")
	})

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
		t.Fatalf("command runner called %d times, want 1 (Start must be idempotent while running)", callCount)
	}
}

// TestRun_Timeout confirms a stalled installer eventually surfaces as a
// failure instead of pinning its target in StatusRunning forever. The fake
// command actually respects ctx (exec.CommandContext, same as real installs),
// so the short installTimeout below kills it well before the real 5s sleep
// would return on its own.
func TestRun_Timeout(t *testing.T) {
	s := newTestService("darwin", "brew")
	s.installTimeout = 50 * time.Millisecond
	s.commands = testCommandRunner(func(ctx context.Context, _ []string) *exec.Cmd {
		return exec.CommandContext(ctx, "sleep", "5") //nolint:gosec // test-only, fixed argv
	})

	if _, err := s.Start(context.Background(), TargetTmux); err != nil {
		t.Fatalf("Start() error = %v", err)
	}

	waitForStatus(t, s, TargetTmux, StatusFailed)

	final, _ := s.Status(context.Background(), TargetTmux)
	if !strings.Contains(final.Error, "timed out") {
		t.Fatalf("Error = %q, want it to mention the timeout", final.Error)
	}
	if final.FinishedAt == nil {
		t.Fatalf("FinishedAt is nil, want set")
	}
}

func waitForStatus(t *testing.T, s *Service, target Target, want Status) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		job, err := s.Status(context.Background(), target)
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

// A Linux package-manager plan must now carry the resolved argv even though it
// stays Unsupported. That pairing is the whole point of the split: the daemon
// refuses to elevate, while the CLI (which has a terminal and can prompt for a
// sudo password) runs the very same command. Before this, the argv existed only
// inside the Reason string, so the CLI had to re-derive it and the two surfaces
// could drift.
func TestLinuxPlanExposesArgvWhileStayingUnsupported(t *testing.T) {
	for _, tt := range []struct {
		name        string
		found       string
		wantCommand string
		wantManager string
	}{
		{"apt-get", "apt-get", "apt-get install -y tmux", "apt-get"},
		{"dnf", "dnf", "dnf install -y tmux", "dnf"},
		{"pacman", "pacman", "pacman -S --noconfirm tmux", "pacman"},
		{"zypper", "zypper", "zypper install -y tmux", "zypper"},
		{"apk", "apk", "apk add tmux", "apk"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			plan := newTestService("linux", tt.found).planFor(TargetTmux)
			if got := strings.Join(plan.Command, " "); got != tt.wantCommand {
				t.Fatalf("Command = %q, want %q", got, tt.wantCommand)
			}
			if plan.Manager != tt.wantManager {
				t.Fatalf("Manager = %q, want %q", plan.Manager, tt.wantManager)
			}
			if !plan.NeedsRoot {
				t.Fatal("NeedsRoot = false, want true: every Linux package manager needs root")
			}
			// The security invariant. Exposing the argv must not have made the
			// daemon willing to run it.
			if !plan.Unsupported {
				t.Fatal("Unsupported = false, want true: the daemon must never run a root install itself")
			}
		})
	}
}

// The daemon must still refuse to execute a Linux plan, argv or not. This is
// the behavioural half of the invariant asserted above.
func TestStartRefusesLinuxRootInstall(t *testing.T) {
	s := newTestService("linux", "apt-get")
	s.commands = commandRunnerFunc(func(context.Context, []string, io.Writer, io.Writer) error {
		t.Fatal("the daemon must not execute a root install")
		return nil
	})
	job, err := s.Start(context.Background(), TargetTmux)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if job.Status != StatusUnsupported {
		t.Fatalf("Status = %q, want %q", job.Status, StatusUnsupported)
	}
}

// Resolve is the seam the CLI consumes; it must agree with the Service's own
// planner rather than being a second implementation of the same table.
func TestResolveMatchesServicePlan(t *testing.T) {
	lookPath := lookPathFound("brew")
	got := Resolve("darwin", lookPath, TargetTmux)
	want := (&Service{goos: "darwin", executables: executableFinderFunc(lookPath)}).planFor(TargetTmux)
	if strings.Join(got.Command, " ") != strings.Join(want.Command, " ") {
		t.Fatalf("Resolve Command = %v, want %v", got.Command, want.Command)
	}
	if got.Unsupported != want.Unsupported {
		t.Fatalf("Resolve Unsupported = %v, want %v", got.Unsupported, want.Unsupported)
	}
	if unknown := Resolve("linux", lookPath, Target("nope")); !unknown.Unsupported {
		t.Fatal("Resolve of an unknown target must be Unsupported")
	}
}
