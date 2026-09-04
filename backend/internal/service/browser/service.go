// Package browser owns authorization and dispatch for session-scoped browser
// commands. HTTP controllers remain transport-only adapters.
package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

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
	"back": {}, "forward": {}, "reload": {}, "double-click": {}, "right-click": {},
	"frames": {}, "dialog": {}, "dialog-accept": {}, "dialog-dismiss": {}, "viewport": {}, "viewport-set": {},
	"console-clear": {}, "errors-clear": {},
	"upload": {}, "drag": {}, "downloads": {}, "downloads-clear": {},
}

var mutationActions = map[string]struct{}{
	"click": {}, "fill": {}, "type": {}, "press": {}, "scroll": {},
	"select": {}, "check": {}, "uncheck": {},
	"back": {}, "forward": {}, "reload": {}, "double-click": {}, "right-click": {},
	"dialog-accept": {}, "dialog-dismiss": {}, "viewport-set": {},
	"upload": {}, "drag": {},
}

var retryableActions = map[string]struct{}{
	"snapshot": {}, "hover": {}, "highlight": {}, "unhighlight": {}, "tabs": {},
	"get": {}, "wait": {}, "screenshot": {}, "network-status": {}, "network-list": {},
	"console": {}, "errors": {},
	"frames": {}, "dialog": {},
}

type sessionReader interface {
	Get(ctx context.Context, id domain.SessionID) (domain.Session, error)
}

type runtime interface {
	Status() browserruntime.Status
	Execute(ctx context.Context, sessionID domain.SessionID, action string, args map[string]interface{}) (browserruntime.Result, error)
}

type runtimeStarter interface {
	Ensure(context.Context) error
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
		if starter, ok := s.runtime.(runtimeStarter); ok {
			ensureErr := starter.Ensure(ctx)
			switch {
			case ensureErr == nil:
				status = s.runtime.Status()
			case errors.Is(ensureErr, browserruntime.ErrUnavailable):
				status = s.runtime.Status()
			default:
				return browserruntime.Status{}, ensureErr
			}
		}
		if !status.Connected {
			//nolint:nilerr // Runtime unavailability is the successful, actionable status payload.
			return status, nil
		}
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
		//nolint:nilerr // Provider faults are represented as actionable status, never agent-facing error text.
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
	args := map[string]interface{}{
		"tabId":             options.TabID,
		"interactiveOnly":   options.InteractiveOnly,
		"includeScreenshot": options.IncludeScreenshot,
		"includeProblems":   options.IncludeProblems,
	}
	result, err := s.runtime.Execute(ctx, sessionID, "observe", args)
	if errors.Is(err, browserruntime.ErrUnavailable) || errors.Is(err, browserruntime.ErrOutcomeUnknown) {
		timer := time.NewTimer(100 * time.Millisecond)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return browserruntime.Result{}, browserruntime.Observation{}, ctx.Err()
		case <-timer.C:
		}
		result, err = s.runtime.Execute(ctx, sessionID, "observe", args)
	}
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
	if action == "upload" {
		session, err := s.sessions.Get(ctx, sessionID)
		if err != nil {
			return browserruntime.Result{}, action, err
		}
		paths, err := validateUploadPaths(session.Metadata.WorkspacePath, args["files"])
		if err != nil {
			return browserruntime.Result{}, action, err
		}
		args["files"] = paths
	}
	if _, mutates := mutationActions[action]; mutates && !hasBrowserPreconditions(args) {
		return browserruntime.Result{}, action, apierr.Invalid(
			"BROWSER_PRECONDITION_REQUIRED",
			"Mutating browser actions require expectedState.tabId, expectedState.expectedUrl, and expectedState.snapshotGeneration",
			nil,
		)
	}
	if _, mutates := mutationActions[action]; mutates && externalBrowserTarget(args) {
		confirmed, _ := args["confirmed"].(bool)
		if !confirmed {
			return browserruntime.Result{}, action, apierr.Invalid(
				"BROWSER_CONFIRMATION_REQUIRED",
				"Mutating a non-local browser target requires explicit user confirmation",
				nil,
			)
		}
	}
	result, err := s.runtime.Execute(ctx, sessionID, action, args)
	if err != nil {
		if _, retryable := retryableActions[action]; retryable && (errors.Is(err, browserruntime.ErrUnavailable) || errors.Is(err, browserruntime.ErrOutcomeUnknown)) {
			timer := time.NewTimer(100 * time.Millisecond)
			defer timer.Stop()
			select {
			case <-ctx.Done():
				return browserruntime.Result{}, action, ctx.Err()
			case <-timer.C:
			}
			result, err = s.runtime.Execute(ctx, sessionID, action, args)
		}
		if _, mutates := mutationActions[action]; mutates && errors.Is(err, browserruntime.ErrOutcomeUnknown) {
			return browserruntime.Result{}, action, browserruntime.CommandError{
				Code: "BROWSER_OUTCOME_UNKNOWN", Message: "The browser connection was lost after dispatch; observe before deciding whether to act again",
			}
		}
	}
	return result, action, err
}

