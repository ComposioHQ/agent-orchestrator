package httpapi

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// maxWebhookBodyBytes bounds a webhook body. GitHub's own limit is 25 MB, but
// the events this control plane acts on are far smaller and the body is held
// in memory for signature verification.
const maxWebhookBodyBytes = 2 << 20

// SCMLinkService is the install/link surface the handlers need.
type SCMLinkService interface {
	StartInstall(ctx context.Context, tenant tenant.Identity) (scm.InstallRedirect, string, error)
	CompleteInstall(ctx context.Context, params scm.CallbackParams) (domain.SCMInstallation, error)
	ListInstallations(ctx context.Context, tenant tenant.Identity) ([]domain.SCMInstallation, error)
	ListRepositories(ctx context.Context, tenant tenant.Identity, installationID string) ([]domain.SCMRepository, error)
	SyncInstallation(ctx context.Context, tenant tenant.Identity, installationID string) ([]domain.SCMRepository, error)
	SetAllowlist(ctx context.Context, tenant tenant.Identity, installationID string, repositoryFullNames []string) ([]domain.SCMRepository, error)
	Unlink(ctx context.Context, tenant tenant.Identity, installationID string) error
}

// SCMWebhookProcessor verifies and applies one provider webhook delivery.
type SCMWebhookProcessor interface {
	Process(ctx context.Context, event, deliveryID, signature string, body []byte) (scm.WebhookResult, error)
}

// SCMOptions carries the SCM dependencies into the server. All of it is
// optional: when Link is nil the SCM routes answer 404 rather than existing in
// a half-configured state.
type SCMOptions struct {
	Link SCMLinkService
	// Webhook may be nil even when Link is set, if no webhook secret is
	// configured. The endpoint then refuses deliveries instead of accepting
	// unverified ones.
	Webhook SCMWebhookProcessor
	// InstallCompletionURL is where the browser is redirected after the setup
	// callback. Empty answers with JSON instead.
	InstallCompletionURL string
}

type scmInstallStartResponse struct {
	InstallURL string    `json:"installUrl"`
	ExpiresAt  time.Time `json:"expiresAt"`
}

type scmInstallation struct {
	ID                  string    `json:"id"`
	OrgID               string    `json:"orgId"`
	Provider            string    `json:"provider"`
	AccountLogin        string    `json:"accountLogin"`
	AccountType         string    `json:"accountType"`
	AppSlug             string    `json:"appSlug"`
	RepositorySelection string    `json:"repositorySelection"`
	Status              string    `json:"status"`
	CreatedAt           time.Time `json:"createdAt"`
	UpdatedAt           time.Time `json:"updatedAt"`
}

type scmRepository struct {
	ID       string `json:"id"`
	FullName string `json:"fullName"`
	Private  bool   `json:"private"`
	Allowed  bool   `json:"allowed"`
}

type scmInstallationListResponse struct {
	Installations []scmInstallation `json:"installations"`
}

type scmRepositoryListResponse struct {
	Repositories []scmRepository `json:"repositories"`
}

type scmAllowlistRequest struct {
	Repositories []string `json:"repositories"`
}

// The external installation id is deliberately absent from every response.
// It is a capability-shaped identifier: knowing it is one of the inputs to a
// link-hijack attempt, and no client needs it.
func toSCMInstallation(installation domain.SCMInstallation) scmInstallation {
	return scmInstallation{
		ID:                  installation.ID,
		OrgID:               installation.OrgID,
		Provider:            installation.Provider,
		AccountLogin:        installation.AccountLogin,
		AccountType:         installation.AccountType,
		AppSlug:             installation.AppSlug,
		RepositorySelection: installation.RepositorySelection,
		Status:              installation.Status,
		CreatedAt:           installation.CreatedAt,
		UpdatedAt:           installation.UpdatedAt,
	}
}

func toSCMRepositories(repositories []domain.SCMRepository) []scmRepository {
	result := make([]scmRepository, 0, len(repositories))
	for _, repository := range repositories {
		result = append(result, scmRepository{
			ID:       repository.ID,
			FullName: repository.FullName,
			Private:  repository.Private,
			Allowed:  repository.Allowed,
		})
	}
	return result
}

