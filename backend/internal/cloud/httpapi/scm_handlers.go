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
	"unicode"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/scm"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// SCMLinkService starts and completes GitHub App installation linking.
type SCMLinkService interface {
	StartInstall(context.Context, tenant.Identity) (scm.InstallRedirect, error)
	CompleteInstall(context.Context, scm.CallbackParams) (domain.SCMInstallation, error)
	ListInstallations(context.Context, tenant.Identity) ([]domain.SCMInstallation, error)
	ListRepositories(context.Context, tenant.Identity, string) ([]domain.SCMRepository, error)
	SyncInstallation(context.Context, tenant.Identity, string) ([]domain.SCMRepository, error)
	SetAllowlist(context.Context, tenant.Identity, string, []string) ([]domain.SCMRepository, error)
	Unlink(context.Context, tenant.Identity, string) error
}

// SCMWebhookProcessor durably accepts verified GitHub webhook deliveries.
type SCMWebhookProcessor interface {
	Process(context.Context, string, string, string, []byte) (scm.WebhookResult, error)
}

// SCMOptions configures the optional SCM HTTP surface.
type SCMOptions struct {
	Link                 SCMLinkService
	Webhook              SCMWebhookProcessor
	InstallCompletionURL string
}

const (
	maxWebhookHeaderFields        = 64
	maxWebhookHeaderValues        = 128
	maxWebhookHeaderValuesPerName = 8
	maxWebhookHeaderNameBytes     = 128
	maxWebhookHeaderValueBytes    = 4096
	maxWebhookHeaderBytes         = 32 << 10
)

type scmInstallStartResponse struct {
	InstallURL string    `json:"installUrl"`
	ExpiresAt  time.Time `json:"expiresAt"`
}

type scmInstallationResponse struct {
	ID                  string    `json:"id"`
	Provider            string    `json:"provider"`
	AccountLogin        string    `json:"accountLogin"`
	AccountType         string    `json:"accountType"`
	RepositorySelection string    `json:"repositorySelection"`
	Status              string    `json:"status"`
	CreatedAt           time.Time `json:"createdAt"`
	UpdatedAt           time.Time `json:"updatedAt"`
}

type scmInstallationListResponse struct {
	Installations []scmInstallationResponse `json:"installations"`
}

type scmRepositoryResponse struct {
	ID       string `json:"id"`
	FullName string `json:"fullName"`
	Private  bool   `json:"private"`
	Allowed  bool   `json:"allowed"`
}

type scmRepositoryListResponse struct {
	Repositories []scmRepositoryResponse `json:"repositories"`
}

type scmAllowlistRequest struct {
	Repositories []string `json:"repositories"`
}

func (s *Server) registerSCMRoutes(router chi.Router, rateLimit func(http.Handler) http.Handler) {
	if s.scm.Link != nil {
		admin := router.With(s.requirePrincipal)
		admin.Get("/api/cloud/v1/orgs/{orgId}/github/installations", s.listSCMInstallations)
		admin.Post("/api/cloud/v1/orgs/{orgId}/github/installations/start", s.startSCMInstall)
		admin.Delete("/api/cloud/v1/orgs/{orgId}/github/installations/{installationId}/disconnect", s.disconnectSCMInstallation)
		admin.Get("/api/cloud/v1/orgs/{orgId}/github/installations/{installationId}/repositories", s.listSCMRepositories)
		admin.Post("/api/cloud/v1/orgs/{orgId}/github/installations/{installationId}/sync", s.syncSCMRepositories)
		admin.Put("/api/cloud/v1/orgs/{orgId}/github/installations/{installationId}/allowlist", s.setSCMAllowlist)
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
		SetupAction: r.URL.Query().Get("setup_action"), Code: r.URL.Query().Get("code"),
	})
	if err != nil {
		if strings.TrimSpace(s.scm.InstallCompletionURL) != "" {
			http.Redirect(w, r, scmCompletionURL(s.scm.InstallCompletionURL, "error", scmErrorCode(err)), http.StatusFound)
			return
		}
		s.writeSCMError(w, r, "complete scm install", err)
		return
	}
	if strings.TrimSpace(s.scm.InstallCompletionURL) != "" {
		http.Redirect(w, r, scmCompletionURL(s.scm.InstallCompletionURL, "installation", installation.ID), http.StatusFound)
		return
	}
	writeJSON(w, http.StatusOK, toSCMInstallation(installation))
}

