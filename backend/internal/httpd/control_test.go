package httpd

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// TestShutdownGuard verifies that POST /shutdown only fires for a trusted local
// caller: a loopback Host with no Origin header. A cross-site Origin or a
// non-loopback (DNS-rebinding) Host must be rejected without triggering the
// shutdown side effect.
func TestShutdownGuard(t *testing.T) {
	cases := []struct {
		name       string
		host       string
		origin     string
		wantStatus int
		wantFired  bool
	}{
		{name: "loopback no origin", host: "127.0.0.1:3001", wantStatus: http.StatusAccepted, wantFired: true},
		{name: "localhost no origin", host: "localhost:3001", wantStatus: http.StatusAccepted, wantFired: true},
		{name: "cross-site origin", host: "127.0.0.1:3001", origin: "https://evil.example", wantStatus: http.StatusForbidden, wantFired: false},
		{name: "rebinding host", host: "evil.example", wantStatus: http.StatusForbidden, wantFired: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fired := false
			r := NewRouterWithControl(config.Config{}, discardLogger(), nil, APIDeps{}, ControlDeps{
				RequestShutdown: func() { fired = true },
			})

			req := httptest.NewRequest(http.MethodPost, "http://"+tc.host+"/shutdown", nil)
			req.Host = tc.host
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", rec.Code, tc.wantStatus)
			}
			if fired != tc.wantFired {
				t.Fatalf("shutdown fired = %v, want %v", fired, tc.wantFired)
			}
		})
	}
}

func TestAgentSwitchPolicyControlRoutesAreTypedAndLoopbackOnly(t *testing.T) {
	policy := &policyControlFake{authorization: domain.AgentSwitchReportingAuthorization{ConsentGeneration: "generation-off"}}
	r := NewRouterWithControl(config.Config{}, discardLogger(), nil, APIDeps{}, ControlDeps{AgentSwitchPolicy: policy})
	prepare := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/internal/agent-switch-observability/prepare-disable", nil)
	prepare.Host = "127.0.0.1"
	prepared := httptest.NewRecorder()
	r.ServeHTTP(prepared, prepare)
	if prepared.Code != http.StatusOK || policy.prepared != 1 {
		t.Fatalf("prepare status=%d calls=%d", prepared.Code, policy.prepared)
	}
	body, _ := json.Marshal(map[string]any{"consentGeneration": "generation-off", "eventsEnabled": false})
	apply := httptest.NewRequest(http.MethodPost, "http://127.0.0.1/internal/agent-switch-observability/apply-policy", bytes.NewReader(body))
	apply.Host = "127.0.0.1"
	applied := httptest.NewRecorder()
	r.ServeHTTP(applied, apply)
	if applied.Code != http.StatusOK || policy.appliedGeneration != "generation-off" || policy.appliedEnabled {
		t.Fatalf("apply status=%d fake=%+v", applied.Code, policy)
	}
	remote := httptest.NewRequest(http.MethodPost, "http://evil.example/internal/agent-switch-observability/prepare-disable", nil)
	remote.Host = "evil.example"
	denied := httptest.NewRecorder()
	r.ServeHTTP(denied, remote)
	if denied.Code != http.StatusForbidden {
		t.Fatalf("remote status=%d", denied.Code)
	}
}

type policyControlFake struct {
	authorization     domain.AgentSwitchReportingAuthorization
	prepared          int
	appliedGeneration string
	appliedEnabled    bool
}

func (f *policyControlFake) PrepareDisable(context.Context) error {
	f.prepared++
	f.authorization.Enabled = false
	return nil
}
func (f *policyControlFake) ApplyPolicy(_ context.Context, generation string, enabled bool) error {
	f.appliedGeneration = generation
	f.appliedEnabled = enabled
	return nil
}
func (f *policyControlFake) Authorization() domain.AgentSwitchReportingAuthorization {
	return f.authorization
}
