// Package agentauth owns the fixed, daemon-trusted authentication plans for
// supported harnesses. Clients select only an agent ID; they never provide
// commands or credentials.
package agentauth

import (
	"fmt"
)

// ExecutableFinder resolves an executable on the host PATH.
type ExecutableFinder interface {
	LookPath(string) (string, error)
}

type executableFinderFunc func(string) (string, error)

func (f executableFinderFunc) LookPath(name string) (string, error) { return f(name) }

// Action describes the native authentication action a plan offers.
type Action string

const (
	ActionLogin        Action = "login"
	ActionSetup        Action = "setup"
	ActionInstructions Action = "instructions"
)

// Plan is the display-safe authentication plan for one harness. Trusted
// command and terminal details remain private to this package.
type Plan struct {
	AgentID          string `json:"agentId"`
	Action           Action `json:"action"`
	Available        bool   `json:"available"`
	DisplayCommand   string `json:"displayCommand,omitempty"`
	Guidance         string `json:"guidance,omitempty"`
	DocumentationURL string `json:"documentationUrl"`
	Reason           string `json:"reason,omitempty"`
	command          []string
	title            string
	initialInput     string
}

// Error is a stable service error for a caller-selected authentication target.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// Service resolves the fixed authentication registry against the host PATH.
type Service struct {
	executables ExecutableFinder
}

// New creates an authentication-plan service.
func New(executables ExecutableFinder) *Service {
	return &Service{executables: executables}
}

// Plans returns every known harness plan in stable Harness settings order.
func (s *Service) Plans() []Plan {
	out := make([]Plan, 0, len(plans))
	for _, plan := range plans {
		out = append(out, s.resolve(plan))
	}
	return out
}

// Plan returns the resolved plan for agentID.
func (s *Service) Plan(agentID string) (Plan, error) {
	plan, ok := planByAgentID[agentID]
	if !ok {
		return Plan{}, &Error{Code: "AGENT_AUTH_TARGET_UNKNOWN", Message: fmt.Sprintf("unknown agent authentication target %q", agentID)}
	}
	return s.resolve(plan), nil
}

func (s *Service) resolve(plan Plan) Plan {
	plan.command = append([]string(nil), plan.command...)
	if len(plan.command) == 0 {
		plan.Available = true
		return plan
	}
	if s.executables == nil {
		plan.Reason = fmt.Sprintf("%s was not found on PATH.", plan.command[0])
		return plan
	}
	path, err := s.executables.LookPath(plan.command[0])
	if err != nil || path == "" {
		plan.Reason = fmt.Sprintf("%s was not found on PATH.", plan.command[0])
		return plan
	}
	plan.Available = true
	return plan
}
