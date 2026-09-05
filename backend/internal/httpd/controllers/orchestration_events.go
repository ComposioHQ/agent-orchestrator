package controllers

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/go-chi/chi/v5"
)

type OrchestrationEventReader interface {
	ListOrchestrationEvents(context.Context, domain.ProjectID, int) ([]domain.OrchestrationEvent, error)
	RetryDeadLetterOrchestrationEvent(context.Context, string, time.Time) (bool, error)
}
type OrchestrationEventsController struct{ Store OrchestrationEventReader }

func (c *OrchestrationEventsController) Register(r chi.Router) {
	r.Get("/projects/{id}/orchestration-events", c.list)
	r.Post("/projects/{id}/orchestration-events/{eventId}/retry", c.retry)
}
func (c *OrchestrationEventsController) retry(w http.ResponseWriter, r *http.Request) {
	if c.Store == nil {
		apispec.NotImplemented(w, r, http.MethodPost, "/api/v1/projects/{id}/orchestration-events/{eventId}/retry")
		return
	}
	changed, err := c.Store.RetryDeadLetterOrchestrationEvent(r.Context(), chi.URLParam(r, "eventId"), time.Now().UTC())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	if !changed {
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "ORCHESTRATION_EVENT_NOT_DEAD_LETTER", "event is not available for explicit retry", nil)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, RetryOrchestrationEventResponse{Retried: true})
}
func (c *OrchestrationEventsController) list(w http.ResponseWriter, r *http.Request) {
	if c.Store == nil {
		apispec.NotImplemented(w, r, http.MethodGet, "/api/v1/projects/{id}/orchestration-events")
		return
	}
	limit := 100
	if raw := r.URL.Query().Get("limit"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 {
			envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_LIMIT", "limit must be a positive integer", nil)
			return
		}
		if parsed < limit {
			limit = parsed
		}
	}
	events, err := c.Store.ListOrchestrationEvents(r.Context(), domain.ProjectID(chi.URLParam(r, "id")), limit)
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	out := make([]OrchestrationEventResponse, len(events))
	for i, e := range events {
		out[i] = orchestrationEventResponse(e)
	}
	envelope.WriteJSON(w, http.StatusOK, ListOrchestrationEventsResponse{Events: out})
}
func orchestrationEventResponse(e domain.OrchestrationEvent) OrchestrationEventResponse {
	return OrchestrationEventResponse{ID: e.ID, ProjectID: e.ProjectID, WorkerID: e.WorkerID, Kind: e.Kind, SourceRevision: e.SourceRevision, State: e.State, AttemptCount: e.AttemptCount, EnqueuedAt: e.EnqueuedAt, NextAttemptAt: e.NextAttemptAt, LeaseExpiresAt: timePointer(e.LeaseExpiresAt), DestinationSessionID: e.DestinationSessionID, SubmittedAt: timePointer(e.SubmittedAt), AcknowledgedAt: timePointer(e.AcknowledgedAt), AttentionRequiredAt: timePointer(e.AttentionRequiredAt), LastError: e.LastError}
}
func timePointer(value time.Time) *time.Time {
	if value.IsZero() {
		return nil
	}
	return &value
}
