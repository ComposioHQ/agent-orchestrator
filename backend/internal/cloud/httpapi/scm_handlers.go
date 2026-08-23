package httpapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

type SCMLinkService interface {
	StartInstall(context.Context, tenant.Identity) (scm.InstallRedirect, error)
	CompleteInstall(context.Context, scm.CallbackParams) (domain.SCMInstallation, error)
}

type SCMWebhookProcessor interface {
	Process(context.Context, string, string, string, []byte) (scm.WebhookResult, error)
}

type SCMOptions struct {
	Link    SCMLinkService
	Webhook SCMWebhookProcessor
}

type scmInstallStartResponse struct {
	InstallURL string    `json:"installUrl"`
	ExpiresAt  time.Time `json:"expiresAt"`
}

func (s *Server) registerSCMRoutes(router chi.Router, rateLimit func(http.Handler) http.Handler) {
	if s.scm.Link != nil {
		router.With(s.requirePrincipal).Post("/api/cloud/v1/orgs/{orgId}/github/installations/start", s.startSCMInstall)
		router.With(rateLimit).Get("/api/cloud/v1/github/installations/callback", s.completeSCMInstall)
	}
	if s.scm.Webhook != nil {
		router.With(rateLimit).Post("/api/cloud/v1/github/webhook", s.receiveSCMWebhook)
	}
}

func (s *Server) scmAdminIdentity(w http.ResponseWriter, r *http.Request) (tenant.Identity, bool) {
	principal, ok := principalFromContext(r.Context())
	if !ok {
		writeError(w, r, http.StatusUnauthorized, "unauthorized", "AUTH_REQUIRED", "valid AO access token required")
		return tenant.Identity{}, false
	}
	orgID := strings.TrimSpace(chi.URLParam(r, "orgId"))
	memberships, err := s.store.ListMemberships(r.Context(), principal)
	if err != nil {
		s.internalError(w, r, "list memberships for scm install", err)
		return tenant.Identity{}, false
	}
	for _, membership := range memberships {
		if membership.OrgID != orgID {
			continue
		}
		if membership.Role != "owner" && membership.Role != "admin" {
			writeError(w, r, http.StatusForbidden, "forbidden", "ORG_ADMIN_REQUIRED", "organization administrator access is required")
			return tenant.Identity{}, false
		}
		identity := tenant.Identity{OrgID: orgID, OrgSlug: membership.OrgSlug, UserID: principal.UserID, Role: membership.Role}
		if identity.Valid() {
			return identity, true
		}
	}
	writeError(w, r, http.StatusForbidden, "forbidden", "ORG_FORBIDDEN", "this account is not a member of the requested organization")
	return tenant.Identity{}, false
}

func (s *Server) startSCMInstall(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	identity, ok := s.scmAdminIdentity(w, r)
	if !ok {
		return
	}
	redirect, err := s.scm.Link.StartInstall(r.Context(), identity)
	if err != nil {
		s.internalError(w, r, "start scm install", err)
		return
	}
	writeJSON(w, http.StatusCreated, scmInstallStartResponse{InstallURL: redirect.InstallURL, ExpiresAt: redirect.ExpiresAt})
}

func (s *Server) completeSCMInstall(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	externalID, _ := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("installation_id")), 10, 64)
	installation, err := s.scm.Link.CompleteInstall(r.Context(), scm.CallbackParams{
		State: r.URL.Query().Get("state"), ExternalInstallationID: externalID,
	})
	if err != nil {
		status := http.StatusBadRequest
		code := "SCM_INSTALL_STATE_INVALID"
		if errors.Is(err, scm.ErrInstallationClaimed) {
			status, code = http.StatusConflict, "SCM_INSTALLATION_ALREADY_LINKED"
		}
		writeError(w, r, status, "bad_request", code, "GitHub installation could not be linked")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"installationId": installation.ID})
}

func (s *Server) receiveSCMWebhook(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, scm.MaxWebhookBodyBytes))
	if err != nil {
		writeError(w, r, http.StatusRequestEntityTooLarge, "bad_request", "WEBHOOK_TOO_LARGE", "webhook body is too large")
		return
	}
	result, err := s.scm.Webhook.Process(r.Context(), r.Header.Get(scm.EventHeader), r.Header.Get(scm.DeliveryHeader), r.Header.Get(scm.SignatureHeader), body)
	if errors.Is(err, scm.ErrInvalidSignature) {
		writeError(w, r, http.StatusUnauthorized, "unauthorized", "WEBHOOK_SIGNATURE_INVALID", "webhook signature is invalid")
		return
	}
	if errors.Is(err, scm.ErrPayloadTooLarge) {
		writeError(w, r, http.StatusRequestEntityTooLarge, "bad_request", "WEBHOOK_TOO_LARGE", "webhook body is too large")
		return
	}
	if errors.Is(err, scm.ErrWebhookReceiptUnavailable) {
		writeError(w, r, http.StatusServiceUnavailable, "unavailable", "WEBHOOK_RECEIPT_UNAVAILABLE", "webhook receipt is temporarily unavailable")
		return
	}
	if err != nil && !result.Durable {
		if errors.Is(err, scm.ErrInvalidWebhookHeaders) {
			writeError(w, r, http.StatusBadRequest, "bad_request", "WEBHOOK_HEADERS_INVALID", "webhook headers are invalid")
			return
		}
		s.internalError(w, r, "process scm webhook", err)
		return
	}
	status := "accepted"
	if result.Duplicate {
		status = "duplicate"
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": status})
}
