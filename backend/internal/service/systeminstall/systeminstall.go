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
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
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

// Resolve reports how target would be installed on goos, without running
// anything and without constructing a Service.
//
// This is the package's answer to "how is this installed here?" Keeping one
// resolver lets the daemon expose a plan preview and lets the bootstrap CLI
// print the same manual tmux remedy without either caller executing arbitrary
// input. The caller supplies the PATH lookup boundary explicitly.
func Resolve(goos string, lookPath func(string) (string, error), target Target) Plan {
	if !Valid(target) {
		return Plan{Target: target, Unsupported: true, Reason: "unknown install target"}
	}
	return (&Service{goos: goos, executables: executableFinderFunc(lookPath)}).planFor(target)
}

type executableFinderFunc func(string) (string, error)

func (f executableFinderFunc) LookPath(file string) (string, error) { return f(file) }

// Plan is the resolved install command for a Target on the current platform.
//
// Command is populated whenever an install command could be resolved at all,
// including when Unsupported is true. Those two are independent on purpose:
// "we know exactly how to install this" and "this daemon is allowed to run it"
// are different questions. On Linux every package manager needs root, so the
// daemon refuses (Unsupported) while still reporting the argv for the desktop
// to display as a manual command. Callers that intend to execute a Plan must
// branch on Unsupported; callers that only need to know whether a route exists
// should test len(Command).
type Plan struct {
	Target      Target
	Command     []string // argv, e.g. ["brew", "install", "tmux"]
	Manager     string   // resolving package manager ("brew", "apt-get", ...), empty when none applies
	NeedsRoot   bool     // Command must run as root; the caller supplies the privilege
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

	executables ports.ExecutableFinder
	commands    ports.CommandRunner
	// goos selects the platform branch in planFor. Real use is always
	// runtime.GOOS; tests override it to exercise every OS branch from one
	// machine, the same seam lookPath provides for PATH probing.
	goos string
	// installTimeout bounds each run — see defaultInstallTimeout. Tests
	// override it with a short duration to exercise the timeout path without
	// a real multi-minute wait.
	installTimeout time.Duration
}

// New returns a Service backed by explicit host-operation ports. The daemon
// supplies their concrete adapter; core service code never invokes os/exec.
func New(executables ports.ExecutableFinder, commands ports.CommandRunner) *Service {
	return &Service{
		jobs:           make(map[Target]*Job),
		executables:    executables,
		commands:       commands,
		goos:           runtime.GOOS,
		installTimeout: defaultInstallTimeout,
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
	command := displayCommand(plan)
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

	go s.run(plan.Command, job) //nolint:gosec // G118: the async job deliberately outlives the starting HTTP request and owns a bounded timeout.

	return *job, nil
}

// Status returns the current or last known Job for target. A target that has
// never been started returns a plan preview: Idle when the daemon can run it,
// or Unsupported with a manual command/reason when it cannot. An error is
// returned only when target is not a known install target.
func (s *Service) Status(ctx context.Context, target Target) (Job, error) {
	if err := ctx.Err(); err != nil {
		return Job{}, err
	}
	if !Valid(target) {
		return Job{}, fmt.Errorf("systeminstall: unknown target %q", target)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	job, ok := s.jobs[target]
	if !ok {
		plan := s.planFor(target)
		status := StatusIdle
		if plan.Unsupported {
			status = StatusUnsupported
		}
		return Job{
			Target:  target,
			Status:  status,
			Command: displayCommand(plan),
			Error:   plan.Reason,
		}, nil
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

	out := &capturedOutput{max: maxOutputBytes}
	runErr := s.commands.Run(ctx, argv, out, out)
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
	if path, err := s.executables.LookPath(string(job.Target)); err != nil || path == "" {
		job.Status = StatusFailed
		job.Error = fmt.Sprintf("install command finished but %s is still not in PATH", job.Target)
		return
	}
	job.Status = StatusSucceeded
}

func displayCommand(plan Plan) string {
	argv := plan.Command
	if plan.NeedsRoot && len(argv) > 0 {
		argv = append([]string{"sudo"}, argv...)
	}
	return strings.Join(argv, " ")
}

// capturedOutput is an io.Writer that keeps only the last max bytes written,
// trimming from the front.
type capturedOutput struct {
	mu  sync.Mutex
	buf bytes.Buffer
	max int
}

func (c *capturedOutput) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.buf.Write(p)
	if c.buf.Len() > c.max {
		tail := c.buf.String()[c.buf.Len()-c.max:]
		c.buf.Reset()
		c.buf.WriteString(tail)
	}
	return len(p), nil
}

func (c *capturedOutput) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.String()
}

// planFor resolves the install Plan for target on the current platform,
// probing PATH via s.executables so tests can inject deterministic results.
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
	case "linux":
		return s.planLinuxPackage(TargetTmux, func(string) string { return "tmux" })
	default:
		return Plan{Target: TargetTmux, Unsupported: true, Reason: "tmux installation is not supported on this platform."}
	}
}

