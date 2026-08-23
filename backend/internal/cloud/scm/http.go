package scm

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

const (
	// maxWebhookBodyBytes bounds a webhook body. GitHub's own limit is 25 MB,
	// but the events this control plane acts on are far smaller and the body
	// is held in memory for signature verification.
	maxWebhookBodyBytes = 2 << 20
	maxRequestBodyBytes = 1 << 20

	// WebhookPath is the public, GitHub-facing delivery endpoint. It is
	// unauthenticated at the bearer layer only: every delivery must still pass
	// constant-time HMAC verification and delivery-id idempotency before the
	// body is parsed.
	WebhookPath = "/api/cloud/v1/scm/github/webhook"
	// SetupPath is the GitHub App's Setup URL. GitHub redirects a browser
	// here, so it carries no bearer token; the single-use install state is the
	// credential.
	SetupPath = "/api/cloud/v1/scm/github/setup"

	installationsPath = "/api/cloud/v1/scm/github/installations"
)

// LinkAPI is the install and allowlist surface the routes expose. *LinkService
// satisfies it; the interface exists so the HTTP layer can be tested without a
// GitHub client.
type LinkAPI interface {
	StartInstall(ctx context.Context, tenant postgres.SCMTenant) (InstallRedirect, string, error)
	CompleteInstall(ctx context.Context, params CallbackParams) (domain.SCMInstallation, error)
	ListInstallations(ctx context.Context, tenant postgres.SCMTenant) ([]domain.SCMInstallation, error)
	ListRepositories(ctx context.Context, tenant postgres.SCMTenant, installationID string) ([]domain.SCMRepository, error)
	SyncInstallation(ctx context.Context, tenant postgres.SCMTenant, installationID string) ([]domain.SCMRepository, error)
	SetAllowlist(ctx context.Context, tenant postgres.SCMTenant, installationID string, repositoryFullNames []string) ([]domain.SCMRepository, error)
	Unlink(ctx context.Context, tenant postgres.SCMTenant, installationID string) error
}

// WebhookAPI verifies and applies one provider webhook delivery.
type WebhookAPI interface {
	Process(ctx context.Context, event, deliveryID, signature string, body []byte) (WebhookResult, error)
}

// Routes is the SCM HTTP surface, mounted by the control plane's composition
// rather than owned by it. Everything here is inert until MountRoutes runs.
type Routes struct {
	link                 LinkAPI
	webhook              WebhookAPI
	installCompletionURL string
	logger               *slog.Logger
}

// RoutesOptions configures the SCM HTTP surface.
type RoutesOptions struct {
	Link LinkAPI
	// Webhook may be nil when no webhook secret is configured. The delivery
	// endpoint is then not mounted at all, rather than accepting unverified
	// deliveries.
	Webhook WebhookAPI
	// InstallCompletionURL is where the browser is redirected after the setup
	// callback. Empty answers with JSON.
	InstallCompletionURL string
	Logger               *slog.Logger
}

// NewRoutes builds the SCM HTTP surface.
func NewRoutes(options RoutesOptions) (*Routes, error) {
	if options.Link == nil {
		return nil, ErrNotConfigured
	}
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Routes{
		link:                 options.Link,
		webhook:              options.Webhook,
		installCompletionURL: strings.TrimSpace(options.InstallCompletionURL),
		logger:               logger,
	}, nil
}

// MountDeps are the control plane's middlewares. The SCM slice does not
// implement authentication or tenant resolution: the composition owns one
// authenticated middleware chain, and this surface must sit behind the same
// one as everything else rather than growing a second, divergent copy.
type MountDeps struct {
	// RequireTenant must authenticate the bearer token, resolve the acting
	// organization, and put a tenant.Identity on the request context. Required.
	RequireTenant func(http.Handler) http.Handler
	// RateLimit is applied to the two unauthenticated GitHub-facing routes.
	// Optional; nil means the edge is doing it.
	RateLimit func(http.Handler) http.Handler
}

