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
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
)

type timeoutProbeSessionService struct {
	controllers.SessionService
	genericBudget      chan time.Duration
	switchBudget       chan time.Duration
	orchestratorBudget chan time.Duration
	orchestratorDelay  time.Duration
}

func (s *timeoutProbeSessionService) SpawnOrchestrator(
	ctx context.Context,
	projectID domain.ProjectID,
	_ bool,
	_ domain.SessionMode,
) (domain.Session, error) {
	s.orchestratorBudget <- remainingRequestBudget(ctx)
	select {
	case <-time.After(s.orchestratorDelay):
		now := time.Now().UTC()
		return domain.Session{SessionRecord: domain.SessionRecord{
			ID:        domain.SessionID(string(projectID) + "-orchestrator"),
			ProjectID: projectID,
			Kind:      domain.KindOrchestrator,
			CreatedAt: now,
			UpdatedAt: now,
		}}, nil
	case <-ctx.Done():
		return domain.Session{}, ctx.Err()
	}
}

func (s *timeoutProbeSessionService) List(ctx context.Context, _ sessionsvc.ListFilter) ([]domain.Session, error) {
	s.genericBudget <- remainingRequestBudget(ctx)
	return nil, nil
}

func TestSpawnOrchestratorRouteOutlivesOrdinaryTimeout(t *testing.T) {
	const configuredTimeout = 25 * time.Millisecond
	svc := &timeoutProbeSessionService{
		genericBudget:      make(chan time.Duration, 1),
		switchBudget:       make(chan time.Duration, 1),
		orchestratorBudget: make(chan time.Duration, 1),
		orchestratorDelay:  2 * configuredTimeout,
	}
	router := NewRouterWithControl(
		config.Config{RequestTimeout: configuredTimeout},
		discardLogger(),
		nil,
		APIDeps{Sessions: svc},
		ControlDeps{},
	)

	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/orchestrators",
		bytes.NewBufferString(`{"projectId":"ao","clean":true}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("POST orchestrators status = %d, want 201; body=%s", response.Code, response.Body.String())
	}

	budget := <-svc.orchestratorBudget
	if budget <= configuredTimeout {
		t.Fatalf("orchestrator request budget = %s, want more than ordinary timeout %s", budget, configuredTimeout)
	}
	if budget > config.DefaultOrchestratorSpawnTimeout {
		t.Fatalf("orchestrator request budget = %s, want no more than %s", budget, config.DefaultOrchestratorSpawnTimeout)
	}
}

func TestSpawnOrchestratorRecordsRendererSource(t *testing.T) {
	svc := &timeoutProbeSessionService{
		orchestratorBudget: make(chan time.Duration, 1),
	}
	sink := &captureSink{}
	router := NewRouterWithControl(
		config.Config{},
		discardLogger(),
		nil,
		APIDeps{Sessions: svc, Telemetry: sink},
		ControlDeps{},
	)

	request := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/orchestrators",
		bytes.NewBufferString(`{"projectId":"ao","clean":true,"source":"restart"}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("POST orchestrators status = %d, want 201; body=%s", response.Code, response.Body.String())
	}

	var got *ports.TelemetryEvent
	for i := range sink.events {
		if sink.events[i].Name == "ao.orchestrator.spawn_requested" {
			got = &sink.events[i]
			break
		}
	}
	if got == nil {
		t.Fatalf("telemetry events = %#v, want ao.orchestrator.spawn_requested", sink.events)
	}
	if got.ProjectID == nil || *got.ProjectID != "ao" {
		t.Fatalf("project id = %#v, want ao", got.ProjectID)
	}
	if got.RequestID == "" {
		t.Fatal("request id is empty")
	}
	if got.Payload["source"] != "restart" || got.Payload["clean"] != true {
		t.Fatalf("payload = %#v, want source=restart clean=true", got.Payload)
	}
}

func (s *timeoutProbeSessionService) SwitchAgent(
	ctx context.Context,
	id domain.SessionID,
	in sessionsvc.SwitchAgentInput,
) (domain.AgentSwitch, error) {
	s.switchBudget <- remainingRequestBudget(ctx)
	now := time.Now().UTC()
	return domain.AgentSwitch{
		ID:            "switch-timeout-probe",
		SessionID:     id,
		TargetHarness: in.TargetHarness,
		State:         domain.AgentSwitchPreparingHandoff,
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

func TestSwitchAgentRouteUsesOrdinaryTimeoutAndReturnsAccepted(t *testing.T) {
	const configuredTimeout = 250 * time.Millisecond
	svc := &timeoutProbeSessionService{
		genericBudget: make(chan time.Duration, 1),
		switchBudget:  make(chan time.Duration, 1),
	}
	router := NewRouterWithControl(
		config.Config{RequestTimeout: configuredTimeout},
		discardLogger(),
		nil,
		APIDeps{Sessions: svc},
		ControlDeps{},
	)

	genericResponse := httptest.NewRecorder()
	router.ServeHTTP(genericResponse, httptest.NewRequest(http.MethodGet, "/api/v1/sessions", nil))
	if genericResponse.Code != http.StatusOK {
		t.Fatalf("GET sessions status = %d, want 200", genericResponse.Code)
	}
	genericBudget := <-svc.genericBudget

	switchRequest := httptest.NewRequest(
		http.MethodPost,
		"/api/v1/sessions/ao-1/switch-agent",
		bytes.NewBufferString(`{"targetHarness":"codex"}`),
	)
	switchRequest.Header.Set("Content-Type", "application/json")
	switchResponse := httptest.NewRecorder()
	router.ServeHTTP(switchResponse, switchRequest)
	if switchResponse.Code != http.StatusAccepted {
		t.Fatalf("POST switch-agent status = %d, want 202; body=%s", switchResponse.Code, switchResponse.Body.String())
	}
	switchBudget := <-svc.switchBudget
	for name, budget := range map[string]time.Duration{"generic": genericBudget, "switch": switchBudget} {
		if budget <= 0 || budget > configuredTimeout {
			t.Fatalf("%s request budget = %s, want ordinary timeout no greater than %s", name, budget, configuredTimeout)
		}
	}
	if delta := genericBudget - switchBudget; delta < -50*time.Millisecond || delta > 50*time.Millisecond {
		t.Fatalf("generic and switch budgets differ by %s: generic=%s switch=%s", delta, genericBudget, switchBudget)
	}
}