func validateUploadPaths(workspace string, value interface{}) ([]string, error) {
	if strings.TrimSpace(workspace) == "" {
		return nil, apierr.Invalid("BROWSER_UPLOAD_FORBIDDEN", "Session workspace is unavailable", nil)
	}
	workspace, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return nil, apierr.Invalid("BROWSER_UPLOAD_FORBIDDEN", "Session workspace is unavailable", nil)
	}
	var items []interface{}
	switch typed := value.(type) {
	case []interface{}:
		items = typed
	case []string:
		items = make([]interface{}, len(typed))
		for i := range typed {
			items[i] = typed[i]
		}
	}
	if len(items) == 0 || len(items) > 20 {
		return nil, apierr.Invalid("BROWSER_UPLOAD_INVALID", "files must contain 1 to 20 workspace paths", nil)
	}
	paths := make([]string, 0, len(items))
	for _, item := range items {
		raw, ok := item.(string)
		if !ok || strings.TrimSpace(raw) == "" {
			return nil, apierr.Invalid("BROWSER_UPLOAD_INVALID", "each upload path must be a string", nil)
		}
		candidate := raw
		if !filepath.IsAbs(candidate) {
			candidate = filepath.Join(workspace, candidate)
		}
		candidate, err = filepath.EvalSymlinks(candidate)
		if err != nil {
			return nil, apierr.Invalid("BROWSER_UPLOAD_INVALID", "Upload file does not exist", nil)
		}
		rel, err := filepath.Rel(workspace, candidate)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return nil, apierr.Forbidden("BROWSER_UPLOAD_FORBIDDEN", "Uploads must stay inside the session workspace")
		}
		info, err := os.Stat(candidate)
		if err != nil || !info.Mode().IsRegular() {
			return nil, apierr.Invalid("BROWSER_UPLOAD_INVALID", "Upload path must be a regular file", nil)
		}
		paths = append(paths, candidate)
	}
	return paths, nil
}

func hasBrowserPreconditions(args map[string]interface{}) bool {
	if args == nil {
		return false
	}
	expected, ok := args["expectedState"].(map[string]interface{})
	if !ok {
		return false
	}
	tabID, tabOK := expected["tabId"].(string)
	expectedURL, urlOK := expected["expectedUrl"].(string)
	generationOK := false
	switch generation := expected["snapshotGeneration"].(type) {
	case int:
		generationOK = generation >= 0
	case float64:
		generationOK = generation >= 0 && generation == float64(int(generation))
	}
	return tabOK && strings.TrimSpace(tabID) != "" && urlOK && expectedURL != "" && generationOK
}

func externalBrowserTarget(args map[string]interface{}) bool {
	expected, _ := args["expectedState"].(map[string]interface{})
	raw, _ := expected["expectedUrl"].(string)
	target, err := url.Parse(raw)
	if err != nil {
		return true
	}
	if target.Scheme == "file" {
		return false
	}
	host := strings.ToLower(target.Hostname())
	if host == "localhost" || host == "0.0.0.0" || strings.HasSuffix(host, ".localhost") {
		return false
	}
	if ip := net.ParseIP(host); ip != nil && (ip.IsLoopback() || ip.IsUnspecified()) {
		return false
	}
	return true
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

func decodeRuntimeValue(value, out interface{}) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode browser runtime result: %w", err)
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("decode browser runtime result: %w", err)
	}
	return nil
}
