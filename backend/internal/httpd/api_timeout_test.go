package httpd

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
)

type timeoutProbeSessionService struct {
	controllers.SessionService
	genericBudget chan time.Duration
	switchBudget  chan time.Duration
	switchDelay   time.Duration
}

func (s *timeoutProbeSessionService) List(ctx context.Context, _ sessionsvc.ListFilter) ([]domain.Session, error) {
	s.genericBudget <- remainingRequestBudget(ctx)
	return nil, nil
}

func (s *timeoutProbeSessionService) SwitchAgent(
	ctx context.Context,
	id domain.SessionID,
	in sessionsvc.SwitchAgentInput,
) (domain.AgentSwitch, error) {
	s.switchBudget <- remainingRequestBudget(ctx)
	timer := time.NewTimer(s.switchDelay)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
		return domain.AgentSwitch{}, ctx.Err()
	}

	now := time.Now().UTC()
	return domain.AgentSwitch{
		ID:            "switch-timeout-probe",
		SessionID:     id,
		TargetHarness: in.TargetHarness,
		State:         domain.AgentSwitchCompleted,
		RequestedAt:   now,
		UpdatedAt:     now,
	}, nil
}

func remainingRequestBudget(ctx context.Context) time.Duration {
	deadline, ok := ctx.Deadline()
	if !ok {
		return 0
	}
	return time.Until(deadline)
}

func TestSwitchAgentRouteTimeouts(t *testing.T) {
	tests := []struct {
		name                string
		configuredTimeout   time.Duration
		switchDelay         time.Duration
		checkGenericTimeout bool
		minimumSwitchBudget time.Duration
	}{
		{
			name:                "outlives generic request timeout",
			configuredTimeout:   20 * time.Millisecond,
			switchDelay:         75 * time.Millisecond,
			checkGenericTimeout: true,
			minimumSwitchBudget: minimumSwitchAgentRequestTimeout,
		},
		{
			name:                "preserves longer configured timeout",
			configuredTimeout:   8 * time.Minute,
			minimumSwitchBudget: 8 * time.Minute,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			svc := &timeoutProbeSessionService{
				genericBudget: make(chan time.Duration, 1),
				switchBudget:  make(chan time.Duration, 1),
				switchDelay:   tt.switchDelay,
			}
			router := NewRouterWithControl(
				config.Config{RequestTimeout: tt.configuredTimeout},
				discardLogger(),
				nil,
				APIDeps{Sessions: svc},
				ControlDeps{},
			)

			if tt.checkGenericTimeout {
				genericResponse := httptest.NewRecorder()
				router.ServeHTTP(genericResponse, httptest.NewRequest(http.MethodGet, "/api/v1/sessions", nil))
				if genericResponse.Code != http.StatusOK {
					t.Fatalf("GET sessions status = %d, want 200", genericResponse.Code)
				}
				genericBudget := <-svc.genericBudget
				if genericBudget <= 0 || genericBudget > 2*tt.configuredTimeout {
					t.Fatalf("generic request budget = %s, want approximately %s", genericBudget, tt.configuredTimeout)
				}
			}

			started := time.Now()
			switchRequest := httptest.NewRequest(
				http.MethodPost,
				"/api/v1/sessions/ao-1/switch-agent",
				bytes.NewBufferString(`{"targetHarness":"codex"}`),
			)
			switchRequest.Header.Set("Content-Type", "application/json")
			switchResponse := httptest.NewRecorder()
			router.ServeHTTP(switchResponse, switchRequest)
			if switchResponse.Code != http.StatusOK {
				t.Fatalf("POST switch-agent status = %d, want 200; body=%s", switchResponse.Code, switchResponse.Body.String())
			}
			if tt.switchDelay > 0 && time.Since(started) < tt.switchDelay {
				t.Fatalf("POST switch-agent completed in %s, want at least %s", time.Since(started), tt.switchDelay)
			}
			if switchBudget := <-svc.switchBudget; switchBudget < tt.minimumSwitchBudget-time.Second {
				t.Fatalf("switch request budget = %s, want at least %s", switchBudget, tt.minimumSwitchBudget)
			}
		})
	}
}