// scmTenantFromRequest validates the authenticated principal's current
// membership in the organization named by the canonical admin route. Unlike
// the hosted /api/v1 application surface, X-AO-Org never selects an admin
// tenant: the path is authoritative.
func (s *Server) scmTenantFromRequest(w http.ResponseWriter, r *http.Request) (tenant.Identity, bool) {
	principal, ok := principalFromContext(r.Context())
	if !ok {
		writeError(w, r, http.StatusUnauthorized, "unauthorized", "AUTH_REQUIRED", "valid AO access token required")
		return tenant.Identity{}, false
	}
	orgID := strings.TrimSpace(chi.URLParam(r, "orgId"))
	if orgID == "" {
		writeError(w, r, http.StatusBadRequest, "bad_request", "ORG_ID_REQUIRED", "orgId is required")
		return tenant.Identity{}, false
	}
	memberships, err := s.store.ListMemberships(r.Context(), principal)
	if err != nil {
		s.internalError(w, r, "list memberships for scm admin", err)
		return tenant.Identity{}, false
	}
	for _, membership := range memberships {
		if membership.OrgID == orgID {
			if membership.Role != "owner" && membership.Role != "admin" {
				writeError(w, r, http.StatusForbidden, "forbidden", "ORG_ADMIN_REQUIRED", "organization administrator access is required")
				return tenant.Identity{}, false
			}
			identity := tenant.Identity{OrgID: membership.OrgID, OrgSlug: membership.OrgSlug, UserID: principal.UserID, Role: membership.Role}
			if identity.Valid() {
				return identity, true
			}
			break
		}
	}
	writeError(w, r, http.StatusForbidden, "forbidden", "ORG_FORBIDDEN", "this account is not a member of the requested organization")
	return tenant.Identity{}, false
}

func (s *Server) startSCMInstall(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	identity, ok := s.scmTenantFromRequest(w, r)
	if !ok {
		return
	}
	redirect, _, err := s.scm.Link.StartInstall(r.Context(), identity)
	if err != nil {
		s.writeSCMError(w, r, "start scm install", err)
		return
	}
	writeJSON(w, http.StatusCreated, scmInstallStartResponse{
		InstallURL: redirect.InstallURL,
		ExpiresAt:  redirect.ExpiresAt,
	})
}

// completeSCMInstall is the app's setup URL. It is unauthenticated by design:
// GitHub redirects a browser here and no AO bearer token survives that hop.
// The single-use state token issued by startSCMInstall is the credential.
func (s *Server) completeSCMInstall(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	query := r.URL.Query()
	externalID, _ := strconv.ParseInt(strings.TrimSpace(query.Get("installation_id")), 10, 64)
	installation, err := s.scm.Link.CompleteInstall(r.Context(), scm.CallbackParams{
		State:                  query.Get("state"),
		ExternalInstallationID: externalID,
		SetupAction:            query.Get("setup_action"),
		Code:                   query.Get("code"),
	})
	if err != nil {
		if completion := strings.TrimSpace(s.scm.InstallCompletionURL); completion != "" {
			s.logger.Warn(
				"Cloud SCM install callback failed",
				"request_id", requestID(r),
				"error", scmErrorCode(err),
			)
			http.Redirect(w, r, completionURL(completion, "error", scmErrorCode(err)), http.StatusFound)
			return
		}
		s.writeSCMError(w, r, "complete scm install", err)
		return
	}
	if completion := strings.TrimSpace(s.scm.InstallCompletionURL); completion != "" {
		http.Redirect(w, r, completionURL(completion, "installation", installation.ID), http.StatusFound)
		return
	}
	writeJSON(w, http.StatusOK, toSCMInstallation(installation))
}

