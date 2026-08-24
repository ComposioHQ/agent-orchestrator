// Package systemcheck reports whether the local machine satisfies the
// prerequisites AO needs before the desktop app shows the board: git, tmux
// (macOS/Linux only), and at least one installed agent-harness CLI. It also
// probes for gh (the GitHub CLI), which is advisory only and never blocks
// readiness. These checks only resolve executable paths; agent authentication
// and compatibility probes are deferred until the user opens an agent picker.
package systemcheck

import (
	"context"
	"runtime"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
)

// Requirement is one named startup gate check.
type Requirement struct {
	ID        string `json:"id" enum:"git,tmux,harness,gh" description:"Stable requirement identifier."`
	Label     string `json:"label" description:"Human-readable requirement name."`
	Satisfied bool   `json:"satisfied" description:"Whether this requirement is currently met."`
	Required  bool   `json:"required" description:"Whether this requirement blocks the overall Ready state."`
	Detail    string `json:"detail,omitempty" description:"Extra context: the resolved path when satisfied, or why it is not."`
}

// Report is the full startup requirements gate result.
type Report struct {
	Ready        bool          `json:"ready" description:"True iff every requirement with Required=true is satisfied. Requirements with Required=false (e.g. gh) are advisory and never block readiness."`
	Requirements []Requirement `json:"requirements" description:"Individual checks, in stable order: git, tmux, harness, gh."`
}

// HarnessCatalog is the path-only subset of agent.Service the startup harness
// requirement needs.
type HarnessCatalog interface {
	FindInstalledBinary(ctx context.Context) (agentsvc.Info, bool)
}

// Service runs the startup requirements gate.
type Service struct {
	harnesses   HarnessCatalog
	executables ports.ExecutableFinder
}

// New returns a Service backed by the supplied host executable adapter and
// harness catalog (an *agent.Service in production).
func New(harnesses HarnessCatalog, executables ports.ExecutableFinder) *Service {
	return &Service{harnesses: harnesses, executables: executables}
}

type executableFinderFunc func(string) (string, error)

func (f executableFinderFunc) LookPath(file string) (string, error) { return f(file) }

// NewWithLookPath returns a Service with an injected lookPath, for tests that
// need deterministic binary-resolution results without touching the real PATH.
func NewWithLookPath(harnesses HarnessCatalog, lookPath func(string) (string, error)) *Service {
	return New(harnesses, executableFinderFunc(lookPath))
}

// Check runs the four startup requirement probes and reports whether the
// machine is ready to run AO sessions. gh is advisory (Required: false) and
// never affects Ready.
func (s *Service) Check(ctx context.Context) (Report, error) {
	if err := ctx.Err(); err != nil {
		return Report{}, err
	}

	requirements := []Requirement{
		s.checkGit(),
		s.checkTmux(),
		s.checkHarness(ctx),
		s.checkGH(),
	}

	ready := true
	for _, req := range requirements {
		if req.Required && !req.Satisfied {
			ready = false
			break
		}
	}
	return Report{Ready: ready, Requirements: requirements}, nil
}

func (s *Service) checkGit() Requirement {
	path, err := s.executables.LookPath("git")
	if err != nil || path == "" {
		return Requirement{ID: "git", Label: "git", Required: true, Detail: "git was not found on PATH."}
	}
	return Requirement{ID: "git", Label: "git", Satisfied: true, Required: true, Detail: path}
}

func (s *Service) checkTmux() Requirement {
	if runtime.GOOS == "windows" {
		// tmux is a macOS/Linux-only requirement: AO uses the built-in ConPTY
		// terminal runtime on Windows instead, so this always passes there.
		return Requirement{
			ID: "tmux", Label: "tmux", Satisfied: true, Required: true,
			Detail: "Not required on Windows — AO uses the built-in ConPTY terminal runtime instead of tmux.",
		}
	}
	path, err := s.executables.LookPath("tmux")
	if err != nil || path == "" {
		return Requirement{
			ID: "tmux", Label: "tmux", Required: true,
			Detail: "tmux was not found on PATH; it is required on macOS/Linux to start sessions.",
		}
	}
	return Requirement{ID: "tmux", Label: "tmux", Satisfied: true, Required: true, Detail: path}
}

func (s *Service) checkHarness(ctx context.Context) Requirement {
	const label = "agent harness"
	info, ok := s.harnesses.FindInstalledBinary(ctx)
	if !ok {
		return Requirement{
			ID: "harness", Label: label, Required: true,
			Detail: "No agent CLI (Claude Code, Codex, etc.) was found on PATH or in a supported install location.",
		}
	}
	return Requirement{ID: "harness", Label: label, Satisfied: true, Required: true, Detail: info.Label}
}

// checkGH probes for the GitHub CLI. It is advisory only (Required: false):
// agent sessions use it to open pull requests and read issues, but AO itself
// never depends on it, so its absence must never block Ready.
func (s *Service) checkGH() Requirement {
	path, err := s.executables.LookPath("gh")
	if err != nil || path == "" {
		return Requirement{
			ID: "gh", Label: "gh",
			Detail: "gh was not found on PATH. It lets agent sessions open pull requests and read issues, but AO runs fine without it.",
		}
	}
	return Requirement{ID: "gh", Label: "gh", Satisfied: true, Detail: path}
}
