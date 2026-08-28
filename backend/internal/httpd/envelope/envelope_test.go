package envelope

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/observe/ownership"
)

func TestWriteErrorSerializesWrappedReportingOwner(t *testing.T) {
	err := fmt.Errorf("outer: %w", fmt.Errorf("middle: %w", ownership.Own(
		apierr.Internal("AGENT_SWITCH_FAILED", "Agent switch failed"),
		ownership.OwnerAgentSwitchSaga,
	)))
	req, captured := WithErrorCapture(httptest.NewRequest(http.MethodPost, "/api/v1/sessions/s1/switch-agent", nil))
	rec := httptest.NewRecorder()

	WriteError(rec, req, err)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	var body APIError
	if decodeErr := json.Unmarshal(rec.Body.Bytes(), &body); decodeErr != nil {
		t.Fatalf("decode response: %v", decodeErr)
	}
	if body.ReportingOwner != ownership.OwnerAgentSwitchSaga {
		t.Fatalf("reporting_owner = %q, want %q", body.ReportingOwner, ownership.OwnerAgentSwitchSaga)
	}
	if body.Code != "AGENT_SWITCH_FAILED" || body.Message != "Agent switch failed" {
		t.Fatalf("body = %+v, want normal API error presentation", body)
	}
	gotCapture := captured()
	if !errors.Is(gotCapture.Err, err) || gotCapture.ReportingOwner != ownership.OwnerAgentSwitchSaga {
		t.Fatalf("captured = %+v, want raw error and saga owner", gotCapture)
	}
}

func TestWriteErrorOmitsUnknownReportingOwner(t *testing.T) {
	req, captured := WithErrorCapture(httptest.NewRequest(http.MethodGet, "/api/v1/projects", nil))
	rec := httptest.NewRecorder()
	err := invalidOwnedError{err: errors.New("boom")}

	WriteError(rec, req, err)

	var raw map[string]any
	if decodeErr := json.Unmarshal(rec.Body.Bytes(), &raw); decodeErr != nil {
		t.Fatalf("decode response: %v", decodeErr)
	}
	if _, ok := raw["reporting_owner"]; ok {
		t.Fatalf("response exposed invalid reporting owner: %s", rec.Body.String())
	}
	if got := captured().ReportingOwner; got != "" {
		t.Fatalf("captured reporting owner = %q, want empty", got)
	}
}

func TestWriteAPIErrorRemainsUnowned(t *testing.T) {
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/sessions/s1/switch-agent", nil)

	WriteAPIError(rec, req, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)

	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if _, ok := body["reporting_owner"]; ok {
		t.Fatalf("direct validation response unexpectedly has reporting_owner: %s", rec.Body.String())
	}
}

type invalidOwnedError struct{ err error }

func (e invalidOwnedError) Error() string { return e.err.Error() }
func (e invalidOwnedError) Unwrap() error { return e.err }
func (invalidOwnedError) ObservabilityOwner() ownership.Owner {
	return ownership.Owner("untrusted")
}