// completionURL appends one status parameter without discarding whatever the
// deployment already put in the configured URL.
func completionURL(base, key, value string) string {
	parsed, err := url.Parse(base)
	if err != nil {
		return base
	}
	query := parsed.Query()
	query.Set(key, value)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func (s *Server) listSCMInstallations(w http.ResponseWriter, r *http.Request) {
	identity, ok := s.scmTenantFromRequest(w, r)
	if !ok {
		return
	}
	installations, err := s.scm.Link.ListInstallations(r.Context(), identity)
	if err != nil {
		s.writeSCMError(w, r, "list scm installations", err)
		return
	}
	response := scmInstallationListResponse{Installations: make([]scmInstallation, 0, len(installations))}
	for _, installation := range installations {
		response.Installations = append(response.Installations, toSCMInstallation(installation))
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) listSCMRepositories(w http.ResponseWriter, r *http.Request) {
	identity, ok := s.scmTenantFromRequest(w, r)
	if !ok {
		return
	}
	repositories, err := s.scm.Link.ListRepositories(r.Context(), identity, chi.URLParam(r, "installationID"))
	if err != nil {
		s.writeSCMError(w, r, "list scm repositories", err)
		return
	}
	writeJSON(w, http.StatusOK, scmRepositoryListResponse{Repositories: toSCMRepositories(repositories)})
}

func (s *Server) syncSCMRepositories(w http.ResponseWriter, r *http.Request) {
	identity, ok := s.scmTenantFromRequest(w, r)
	if !ok {
		return
	}
	repositories, err := s.scm.Link.SyncInstallation(r.Context(), identity, chi.URLParam(r, "installationID"))
	if err != nil {
		s.writeSCMError(w, r, "sync scm repositories", err)
		return
	}
	writeJSON(w, http.StatusOK, scmRepositoryListResponse{Repositories: toSCMRepositories(repositories)})
}

func (s *Server) setSCMAllowlist(w http.ResponseWriter, r *http.Request) {
	var input scmAllowlistRequest
	if !decodeJSON(w, r, &input) {
		return
	}
	identity, ok := s.scmTenantFromRequest(w, r)
	if !ok {
		return
	}
	repositories, err := s.scm.Link.SetAllowlist(
		r.Context(), identity, chi.URLParam(r, "installationID"), input.Repositories,
	)
	if err != nil {
		s.writeSCMError(w, r, "set scm allowlist", err)
		return
	}
	writeJSON(w, http.StatusOK, scmRepositoryListResponse{Repositories: toSCMRepositories(repositories)})
}

func (s *Server) unlinkSCMInstallation(w http.ResponseWriter, r *http.Request) {
	identity, ok := s.scmTenantFromRequest(w, r)
	if !ok {
		return
	}
	if err := s.scm.Link.Unlink(r.Context(), identity, chi.URLParam(r, "installationID")); err != nil {
		s.writeSCMError(w, r, "unlink scm installation", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// receiveSCMWebhook verifies, deduplicates, and applies one delivery. Every
// valid-HMAC delivery answers 202 so GitHub stops retrying; an unverifiable
// body answers 401 with no detail about why.
func (s *Server) receiveSCMWebhook(w http.ResponseWriter, r *http.Request) {
	if s.scm.Webhook == nil {
		writeError(w, r, http.StatusNotFound, "not_found", "SCM_WEBHOOK_DISABLED", "scm webhooks are not configured")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxWebhookBodyBytes))
	if err != nil {
		writeError(w, r, http.StatusRequestEntityTooLarge, "bad_request", "WEBHOOK_TOO_LARGE", "webhook body is too large")
		return
	}
	result, err := s.scm.Webhook.Process(
		r.Context(),
		r.Header.Get(scm.EventHeader),
		r.Header.Get(scm.DeliveryHeader),
		r.Header.Get(scm.SignatureHeader),
		body,
	)
	if err != nil {
		if errors.Is(err, scm.ErrInvalidSignature) {
			// Do not log the body or the offered signature: both are
			// attacker-controlled and the body may contain repository content.
			s.logger.Warn("Cloud SCM webhook signature rejected", "request_id", requestID(r))
			writeError(w, r, http.StatusUnauthorized, "unauthorized", "WEBHOOK_SIGNATURE_INVALID", "webhook signature is invalid")
			return
		}
		if errors.Is(err, scm.ErrWebhookReceiptUnavailable) {
			// No durable owner exists yet. Do not acknowledge the delivery or
			// GitHub will discard its only retryable copy.
			s.logger.Error("Cloud SCM webhook receipt failed", "request_id", requestID(r), "error", err)
			writeError(w, r, http.StatusServiceUnavailable, "unavailable", "WEBHOOK_RECEIPT_UNAVAILABLE", "webhook receipt is temporarily unavailable")
			return
		}
		// GitHub delivery responses deliberately do not reveal or retry internal
		// processing failures. The delivery id was claimed after HMAC validation,
		// so a valid request always receives the same accepted response.
		s.logger.Error("Cloud SCM webhook processing failed", "request_id", requestID(r), "error", err)
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "accepted"})
		return
	}
	if result.Duplicate {
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "duplicate"})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "accepted"})
}