// MountRoutes registers the SCM endpoints on the control plane's router.
//
// The split is deliberate. The installation and allowlist routes are ordinary
// tenant-scoped API calls and go behind the caller's authenticated chain. The
// setup callback and the webhook cannot: GitHub drives both, and neither
// carries an AO bearer token. Those two authenticate on their own terms — a
// single-use state token and an HMAC over the raw body.
func (r *Routes) MountRoutes(router chi.Router, deps MountDeps) error {
	if deps.RequireTenant == nil {
		return errors.New("cloud scm: mounting requires a tenant-resolving middleware")
	}
	rateLimit := deps.RateLimit
	if rateLimit == nil {
		rateLimit = func(next http.Handler) http.Handler { return next }
	}
	authed := router.With(deps.RequireTenant)
	authed.Post(installationsPath, r.startInstall)
	authed.Get(installationsPath, r.listInstallations)
	authed.Get(installationsPath+"/{installationID}/repositories", r.listRepositories)
	authed.Post(installationsPath+"/{installationID}/repositories/sync", r.syncRepositories)
	authed.Put(installationsPath+"/{installationID}/allowlist", r.setAllowlist)
	authed.Delete(installationsPath+"/{installationID}", r.unlink)

	router.With(rateLimit).Get(SetupPath, r.completeInstall)
	if r.webhook != nil {
		router.With(rateLimit).Post(WebhookPath, r.receiveWebhook)
	}
	return nil
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

// The external installation id is deliberately absent from every response. It
// is a capability-shaped identifier: knowing it is one of the inputs to a
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

// tenantFrom reads the organization scope the mounting middleware resolved.
// There is no orgId request field: the acting organization is established once
// by the composition, so a client cannot name a different one per call.
func (r *Routes) tenantFrom(w http.ResponseWriter, request *http.Request) (postgres.SCMTenant, bool) {
	identity, ok := tenant.FromContext(request.Context())
	if !ok || !identity.Valid() {
		writeError(w, request, http.StatusUnauthorized, "unauthorized", "AUTH_REQUIRED", "valid AO access token required")
		return postgres.SCMTenant{}, false
	}
	return postgres.SCMTenant{OrgID: identity.OrgID, UserID: identity.UserID}, true
}

func (r *Routes) startInstall(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	scope, ok := r.tenantFrom(w, request)
	if !ok {
		return
	}
	redirect, _, err := r.link.StartInstall(request.Context(), scope)
	if err != nil {
		r.writeSCMError(w, request, "start scm install", err)
		return
	}
	writeJSON(w, http.StatusCreated, scmInstallStartResponse{
		InstallURL: redirect.InstallURL,
		ExpiresAt:  redirect.ExpiresAt,
	})
}

// completeInstall is the app's setup URL. It is unauthenticated by design:
// GitHub redirects a browser here and no AO bearer token survives that hop.
// The single-use state token issued by startInstall is the credential.
func (r *Routes) completeInstall(w http.ResponseWriter, request *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	query := request.URL.Query()
	externalID, _ := strconv.ParseInt(strings.TrimSpace(query.Get("installation_id")), 10, 64)
	installation, err := r.link.CompleteInstall(request.Context(), CallbackParams{
		State:                  query.Get("state"),
		ExternalInstallationID: externalID,
		SetupAction:            query.Get("setup_action"),
		Code:                   query.Get("code"),
	})
	if err != nil {
		if r.installCompletionURL != "" {
			r.logger.Warn(
				"Cloud SCM install callback failed",
				"request_id", requestID(request),
				"error", ErrorCode(err),
			)
			http.Redirect(w, request, completionURL(r.installCompletionURL, "error", ErrorCode(err)), http.StatusFound)
			return
		}
		r.writeSCMError(w, request, "complete scm install", err)
		return
	}
	if r.installCompletionURL != "" {
		http.Redirect(w, request, completionURL(r.installCompletionURL, "installation", installation.ID), http.StatusFound)
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

func (r *Routes) listInstallations(w http.ResponseWriter, request *http.Request) {
	scope, ok := r.tenantFrom(w, request)
	if !ok {
		return
	}
	installations, err := r.link.ListInstallations(request.Context(), scope)
	if err != nil {
		r.writeSCMError(w, request, "list scm installations", err)
		return
	}
	response := scmInstallationListResponse{Installations: make([]scmInstallation, 0, len(installations))}
	for _, installation := range installations {
		response.Installations = append(response.Installations, toSCMInstallation(installation))
	}
	writeJSON(w, http.StatusOK, response)
}

func (r *Routes) listRepositories(w http.ResponseWriter, request *http.Request) {
	scope, ok := r.tenantFrom(w, request)
	if !ok {
		return
	}
	repositories, err := r.link.ListRepositories(request.Context(), scope, chi.URLParam(request, "installationID"))
	if err != nil {
		r.writeSCMError(w, request, "list scm repositories", err)
		return
	}
	writeJSON(w, http.StatusOK, scmRepositoryListResponse{Repositories: toSCMRepositories(repositories)})
}

func (r *Routes) syncRepositories(w http.ResponseWriter, request *http.Request) {
	scope, ok := r.tenantFrom(w, request)
	if !ok {
		return
	}
	repositories, err := r.link.SyncInstallation(request.Context(), scope, chi.URLParam(request, "installationID"))
	if err != nil {
		r.writeSCMError(w, request, "sync scm repositories", err)
		return
	}
	writeJSON(w, http.StatusOK, scmRepositoryListResponse{Repositories: toSCMRepositories(repositories)})
}

func (r *Routes) setAllowlist(w http.ResponseWriter, request *http.Request) {
	var input scmAllowlistRequest
	if !decodeJSON(w, request, &input) {
		return
	}
	scope, ok := r.tenantFrom(w, request)
	if !ok {
		return
	}
	repositories, err := r.link.SetAllowlist(
		request.Context(), scope, chi.URLParam(request, "installationID"), input.Repositories,
	)
	if err != nil {
		r.writeSCMError(w, request, "set scm allowlist", err)
		return
	}
	writeJSON(w, http.StatusOK, scmRepositoryListResponse{Repositories: toSCMRepositories(repositories)})
}

func (r *Routes) unlink(w http.ResponseWriter, request *http.Request) {
	scope, ok := r.tenantFrom(w, request)
	if !ok {
		return
	}
	if err := r.link.Unlink(request.Context(), scope, chi.URLParam(request, "installationID")); err != nil {
		r.writeSCMError(w, request, "unlink scm installation", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// receiveWebhook verifies, deduplicates, and applies one delivery. A duplicate
// answers 200 so GitHub stops retrying; an unverifiable body answers 401 with
// no detail about why.
func (r *Routes) receiveWebhook(w http.ResponseWriter, request *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, request.Body, maxWebhookBodyBytes))
	if err != nil {
		writeError(w, request, http.StatusRequestEntityTooLarge, "bad_request", "WEBHOOK_TOO_LARGE", "webhook body is too large")
		return
	}
	result, err := r.webhook.Process(
		request.Context(),
		request.Header.Get(EventHeader),
		request.Header.Get(DeliveryHeader),
		request.Header.Get(SignatureHeader),
		body,
	)
	if err != nil {
		if errors.Is(err, ErrInvalidSignature) {
			// Do not log the body or the offered signature: both are
			// attacker-controlled and the body may contain repository content.
			r.logger.Warn("Cloud SCM webhook signature rejected", "request_id", requestID(request))
			writeError(w, request, http.StatusUnauthorized, "unauthorized", "WEBHOOK_SIGNATURE_INVALID", "webhook signature is invalid")
			return
		}
		r.writeSCMError(w, request, "process scm webhook", err)
		return
	}
	if result.Duplicate {
		writeJSON(w, http.StatusOK, map[string]string{"status": "duplicate"})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "accepted"})
}

// ErrorCode maps a boundary error to a stable, non-revealing code. It is
// exported so the control plane's own error mapping can reuse it.
func ErrorCode(err error) string {
	switch {
	case errors.Is(err, ErrNotConfigured):
		return "SCM_NOT_CONFIGURED"
	case errors.Is(err, ErrInvalidState):
		return "SCM_INSTALL_STATE_INVALID"
	case errors.Is(err, ErrInstallationNotOwned):
		return "SCM_INSTALLATION_NOT_ACCESSIBLE"
	case errors.Is(err, ErrInstallationClaimed):
		return "SCM_INSTALLATION_ALREADY_LINKED"
	case errors.Is(err, ErrInstallationNotFound), errors.Is(err, postgres.ErrNotFound):
		return "SCM_INSTALLATION_NOT_FOUND"
	case errors.Is(err, ErrInstallationInactive):
		return "SCM_INSTALLATION_INACTIVE"
	case errors.Is(err, ErrRepositoryNotAllowed):
		return "SCM_REPOSITORY_NOT_ALLOWED"
	case errors.Is(err, ErrInvalidRepository):
		return "SCM_REPOSITORY_INVALID"
	case errors.Is(err, tenant.ErrNoTenant), errors.Is(err, postgres.ErrInvalid):
		return "SCM_REQUEST_INVALID"
	case errors.Is(err, ErrProviderRejected):
		return "SCM_PROVIDER_REJECTED"
	default:
		return "INTERNAL_ERROR"
	}
}

// writeSCMError maps a boundary error to a status and a fixed message. The
// underlying error text never reaches the client: provider responses and
// database constraint names both leak more than a caller should learn.
func (r *Routes) writeSCMError(w http.ResponseWriter, request *http.Request, operation string, err error) {
	code := ErrorCode(err)
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
		r.logger.Error("Cloud SCM request failed", "request_id", requestID(request), "operation", operation, "error", err)
	}
	writeError(w, request, status, kind, code, message)
}

// errorEnvelope mirrors the control plane's envelope. It is duplicated rather
// than imported because the SCM slice must not depend on the httpapi package
// that mounts it; the shape is part of the API contract, so it is asserted in
// this package's tests.
type errorEnvelope struct {
	Error     string `json:"error"`
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"requestId"`
}

func writeError(w http.ResponseWriter, r *http.Request, status int, kind, code, message string) {
	writeJSON(w, status, errorEnvelope{
		Error:     kind,
		Code:      code,
		Message:   message,
		RequestID: requestID(r),
	})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	payload, err := json.Marshal(value)
	if err != nil {
		http.Error(w, http.StatusText(http.StatusInternalServerError), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(append(payload, '\n'))
}

func requestID(r *http.Request) string {
	if id := middleware.GetReqID(r.Context()); id != "" {
		return id
	}
	return "unknown"
}

func decodeJSON(w http.ResponseWriter, r *http.Request, destination any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		writeError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "request body must be valid JSON")
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "request body must contain one JSON value")
		return false
	}
	return true
}
