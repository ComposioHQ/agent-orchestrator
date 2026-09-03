package controllers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/browserruntime"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
)

const browserCapabilityHeader = "X-AO-Browser-Capability"

// BrowserService authorizes and executes session-scoped browser operations.
type BrowserService interface {
	Status(ctx context.Context, sessionID domain.SessionID, capability string) (browserruntime.Status, error)
	Observe(ctx context.Context, sessionID domain.SessionID, capability string, options browserruntime.ObserveOptions) (browserruntime.Result, browserruntime.Observation, error)
	Execute(ctx context.Context, sessionID domain.SessionID, capability, action string, args map[string]interface{}) (browserruntime.Result, string, error)
}

// BrowserController exposes the loopback-only browser command API.
type BrowserController struct {
	Svc BrowserService
}

// Register adds browser status and command routes to the API router.
func (c *BrowserController) Register(r chi.Router) {
	r.Get("/browser/status", c.status)
	r.Post("/browser/observe", c.observe)
	r.Post("/browser/actions", c.action)
	r.Post("/browser/commands", c.execute)
}

func (c *BrowserController) status(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodGet, "/api/v1/browser/status")
		return
	}
	sessionID := domain.SessionID(strings.TrimSpace(r.URL.Query().Get("sessionId")))
	if sessionID == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "SESSION_ID_REQUIRED", "sessionId is required", nil)
		return
	}
	status, err := c.Svc.Status(r.Context(), sessionID, r.Header.Get(browserCapabilityHeader))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, BrowserStatusResponse{
		SessionID: sessionID, Connected: status.Connected, ConnectedAt: status.ConnectedAt,
		Transport: status.Transport, State: status.State, Provider: status.Provider,
		Target: status.Target, RecommendedAction: status.RecommendedAction,
	})
}

func (c *BrowserController) observe(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodPost, "/api/v1/browser/observe")
		return
	}
	var in BrowserObserveRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if in.SessionID == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "SESSION_ID_REQUIRED", "sessionId is required", nil)
		return
	}
	result, observation, err := c.Svc.Observe(r.Context(), in.SessionID, r.Header.Get(browserCapabilityHeader), browserruntime.ObserveOptions{
		TabID: in.TabID, InteractiveOnly: in.InteractiveOnly, IncludeScreenshot: in.IncludeScreenshot, IncludeProblems: in.IncludeProblems,
	})
	if err != nil {
		writeBrowserError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, BrowserObserveResponse{
		RequestID: result.RequestID, SessionID: in.SessionID, Observation: observation,
	})
}

func (c *BrowserController) execute(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodPost, "/api/v1/browser/commands")
		return
	}
	var in BrowserCommandRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if in.SessionID == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "SESSION_ID_REQUIRED", "sessionId is required", nil)
		return
	}
	result, action, err := c.Svc.Execute(
		r.Context(),
		in.SessionID,
		r.Header.Get(browserCapabilityHeader),
		in.Action,
		in.Args,
	)
	if err != nil {
		writeBrowserError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, BrowserCommandResponse{
		RequestID: result.RequestID,
		SessionID: in.SessionID,
		Action:    action,
		Result:    result.Value,
	})
}

func (c *BrowserController) action(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, http.MethodPost, "/api/v1/browser/actions")
		return
	}
	var in BrowserActionRequest
	if err := decodeJSON(r, &in); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if in.SessionID == "" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "SESSION_ID_REQUIRED", "sessionId is required", nil)
		return
	}
	if (in.Ref == "") == (in.Target == nil) && in.Action != "press" && in.Action != "scroll" {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "BROWSER_TARGET_REQUIRED", "Provide exactly one of ref or target", nil)
		return
	}
	args := map[string]interface{}{
		"expectedState": map[string]interface{}{
			"tabId": in.ExpectedState.TabID, "expectedUrl": in.ExpectedState.ExpectedURL,
			"snapshotGeneration": in.ExpectedState.SnapshotGeneration,
		},
	}
	if in.Ref != "" {
		args["ref"] = in.Ref
	}
	if in.Target != nil {
		args["target"] = in.Target
	}
	switch in.Action {
	case "fill", "type":
		args["text"] = in.Text
	case "press":
		args["key"] = in.Key
	case "scroll":
		args["direction"], args["amount"] = in.Direction, in.Amount
	case "select":
		args["value"] = in.Value
	}
	if in.AllowStaleRemap {
		args["allowStaleRemap"] = true
	}
	if in.Confirmed {
		args["confirmed"] = true
	}
	if in.WaitAfter != nil {
		args["waitAfter"] = in.WaitAfter
	}
	result, action, err := c.Svc.Execute(r.Context(), in.SessionID, r.Header.Get(browserCapabilityHeader), in.Action, args)
	if err != nil {
		writeBrowserError(w, r, err)
		return
	}
	data, err := json.Marshal(result.Value)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	var typed BrowserActionResult
	if err := json.Unmarshal(data, &typed); err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, BrowserActionResponse{
		RequestID: result.RequestID, SessionID: in.SessionID, Action: action, Result: typed,
	})
}

func writeBrowserError(w http.ResponseWriter, r *http.Request, err error) {
	if errors.Is(err, browserruntime.ErrUnavailable) {
		envelope.WriteAPIError(w, r, http.StatusServiceUnavailable, "unavailable", "BROWSER_RUNTIME_UNAVAILABLE", "Desktop browser runtime is not connected", nil)
		return
	}
	if errors.Is(err, browserruntime.ErrOutcomeUnknown) {
		envelope.WriteAPIError(w, r, http.StatusServiceUnavailable, "unavailable", "BROWSER_RUNTIME_RECOVERING", "Browser runtime disconnected during the command; retry the observation", nil)
		return
	}
	var commandErr browserruntime.CommandError
	if errors.As(err, &commandErr) {
		status := http.StatusUnprocessableEntity
		typeName := "unprocessable"
		switch commandErr.Code {
		case "INVALID_ARGUMENT", "URL_REQUIRED", "REFERENCE_REQUIRED", "TAB_ID_REQUIRED":
			status = http.StatusBadRequest
			typeName = "bad_request"
		case "STALE_REFERENCE", "TAB_NOT_FOUND", "TARGET_CHANGED", "URL_CHANGED", "SNAPSHOT_CHANGED", "BROWSER_OUTCOME_UNKNOWN":
			status = http.StatusConflict
			typeName = "conflict"
		case "BROWSER_TARGET_UNAVAILABLE":
			status = http.StatusServiceUnavailable
			typeName = "unavailable"
		}
		envelope.WriteAPIError(w, r, status, typeName, commandErr.Code, commandErr.Message, nil)
		return
	}
	envelope.WriteError(w, r, err)
}
