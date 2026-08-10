// Package systeminstall executes real install commands for a small, fixed
// allowlist of targets: tmux, gh, claude, codex, opencode, copilot. This is
// the core security invariant of the package — a caller can only select
// which of the six known Target values to install; the actual argv run on
// the machine is always built from hardcoded command shapes, never from
// caller-supplied strings. Runs are tracked as async Jobs so an HTTP handler
// never blocks on an installer that can take minutes.
package systeminstall

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Target is one of the fixed install targets AO knows how to install.
type Target string

// The exhaustive set of installable targets. No other value is ever accepted.
const (
	TargetTmux     Target = "tmux"
	TargetGH       Target = "gh"
	TargetClaude   Target = "claude"
	TargetCodex    Target = "codex"
	TargetOpencode Target = "opencode"
	TargetCopilot  Target = "copilot"
)

// knownTargets is the exhaustive allowlist backing Valid.
var knownTargets = map[Target]bool{
	TargetTmux:     true,
	TargetGH:       true,
	TargetClaude:   true,
	TargetCodex:    true,
	TargetOpencode: true,
	TargetCopilot:  true,
}

// Valid reports whether target is one of the six known install targets.
func Valid(target Target) bool {
	return knownTargets[target]
}

// Plan is the resolved install command for a Target on the current platform.
type Plan struct {
	Target      Target
	Command     []string // argv, e.g. ["brew", "install", "tmux"]
	Unsupported bool
	Reason      string // set when Unsupported, or as extra context otherwise
}

// Status is the lifecycle state of an install Job.
type Status string

// The full set of Job lifecycle states.
const (
	StatusIdle        Status = "idle"
	StatusRunning     Status = "running"
	StatusSucceeded   Status = "succeeded"
	StatusFailed      Status = "failed"
	StatusUnsupported Status = "unsupported"
)

// maxOutputBytes bounds Job.Output so a chatty installer can't grow memory
// unbounded — only the last ~4000 bytes are kept.
const maxOutputBytes = 4000

// defaultInstallTimeout bounds how long a single install run may take. A
// stalled installer (a network hang on curl, a held brew/apt lock, winget
// waiting on a prompt it'll never get) would otherwise pin its target in
// StatusRunning forever: no retry path, and the caller polls an indefinite
// progress bar. Real installs (npm global, brew, curl-piped scripts) normally
// finish in well under a minute; 15 minutes is generous headroom, not a
// realistic expected duration.
const defaultInstallTimeout = 15 * time.Minute

// Job is the tracked state of one install run for a Target.
type Job struct {
	Target  Target `json:"target" enum:"tmux,gh,claude,codex,opencode,copilot" description:"Install target this job ran (or is running) for."`
	Status  Status `json:"status" enum:"idle,running,succeeded,failed,unsupported" description:"Current lifecycle state of the job."`
	Command string `json:"command,omitempty" description:"Human-readable install command, e.g. \"brew install tmux\", for display even before/without output."`
	Output  string `json:"output,omitempty" description:"Combined stdout+stderr from the install command, tail-capped to the last ~4000 bytes."`
	Error   string `json:"error,omitempty" description:"Set on failure or when the target is unsupported on this machine: the exec error, the Unsupported reason, or a timeout message."`
	// Pointers, not time.Time: omitempty has no effect on a struct, so a bare
	// time.Time always serializes (as the zero value's "0001-01-01..."
	// timestamp) even when nothing has happened yet. A nil pointer actually
	// omits the field, matching FinishedAt's documented "zero until the job
	// finishes" contract.
	StartedAt  *time.Time `json:"startedAt,omitempty"`
	FinishedAt *time.Time `json:"finishedAt,omitempty" description:"Absent until the job finishes."`
}

// Service runs real install commands for the fixed Target allowlist.
type Service struct {
	mu   sync.Mutex
	jobs map[Target]*Job

	lookPath func(string) (string, error)
	// commandFunc builds the *exec.Cmd for a resolved argv against ctx (which
	// carries the run's timeout — see installTimeout). Real installs use
	// exec.CommandContext; tests override it with a fast, deterministic
	// command so they never hit the network.
	commandFunc func(ctx context.Context, argv []string) *exec.Cmd
	// goos selects the platform branch in planFor. Real use is always
	// runtime.GOOS; tests override it to exercise every OS branch from one
	// machine, the same seam lookPath provides for PATH probing.
	goos string
	// installTimeout bounds each run — see defaultInstallTimeout. Tests
	// override it with a short duration to exercise the timeout path without
	// a real multi-minute wait.
	installTimeout time.Duration
}