func (s *Server) listSCMInstallations(w http.ResponseWriter, r *http.Request) {
	identity, ok := s.scmAdminIdentity(w, r)
	if !ok {
		return
	}
	installations, err := s.scm.Link.ListInstallations(r.Context(), identity)
	if err != nil {
		s.writeSCMError(w, r, "list scm installations", err)
		return
	}
	response := scmInstallationListResponse{Installations: make([]scmInstallationResponse, 0, len(installations))}
	for _, installation := range installations {
		response.Installations = append(response.Installations, toSCMInstallation(installation))
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) listSCMRepositories(w http.ResponseWriter, r *http.Request) {
	identity, ok := s.scmAdminIdentity(w, r)
	if !ok {
		return
	}
	repositories, err := s.scm.Link.ListRepositories(r.Context(), identity, chi.URLParam(r, "installationId"))
	if err != nil {
		s.writeSCMError(w, r, "list scm repositories", err)
		return
	}
	writeJSON(w, http.StatusOK, toSCMRepositories(repositories))
}

func (s *Server) syncSCMRepositories(w http.ResponseWriter, r *http.Request) {
	identity, ok := s.scmAdminIdentity(w, r)
	if !ok {
		return
	}
	repositories, err := s.scm.Link.SyncInstallation(r.Context(), identity, chi.URLParam(r, "installationId"))
	if err != nil {
		s.writeSCMError(w, r, "sync scm repositories", err)
		return
	}
	writeJSON(w, http.StatusOK, toSCMRepositories(repositories))
}

func (s *Server) setSCMAllowlist(w http.ResponseWriter, r *http.Request) {
	var request scmAllowlistRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	if request.Repositories == nil || len(request.Repositories) > 5000 {
		writeError(w, r, http.StatusBadRequest, "bad_request", "SCM_REQUEST_INVALID", "request is invalid")
		return
	}
	identity, ok := s.scmAdminIdentity(w, r)
	if !ok {
		return
	}
	repositories, err := s.scm.Link.SetAllowlist(r.Context(), identity, chi.URLParam(r, "installationId"), request.Repositories)
	if err != nil {
		s.writeSCMError(w, r, "set scm allowlist", err)
		return
	}
	writeJSON(w, http.StatusOK, toSCMRepositories(repositories))
}

func (s *Server) disconnectSCMInstallation(w http.ResponseWriter, r *http.Request) {
	identity, ok := s.scmAdminIdentity(w, r)
	if !ok {
		return
	}
	if err := s.scm.Link.Unlink(r.Context(), identity, chi.URLParam(r, "installationId")); err != nil {
		s.writeSCMError(w, r, "disconnect scm installation", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func toSCMInstallation(installation domain.SCMInstallation) scmInstallationResponse {
	return scmInstallationResponse{
		ID: installation.ID, Provider: installation.Provider,
		AccountLogin: installation.AccountLogin, AccountType: installation.AccountType,
		RepositorySelection: installation.RepositorySelection, Status: installation.Status,
		CreatedAt: installation.CreatedAt, UpdatedAt: installation.UpdatedAt,
	}
}

func toSCMRepositories(repositories []domain.SCMRepository) scmRepositoryListResponse {
	response := scmRepositoryListResponse{Repositories: make([]scmRepositoryResponse, 0, len(repositories))}
	for _, repository := range repositories {
		response.Repositories = append(response.Repositories, scmRepositoryResponse{
			ID: repository.ID, FullName: repository.FullName,
			Private: repository.Private, Allowed: repository.Allowed,
		})
	}
	return response
}

func scmCompletionURL(base, key, value string) string {
	parsed, err := url.Parse(base)
	if err != nil {
		return base
	}
	query := parsed.Query()
	query.Set(key, value)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

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
	case errors.Is(err, scm.ErrInstallationNotFound), errors.Is(err, domain.ErrSCMNotFound):
		return "SCM_INSTALLATION_NOT_FOUND"
	case errors.Is(err, scm.ErrInstallationInactive):
		return "SCM_INSTALLATION_INACTIVE"
	case errors.Is(err, scm.ErrRepositoryNotAllowed):
		return "SCM_REPOSITORY_NOT_ALLOWED"
	case errors.Is(err, scm.ErrInvalidRepository):
		return "SCM_REPOSITORY_INVALID"
	case errors.Is(err, tenant.ErrNoTenant):
		return "SCM_REQUEST_INVALID"
	case errors.Is(err, scm.ErrProviderRejected):
		return "SCM_PROVIDER_REJECTED"
	default:
		return "INTERNAL_ERROR"
	}
}

func (s *Server) writeSCMError(w http.ResponseWriter, r *http.Request, operation string, err error) {
	code := scmErrorCode(err)
	status, kind, message := http.StatusInternalServerError, "internal_error", "internal server error"
	switch code {
	case "SCM_NOT_CONFIGURED":
		status, kind, message = http.StatusServiceUnavailable, "unavailable", "cloud scm is not configured"
	case "SCM_INSTALL_STATE_INVALID", "SCM_REPOSITORY_INVALID", "SCM_REQUEST_INVALID":
		status, kind, message = http.StatusBadRequest, "bad_request", "request is invalid"
	case "SCM_INSTALLATION_NOT_ACCESSIBLE", "SCM_REPOSITORY_NOT_ALLOWED":
		status, kind, message = http.StatusForbidden, "forbidden", "scm resource is not accessible"
	case "SCM_INSTALLATION_ALREADY_LINKED":
		status, kind, message = http.StatusConflict, "conflict", "installation is already linked"
	case "SCM_INSTALLATION_NOT_FOUND":
		status, kind, message = http.StatusNotFound, "not_found", "installation not found"
	case "SCM_INSTALLATION_INACTIVE":
		status, kind, message = http.StatusConflict, "conflict", "installation is inactive"
	case "SCM_PROVIDER_REJECTED":
		status, kind, message = http.StatusBadGateway, "bad_gateway", "github rejected the request"
	default:
		s.logger.Error("Cloud SCM request failed", "request_id", requestID(r), "operation", operation, "error", err)
	}
	writeError(w, r, status, kind, code, message)
}

func (s *Server) receiveSCMWebhook(w http.ResponseWriter, r *http.Request) {
	if !validWebhookHeaderEnvelope(r.Header) {
		writeError(w, r, http.StatusBadRequest, "bad_request", "WEBHOOK_HEADERS_INVALID", "webhook headers are invalid")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, scm.MaxWebhookBodyBytes))
	if err != nil {
		writeError(w, r, http.StatusRequestEntityTooLarge, "bad_request", "WEBHOOK_TOO_LARGE", "webhook body is too large")
		return
	}
	if !singleWebhookHeaders(r.Header, scm.EventHeader, scm.DeliveryHeader, scm.SignatureHeader) {
		writeError(w, r, http.StatusBadRequest, "bad_request", "WEBHOOK_HEADERS_INVALID", "webhook headers are invalid")
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

func validWebhookHeaderEnvelope(header http.Header) bool {
	if len(header) > maxWebhookHeaderFields {
		return false
	}
	valueCount, byteCount := 0, 0
	for name, values := range header {
		if name == "" || len(name) > maxWebhookHeaderNameBytes || http.CanonicalHeaderKey(name) != name || !validHTTPToken(name) || len(values) > maxWebhookHeaderValuesPerName {
			return false
		}
		byteCount += len(name)
		for _, value := range values {
			valueCount++
			byteCount += len(value)
			if len(value) > maxWebhookHeaderValueBytes || containsControl(value) {
				return false
			}
		}
	}
	return valueCount <= maxWebhookHeaderValues && byteCount <= maxWebhookHeaderBytes
}

func singleWebhookHeaders(header http.Header, names ...string) bool {
	for _, name := range names {
		if len(header.Values(name)) != 1 {
			return false
		}
	}
	return true
}

func validHTTPToken(value string) bool {
	for index := range len(value) {
		character := value[index]
		if character <= 0x20 || character >= 0x7f || strings.ContainsRune("()<>@,;:\\\"/[]?={}", rune(character)) {
			return false
		}
	}
	return true
}

func containsControl(value string) bool {
	return !utf8.ValidString(value) || strings.IndexFunc(value, unicode.IsControl) >= 0
}