// scmErrorCode maps a boundary error to a stable, non-revealing code.
func scmErrorCode(err error) string {
	switch {
	case errors.Is(err, scm.ErrNotConfigured):
		return "SCM_NOT_CONFIGURED"
	case errors.Is(err, scm.ErrInvalidState):
		return "SCM_INSTALL_STATE_INVALID"
	case errors.Is(err, scm.ErrInstallationNotOwned):
		return "SCM_INSTALLATION_NOT_ACCESSIBLE"
	case errors.Is(err, scm.ErrInstallationClaimed):
		return "SCM_INSTALLATION_ALREADY_LINKED"
	case errors.Is(err, scm.ErrInstallationNotFound), errors.Is(err, postgres.ErrNotFound):
		return "SCM_INSTALLATION_NOT_FOUND"
	case errors.Is(err, scm.ErrInstallationInactive):
		return "SCM_INSTALLATION_INACTIVE"
	case errors.Is(err, scm.ErrRepositoryNotAllowed):
		return "SCM_REPOSITORY_NOT_ALLOWED"
	case errors.Is(err, scm.ErrInvalidRepository):
		return "SCM_REPOSITORY_INVALID"
	case errors.Is(err, tenant.ErrNoTenant), errors.Is(err, postgres.ErrInvalid):
		return "SCM_REQUEST_INVALID"
	case errors.Is(err, scm.ErrProviderRejected):
		return "SCM_PROVIDER_REJECTED"
	default:
		return "INTERNAL_ERROR"
	}
}

// writeSCMError maps a boundary error to a status and a fixed message. The
// underlying error text never reaches the client: provider responses and
// database constraint names both leak more than a caller should learn.
func (s *Server) writeSCMError(w http.ResponseWriter, r *http.Request, operation string, err error) {
	code := scmErrorCode(err)
	status, message := http.StatusInternalServerError, "internal server error"
	kind := "internal_error"
	switch code {
	case "SCM_NOT_CONFIGURED":
		status, kind, message = http.StatusServiceUnavailable, "unavailable", "cloud scm is not configured"
	case "SCM_INSTALL_STATE_INVALID":
		status, kind, message = http.StatusBadRequest, "bad_request", "install link is invalid or expired"
	case "SCM_INSTALLATION_NOT_ACCESSIBLE":
		status, kind, message = http.StatusForbidden, "forbidden", "installation is not accessible to this account"
	case "SCM_INSTALLATION_ALREADY_LINKED":
		status, kind, message = http.StatusConflict, "conflict", "installation is already linked to another organization"
	case "SCM_INSTALLATION_NOT_FOUND":
		status, kind, message = http.StatusNotFound, "not_found", "installation not found"
	case "SCM_INSTALLATION_INACTIVE":
		status, kind, message = http.StatusConflict, "conflict", "installation is suspended or removed"
	case "SCM_REPOSITORY_NOT_ALLOWED":
		status, kind, message = http.StatusForbidden, "forbidden", "repository is not allowlisted for this installation"
	case "SCM_REPOSITORY_INVALID":
		status, kind, message = http.StatusBadRequest, "bad_request", "repository must be owner/name"
	case "SCM_REQUEST_INVALID":
		status, kind, message = http.StatusBadRequest, "bad_request", "request is invalid"
	case "SCM_PROVIDER_REJECTED":
		status, kind, message = http.StatusBadGateway, "bad_gateway", "github rejected the request"
	default:
		s.logger.Error("Cloud SCM request failed", "request_id", requestID(r), "operation", operation, "error", err)
	}
	writeError(w, r, status, kind, code, message)
}
