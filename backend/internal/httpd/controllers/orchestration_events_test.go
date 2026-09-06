package controllers_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/controllers"
	"github.com/go-chi/chi/v5"
)

type orchestrationReaderFake struct {
	project      domain.ProjectID
	limit        int
	retryProject domain.ProjectID
}

func (f *orchestrationReaderFake) RetryDeadLetterOrchestrationEvent(_ context.Context, project domain.ProjectID, _ string, _ time.Time) (bool, error) {
	f.retryProject = project
	return true, nil
}

func (f *orchestrationReaderFake) ListOrchestrationEvents(_ context.Context, p domain.ProjectID, limit int) ([]domain.OrchestrationEvent, error) {
	f.project = p
	f.limit = limit
	now := time.Now().UTC()
	return []domain.OrchestrationEvent{{ID: "e", ProjectID: p, WorkerID: "w", Kind: domain.OrchestrationWorkerTurnSettled, SourceRevision: "r", State: domain.OrchestrationSubmitted, AttemptCount: 1, EnqueuedAt: now, NextAttemptAt: now, DestinationSessionID: "o", SubmittedAt: now}}, nil
}

func TestRetryOrchestrationEventIsProjectScoped(t *testing.T) {
	f := &orchestrationReaderFake{}
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) { (&controllers.OrchestrationEventsController{Store: f}).Register(r) })
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/v1/projects/p/orchestration-events/e/retry", nil))
	if w.Code != http.StatusOK || f.retryProject != "p" {
		t.Fatalf("status=%d project=%q body=%s", w.Code, f.retryProject, w.Body.String())
	}
}

func TestListOrchestrationEventsExposesDeliveryObservability(t *testing.T) {
	f := &orchestrationReaderFake{}
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) { (&controllers.OrchestrationEventsController{Store: f}).Register(r) })
	req := httptest.NewRequest(http.MethodGet, "/api/v1/projects/p/orchestration-events?limit=7", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
	var body struct {
		Events []controllers.OrchestrationEventResponse `json:"events"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if f.project != "p" || f.limit != 7 || len(body.Events) != 1 || body.Events[0].DestinationSessionID != "o" || body.Events[0].SubmittedAt == nil {
		t.Fatalf("project=%q limit=%d body=%+v", f.project, f.limit, body)
	}
}

func TestListOrchestrationEventsRejectsInvalidLimit(t *testing.T) {
	r := chi.NewRouter()
	r.Route("/api/v1", func(r chi.Router) {
		(&controllers.OrchestrationEventsController{Store: &orchestrationReaderFake{}}).Register(r)
	})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/projects/p/orchestration-events?limit=zero", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}