func (s *Service) planGH() Plan {
	switch s.goos {
	case "windows":
		return s.planWinget(TargetGH, "GitHub.cli")
	case "darwin":
		return s.planBrew(TargetGH, "gh")
	case "linux":
		return s.planLinuxPackage(TargetGH, func(mgr string) string {
			if mgr == "pacman" {
				return "github-cli"
			}
			return "gh"
		})
	default:
		return Plan{Target: TargetGH, Unsupported: true, Reason: "gh installation is not supported on this platform."}
	}
}

func (s *Service) planNPM(target Target, pkg string) Plan {
	if _, err := s.executables.LookPath("npm"); err != nil {
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
	if _, err := s.executables.LookPath("curl"); err != nil {
		return Plan{Target: TargetOpencode, Unsupported: true, Reason: "curl was not found on PATH."}
	}
	// opencode's official installer is documented as a bash script
	// (curl -fsSL https://opencode.ai/install | bash); there is no sh
	// fallback here because sh piping into "| bash" still requires bash to
	// actually exist, so probing for sh and then unconditionally invoking
	// bash anyway would silently fail the moment the pipe reaches it.
	if _, err := s.executables.LookPath("bash"); err != nil {
		return Plan{Target: TargetOpencode, Unsupported: true, Reason: "bash was not found on PATH."}
	}
	return Plan{Target: TargetOpencode, Command: []string{"bash", "-c", "curl -fsSL https://opencode.ai/install | bash"}}
}

func (s *Service) planBrew(target Target, pkg string) Plan {
	if _, err := s.executables.LookPath("brew"); err != nil {
		return Plan{
			Target: target, Unsupported: true,
			Reason: "Homebrew was not found on PATH. Install it from https://brew.sh first, then retry.",
		}
	}
	return Plan{Target: target, Command: []string{"brew", "install", pkg}}
}

func (s *Service) planWinget(target Target, id string) Plan {
	if _, err := s.executables.LookPath("winget"); err != nil {
		return Plan{Target: target, Unsupported: true, Reason: "winget was not found on PATH."}
	}
	return Plan{Target: target, Command: []string{"winget", "install", "-e", "--id", id}}
}

// linuxPackageManagers is probed in this fixed order; the first one found on
// PATH is used.
var linuxPackageManagers = []string{"apt-get", "dnf", "pacman", "zypper", "apk"}

// planLinuxPackage resolves a Linux install command for target via the first
// available package manager. pkgFor lets a target use a different package
// name on a given manager (e.g. gh is "github-cli" on pacman).
//
// AO deliberately never elevates privileges on the user's behalf (no auto
// sudo, no pkexec): every one of apt-get/dnf/pacman/zypper install requires
// root, so running the resolved command as the desktop user is guaranteed to
// fail with a permission error. Rather than expose a button that always
// fails, this always resolves as Unsupported on Linux. Command carries the
// exact argv and displayCommand adds sudo for the user-facing manual remedy.
func (s *Service) planLinuxPackage(target Target, pkgFor func(mgr string) string) Plan {
	for _, mgr := range linuxPackageManagers {
		if _, err := s.executables.LookPath(mgr); err != nil {
			continue
		}
		argv := linuxInstallArgv(mgr, pkgFor(mgr))
		return Plan{
			Target: target, Command: argv, Manager: mgr, NeedsRoot: true, Unsupported: true,
			Reason: "AO cannot ask for your administrator password. Run the command below in a terminal.",
		}
	}
	return Plan{
		Target: target, Unsupported: true,
		Reason: fmt.Sprintf(
			"No supported Linux package manager (%s) was found.",
			strings.Join(linuxPackageManagers, ", "),
		),
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
	case "apk":
		return []string{"apk", "add", pkg}
	default:
		return nil
	}
}
