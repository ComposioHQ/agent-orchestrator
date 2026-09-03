// Package browser owns authorization and dispatch for session-scoped browser
// commands. HTTP controllers remain transport-only adapters.
package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/browserruntime"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

var actions = map[string]struct{}{
	"open": {}, "snapshot": {}, "click": {}, "fill": {}, "type": {}, "press": {},
	"hover": {}, "highlight": {}, "unhighlight": {}, "tabs": {}, "tab-new": {},
	"tab-select": {}, "tab-close": {}, "scroll": {}, "select": {}, "check": {},
	"uncheck": {}, "get": {}, "wait": {}, "screenshot": {}, "network-start": {},
	"network-status": {}, "network-list": {}, "network-stop": {}, "network-clear": {},
	"console": {}, "errors": {},
}

type sessionReader interface {
	Get(ctx context.Context, id domain.SessionID) (domain.Session, error)
}

type runtime interface {
	Status() browserruntime.Status
	Execute(ctx context.Context, sessionID domain.SessionID, action string, args map[string]interface{}) (browserruntime.Result, error)
}

// Service validates worker ownership and lifecycle state before dispatching to
// the Electron runtime.
type Service struct {
	sessions  sessionReader
	runtime   runtime
	authority *Authority
}

// New creates a browser service.
func New(sessions sessionReader, runtime runtime, authority *Authority) *Service {
	return &Service{sessions: sessions, runtime: runtime, authority: authority}
}

// Status returns transport state after validating the session owner.
func (s *Service) Status(ctx context.Context, sessionID domain.SessionID, capability string) (browserruntime.Status, error) {
	if err := s.authorize(ctx, sessionID, capability); err != nil {
		return browserruntime.Status{}, err
	}
	status := s.runtime.Status()
	if !status.Connected {
		return status, nil
	}
	result, err := s.runtime.Execute(ctx, sessionID, "__status", nil)
	if errors.Is(err, browserruntime.ErrUnavailable) {
		status.Connected = false
		status.State = browserruntime.ReadinessRecovering
		status.RecommendedAction = "Wait for the desktop browser runtime to reconnect."
		return status, nil
	}
	if err != nil {
		status.State = browserruntime.ReadinessUnavailable
		status.RecommendedAction = "Retry browser status; if it persists, reopen the AO desktop app."
		return status, nil
	}
	var live struct {
		State             browserruntime.ReadinessState `json:"state"`
		Provider          string                        `json:"provider"`
		Target            *browserruntime.Target        `json:"target"`
		RecommendedAction string                        `json:"recommendedAction"`
	}
	if err := decodeRuntimeValue(result.Value, &live); err != nil {
		return browserruntime.Status{}, err
	}
	status.State = live.State
	status.Provider = live.Provider
	status.Target = live.Target
	status.RecommendedAction = live.RecommendedAction
	return status, nil
}

// Observe returns a typed, correlated accessibility observation with optional
// visual and diagnostic evidence. It never sends any data into the agent
// session; callers must request and consume the result explicitly.
func (s *Service) Observe(
	ctx context.Context,
	sessionID domain.SessionID,
	capability string,
	options browserruntime.ObserveOptions,
) (browserruntime.Result, browserruntime.Observation, error) {
	if err := s.authorize(ctx, sessionID, capability); err != nil {
		return browserruntime.Result{}, browserruntime.Observation{}, err
	}
	result, err := s.runtime.Execute(ctx, sessionID, "observe", map[string]interface{}{
		"interactiveOnly":   options.InteractiveOnly,
		"includeScreenshot": options.IncludeScreenshot,
		"includeProblems":   options.IncludeProblems,
	})
	if err != nil {
		return browserruntime.Result{}, browserruntime.Observation{}, err
	}
	var observation browserruntime.Observation
	if err := decodeRuntimeValue(result.Value, &observation); err != nil {
		return browserruntime.Result{}, browserruntime.Observation{}, err
	}
	return result, observation, nil
}

// Execute validates ownership and dispatches one supported action.
func (s *Service) Execute(
	ctx context.Context,
	sessionID domain.SessionID,
	capability string,
	action string,
	args map[string]interface{},
) (browserruntime.Result, string, error) {
	action = strings.ToLower(strings.TrimSpace(action))
	if err := s.authorize(ctx, sessionID, capability); err != nil {
		return browserruntime.Result{}, action, err
	}
	if _, ok := actions[action]; !ok {
		return browserruntime.Result{}, action, apierr.Invalid(
			"BROWSER_ACTION_UNSUPPORTED",
			"Unsupported browser action",
			nil,
		)
	}
	result, err := s.runtime.Execute(ctx, sessionID, action, args)
	return result, action, err
}

func (s *Service) authorize(ctx context.Context, sessionID domain.SessionID, capability string) error {
	session, err := s.sessions.Get(ctx, sessionID)
	if err != nil {
		return err
	}
	if session.IsTerminated {
		return apierr.Conflict("SESSION_TERMINATED", "Session is terminated", nil)
	}
	if s.authority == nil || !s.authority.Valid(sessionID, strings.TrimSpace(capability)) {
		return apierr.Forbidden("BROWSER_CAPABILITY_INVALID", "Browser capability is invalid")
	}
	return nil
}

func decodeRuntimeValue(value interface{}, out interface{}) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode browser runtime result: %w", err)
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("decode browser runtime result: %w", err)
	}
	return nil
}