// New returns a Service backed by the real exec.LookPath and exec.Command.
func New() *Service {
	return &Service{
		jobs:           make(map[Target]*Job),
		lookPath:       exec.LookPath,
		goos:           runtime.GOOS,
		installTimeout: defaultInstallTimeout,
		commandFunc: func(ctx context.Context, argv []string) *exec.Cmd {
			// ctx here is a timeout rooted in context.Background(), not the
			// HTTP request's ctx: an install kicked off by a request must
			// keep running (and stay queryable) after that request returns —
			// the one deliberate exception to always threading ctx through.
			return exec.CommandContext(ctx, argv[0], argv[1:]...) //nolint:gosec // G204: fixed allowlist, argv is never caller-derived.
		},
	}
}

// Start begins the install for target, or returns the already-running Job if
// one is in flight (idempotent — it never starts a second concurrent run of
// the same target). target must be one of the six known values; anything else
// is a caller bug and returns an error the controller turns into a 400.
func (s *Service) Start(ctx context.Context, target Target) (Job, error) {
	if err := ctx.Err(); err != nil {
		return Job{}, err
	}
	if !Valid(target) {
		return Job{}, fmt.Errorf("systeminstall: unknown target %q", target)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if job, ok := s.jobs[target]; ok && job.Status == StatusRunning {
		return *job, nil
	}

	plan := s.planFor(target)
	command := strings.Join(plan.Command, " ")
	now := time.Now()
	if plan.Unsupported {
		job := &Job{
			Target:     target,
			Status:     StatusUnsupported,
			Command:    command,
			Error:      plan.Reason,
			StartedAt:  &now,
			FinishedAt: &now,
		}
		s.jobs[target] = job
		return *job, nil
	}

	job := &Job{
		Target:    target,
		Status:    StatusRunning,
		Command:   command,
		StartedAt: &now,
	}
	s.jobs[target] = job

	go s.run(plan.Command, job) //nolint:gosec // G118: run() deliberately roots its own timeout in context.Background(), not ctx — see the commandFunc field doc above.

	return *job, nil
}

// Status returns the current or last known Job for target. A target that has
// never been started returns a zero-value StatusIdle job — that is not an
// error; error is returned only when target is not a known install target.
func (s *Service) Status(target Target) (Job, error) {
	if !Valid(target) {
		return Job{}, fmt.Errorf("systeminstall: unknown target %q", target)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	job, ok := s.jobs[target]
	if !ok {
		return Job{Target: target, Status: StatusIdle}, nil
	}
	return *job, nil
}

// run executes argv in the background and records the outcome onto job. job
// is only ever mutated here and read back through a copy under s.mu, so
// concurrent Start/Status calls never race with this goroutine's writes.
// The run is bounded by installTimeout so a stalled installer eventually
// surfaces as a failure instead of pinning the target in StatusRunning.
func (s *Service) run(argv []string, job *Job) {
	ctx, cancel := context.WithTimeout(context.Background(), s.installTimeout)
	defer cancel()

	cmd := s.commandFunc(ctx, argv)
	out := &capturedOutput{max: maxOutputBytes}
	cmd.Stdout = out
	cmd.Stderr = out

	runErr := cmd.Run()
	now := time.Now()

	s.mu.Lock()
	defer s.mu.Unlock()
	job.Output = out.String()
	job.FinishedAt = &now
	if ctx.Err() == context.DeadlineExceeded {
		job.Status = StatusFailed
		job.Error = fmt.Sprintf("install timed out after %s", s.installTimeout)
		return
	}
	if runErr != nil {
		job.Status = StatusFailed
		job.Error = runErr.Error()
		return
	}
	job.Status = StatusSucceeded
}

// capturedOutput is an io.Writer that keeps only the last max bytes written,
// trimming from the front. It is passed as both Stdout and Stderr on the same
// Cmd, and exec.Cmd guarantees at most one goroutine writes at a time when
// Stdout and Stderr are the same comparable Writer, so no lock is needed here.
type capturedOutput struct {
	buf bytes.Buffer
	max int
}

func (c *capturedOutput) Write(p []byte) (int, error) {
	c.buf.Write(p)
	if c.buf.Len() > c.max {
		tail := c.buf.String()[c.buf.Len()-c.max:]
		c.buf.Reset()
		c.buf.WriteString(tail)
	}
	return len(p), nil
}

func (c *capturedOutput) String() string { return c.buf.String() }

// planFor resolves the install Plan for target on the current platform,
// probing PATH via s.lookPath so tests can inject deterministic results.
func (s *Service) planFor(target Target) Plan {
	switch target {
	case TargetTmux:
		return s.planTmux()
	case TargetGH:
		return s.planGH()
	case TargetClaude:
		return s.planNPM(TargetClaude, "@anthropic-ai/claude-code")
	case TargetCodex:
		return s.planNPM(TargetCodex, "@openai/codex")
	case TargetCopilot:
		return s.planNPM(TargetCopilot, "@github/copilot")
	case TargetOpencode:
		return s.planOpencode()
	default:
		return Plan{Target: target, Unsupported: true, Reason: "unknown install target"}
	}
}

func (s *Service) planTmux() Plan {
	switch s.goos {
	case "windows":
		return Plan{
			Target: TargetTmux, Unsupported: true,
			Reason: "tmux is not required on Windows; AO uses the built-in ConPTY terminal runtime instead.",
		}
	case "darwin":
		return s.planBrew(TargetTmux, "tmux")
	default:
		return s.planLinuxPackage(TargetTmux, func(string) string { return "tmux" })
	}
}

func (s *Service) planGH() Plan {
	switch s.goos {
	case "windows":
		return s.planWinget(TargetGH, "GitHub.cli")
	case "darwin":
		return s.planBrew(TargetGH, "gh")
	default:
		return s.planLinuxPackage(TargetGH, func(mgr string) string {
			if mgr == "pacman" {
				return "github-cli"
			}
			return "gh"
		})
	}
}

func (s *Service) planNPM(target Target, pkg string) Plan {
	if _, err := s.lookPath("npm"); err != nil {
		return Plan{
			Target: target, Unsupported: true,
			Reason: "npm was not found on PATH. Install Node.js from https://nodejs.org first, then retry.",
		}
	}
	return Plan{Target: target, Command: []string{"npm", "install", "-g", pkg}}
}

func (s *Service) planOpencode() Plan {
	if s.goos == "windows" {
		return s.planWinget(TargetOpencode, "SST.opencode")
	}
	if _, err := s.lookPath("curl"); err != nil {
		return Plan{Target: TargetOpencode, Unsupported: true, Reason: "curl was not found on PATH."}
	}
	// opencode's official installer is documented as a bash script
	// (curl -fsSL https://opencode.ai/install | bash); there is no sh
	// fallback here because sh piping into "| bash" still requires bash to
	// actually exist, so probing for sh and then unconditionally invoking
	// bash anyway would silently fail the moment the pipe reaches it.
	if _, err := s.lookPath("bash"); err != nil {
		return Plan{Target: TargetOpencode, Unsupported: true, Reason: "bash was not found on PATH."}
	}
	return Plan{Target: TargetOpencode, Command: []string{"bash", "-c", "curl -fsSL https://opencode.ai/install | bash"}}
}

func (s *Service) planBrew(target Target, pkg string) Plan {
	if _, err := s.lookPath("brew"); err != nil {
		return Plan{
			Target: target, Unsupported: true,
			Reason: "Homebrew was not found on PATH. Install it from https://brew.sh first, then retry.",
		}
	}
	return Plan{Target: target, Command: []string{"brew", "install", pkg}}
}

func (s *Service) planWinget(target Target, id string) Plan {
	if _, err := s.lookPath("winget"); err != nil {
		return Plan{Target: target, Unsupported: true, Reason: "winget was not found on PATH."}
	}
	return Plan{Target: target, Command: []string{"winget", "install", "-e", "--id", id}}
}

// linuxPackageManagers is probed in this fixed order; the first one found on
// PATH is used.
var linuxPackageManagers = []string{"apt-get", "dnf", "pacman", "zypper"}

// planLinuxPackage resolves a Linux install command for target via the first
// available package manager. pkgFor lets a target use a different package
// name on a given manager (e.g. gh is "github-cli" on pacman).
//
// AO deliberately never elevates privileges on the user's behalf (no auto
// sudo, no pkexec): every one of apt-get/dnf/pacman/zypper install requires
// root, so running the resolved command as the desktop user is guaranteed to
// fail with a permission error. Rather than expose a button that always
// fails, this always resolves as Unsupported on Linux, with Reason carrying
// the exact sudo-prefixed command for the user to run themselves.
func (s *Service) planLinuxPackage(target Target, pkgFor func(mgr string) string) Plan {
	for _, mgr := range linuxPackageManagers {
		if _, err := s.lookPath(mgr); err != nil {
			continue
		}
		argv := linuxInstallArgv(mgr, pkgFor(mgr))
		return Plan{
			Target: target, Unsupported: true,
			Reason: fmt.Sprintf(
				"AO does not run installers as root. Run this yourself in a terminal: sudo %s",
				strings.Join(argv, " "),
			),
		}
	}
	return Plan{
		Target: target, Unsupported: true,
		Reason: "No supported Linux package manager (apt, dnf, pacman, zypper) was found.",
	}
}

func linuxInstallArgv(mgr, pkg string) []string {
	switch mgr {
	case "apt-get":
		return []string{"apt-get", "install", "-y", pkg}
	case "dnf":
		return []string{"dnf", "install", "-y", pkg}
	case "pacman":
		return []string{"pacman", "-S", "--noconfirm", pkg}
	case "zypper":
		return []string{"zypper", "install", "-y", pkg}
	default:
		return nil
	}
}
