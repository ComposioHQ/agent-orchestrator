// Package systemcheck reports whether the local machine satisfies the
// prerequisites AO needs before the desktop app shows the board: git, tmux
// (macOS/Linux only), and at least one installed agent-harness CLI. It is the
// backend gate the Electron loading screen polls; the checks are pure
// existence probes (LookPath), not the deeper version/compatibility checks
// `ao doctor` runs.
package systemcheck

import (
	"context"
	"os/exec"
	"runtime"
	"strings"

	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
)

// Requirement is one named startup gate check.
type Requirement struct {
	ID        string `json:"id" enum:"git,tmux,harness" description:"Stable requirement identifier."`
	Label     string `json:"label" description:"Human-readable requirement name."`
	Satisfied bool   `json:"satisfied" description:"Whether this requirement is currently met."`
	Detail    string `json:"detail,omitempty" description:"Extra context: the resolved path when satisfied, or why it is not."`
}

// Report is the full startup requirements gate result.
type Report struct {
	Ready        bool          `json:"ready" description:"True iff every requirement is satisfied."`
	Requirements []Requirement `json:"requirements" description:"Individual checks, in stable order: git, tmux, harness."`
}

// HarnessCatalog is the subset of agent.Service the harness requirement needs.
// agent.Service already satisfies this via its existing Refresh method.
type HarnessCatalog interface {
	Refresh(ctx context.Context) (agentsvc.Inventory, error)
}

// Service runs the startup requirements gate.
type Service struct {
	harnesses HarnessCatalog
	lookPath  func(string) (string, error)
}

// New returns a Service backed by the real exec.LookPath and the given
// harness catalog (an *agent.Service in production).
func New(harnesses HarnessCatalog) *Service {
	return &Service{harnesses: harnesses, lookPath: exec.LookPath}
}

// NewWithLookPath returns a Service with an injected lookPath, for tests that
// need deterministic binary-resolution results without touching the real PATH.
func NewWithLookPath(harnesses HarnessCatalog, lookPath func(string) (string, error)) *Service {
	s := New(harnesses)
	if lookPath != nil {
		s.lookPath = lookPath
	}
	return s
}

// Check runs the three startup requirement probes and reports whether the
// machine is ready to run AO sessions.
func (s *Service) Check(ctx context.Context) (Report, error) {
	if err := ctx.Err(); err != nil {
		return Report{}, err
	}

	requirements := []Requirement{
		s.checkGit(),
		s.checkTmux(),
		s.checkHarness(ctx),
	}

	ready := true
	for _, req := range requirements {
		if !req.Satisfied {
			ready = false
			break
		}
	}
	return Report{Ready: ready, Requirements: requirements}, nil
}

func (s *Service) checkGit() Requirement {
	path, err := s.lookPath("git")
	if err != nil || path == "" {
		return Requirement{ID: "git", Label: "git", Detail: "git was not found on PATH."}
	}
	return Requirement{ID: "git", Label: "git", Satisfied: true, Detail: path}
}

func (s *Service) checkTmux() Requirement {
	if runtime.GOOS == "windows" {
		// tmux is a macOS/Linux-only requirement: AO uses the built-in ConPTY
		// terminal runtime on Windows instead, so this always passes there.
		return Requirement{
			ID: "tmux", Label: "tmux", Satisfied: true,
			Detail: "Not required on Windows — AO uses the built-in ConPTY terminal runtime instead of tmux.",
		}
	}
	path, err := s.lookPath("tmux")
	if err != nil || path == "" {
		return Requirement{
			ID: "tmux", Label: "tmux",
			Detail: "tmux was not found on PATH; it is required on macOS/Linux to start sessions.",
		}
	}
	return Requirement{ID: "tmux", Label: "tmux", Satisfied: true, Detail: path}
}

func (s *Service) checkHarness(ctx context.Context) Requirement {
	const label = "agent harness"
	inv, err := s.harnesses.Refresh(ctx)
	if err != nil {
		return Requirement{ID: "harness", Label: label, Detail: err.Error()}
	}
	if len(inv.Installed) == 0 {
		return Requirement{
			ID: "harness", Label: label,
			Detail: "No agent CLI (Claude Code, Codex, etc.) was found on PATH.",
		}
	}
	labels := make([]string, 0, len(inv.Installed))
	for _, info := range inv.Installed {
		labels = append(labels, info.Label)
	}
	return Requirement{ID: "harness", Label: label, Satisfied: true, Detail: strings.Join(labels, ", ")}
}
