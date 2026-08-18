package controllers

import (
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	projectcontrolsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/projectcontrol"
)

// ProjectControlController owns the outcome-centric project-control routes.
type ProjectControlController struct{ Svc projectcontrolsvc.Manager }

// Register mounts the slice-one project-control routes.
func (c *ProjectControlController) Register(r chi.Router) {
	r.Get("/projects/{id}/control", c.get)
	r.Put("/projects/{id}/outcome", c.setOutcome)
}

func (c *ProjectControlController) get(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/projects/{id}/control")
		return
	}
	result, err := c.Svc.Get(r.Context(), domain.ProjectID(chi.URLParam(r, "id")))
	if err != nil {
		writeProjectControlError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, result)
}

func (c *ProjectControlController) setOutcome(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "PUT", "/api/v1/projects/{id}/outcome")
		return
	}
	var request SetProjectOutcomeRequest
	if err := decodeJSONStrict(r, &request); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	if !request.expectedRevisionSet || !request.criteriaSet || request.Criteria == nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_PROJECT_OUTCOME", "expectedRevision and criteria are required; criteria must be an array", nil)
		return
	}
	criteria := make([]domain.AcceptanceCriterionInput, 0, len(request.Criteria))
	for _, criterion := range request.Criteria {
		criteria = append(criteria, domain.AcceptanceCriterionInput{
			ID:                 domain.AcceptanceCriterionID(criterion.ID),
			Statement:          criterion.Statement,
			VerificationMethod: criterion.VerificationMethod,
			DisplayOrder:       criterion.DisplayOrder,
		})
	}
	result, err := c.Svc.SetOutcome(r.Context(), domain.ProjectID(chi.URLParam(r, "id")), domain.SetOutcomeInput{
		Statement: request.Statement, Criteria: criteria,
		ExpectedRevision: request.ExpectedRevision, IdempotencyKey: request.IdempotencyKey,
	})
	if err != nil {
		writeProjectControlError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, result)
}

func writeProjectControlError(w http.ResponseWriter, r *http.Request, err error) {
	var conflict *domain.ProjectControlRevisionConflictError
	switch {
	case errors.Is(err, domain.ErrProjectNotFound):
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "PROJECT_NOT_FOUND", "Unknown project", nil)
	case errors.As(err, &conflict):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "PROJECT_CONTROL_REVISION_CONFLICT", "Project control revision conflict", map[string]any{"currentRevision": conflict.CurrentRevision})
	case errors.Is(err, domain.ErrProjectControlIdempotencyConflict):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "PROJECT_CONTROL_IDEMPOTENCY_CONFLICT", "Idempotency key was already used for a different project outcome request", nil)
	case errors.Is(err, domain.ErrAcceptanceCriterionIDUnknown):
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "ACCEPTANCE_CRITERION_ID_UNKNOWN", "Acceptance criterion id is unknown or belongs to another outcome", nil)
	case errors.Is(err, domain.ErrDuplicateCriterionID):
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "DUPLICATE_ACCEPTANCE_CRITERION_ID", "Acceptance criterion ids must be unique", nil)
	case errors.Is(err, domain.ErrDuplicateCriterionDisplayOrder):
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "DUPLICATE_ACCEPTANCE_CRITERION_DISPLAY_ORDER", "Acceptance criterion displayOrder values must be unique", nil)
	case isProjectControlValidationError(err):
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_PROJECT_OUTCOME", err.Error(), nil)
	default:
		envelope.WriteError(w, r, err)
	}
}

func isProjectControlValidationError(err error) bool {
	for _, message := range []string{
		"expected revision must be non-negative",
		"idempotency key is required",
		"outcome statement is required",
		"acceptance criterion statement is required",
		"acceptance criterion verification method is required",
		"acceptance criterion display order must be non-negative",
	} {
		if err != nil && err.Error() == message {
			return true
		}
	}
	return false
}
