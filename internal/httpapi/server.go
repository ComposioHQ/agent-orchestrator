package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/auth"
	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/githubapp"
	"github.com/Untrivial-ai/ao-cloud/internal/postgres"
	"github.com/Untrivial-ai/ao-cloud/internal/sandbox"
	"github.com/Untrivial-ai/ao-cloud/internal/secrets"
	"github.com/Untrivial-ai/ao-cloud/internal/worker"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// DefaultMaxSandboxesPerOrg caps how much provider capacity one organization
// can hold at once.
const DefaultMaxSandboxesPerOrg = 10

type Store interface {
	Ping(context.Context) error
	UpsertWorkOSUser(context.Context, domain.Principal) (domain.Principal, error)
	RegisterLocal(context.Context, domain.LocalRegistration, []byte, time.Time) (domain.Principal, string, error)
	LocalUserByEmail(context.Context, string) (domain.Principal, string, error)
	CreateLocalSession(context.Context, string, []byte, time.Time) error
	PrincipalFromLocalToken(context.Context, []byte) (domain.Principal, error)
	RevokeLocalSession(context.Context, []byte) error
	ListMemberships(context.Context, domain.Principal) ([]domain.Membership, error)
	CreateProject(context.Context, domain.Principal, string, string, domain.CreateProject) (domain.Project, error)
	ListProjects(context.Context, domain.Principal, string, *domain.Cursor, int) ([]domain.Project, bool, error)
	CreateSession(context.Context, domain.Principal, string, string, domain.CreateSession) (domain.Session, error)
	ListSessions(context.Context, domain.Principal, string, string, *domain.Cursor, int) ([]domain.Session, bool, error)
	GetSession(context.Context, domain.Principal, string, string) (domain.Session, error)
	SendMessage(context.Context, domain.Principal, string, string, string, string) (domain.ClientEvent, error)
	ListClientEvents(context.Context, domain.Principal, string, string, int64, int) ([]domain.ClientEvent, bool, error)
	CountActiveSandboxes(context.Context, domain.Principal, string) (int, error)
	RedeemWorkerBootstrapTicket(context.Context, string) (domain.AccessTicket, error)
	WorkerLaunchSpec(context.Context, string, string) (domain.WorkerLaunch, error)
	RegisterWorkerBootstrap(ctx context.Context, orgID, sessionID, workerID, version string, epoch int64, capabilities []string) error
	WorkerConnectionCurrent(ctx context.Context, orgID, sessionID, workerID string, epoch int64) (bool, error)
	MarkWorkerSeen(ctx context.Context, orgID, sessionID, workerID, version string, epoch int64, capabilities []string) error
	AppendSessionEvent(ctx context.Context, orgID, sessionID, eventType string, payload json.RawMessage) (domain.ClientEvent, error)
}

// WorkerTokens issues and verifies the short-lived credentials sandbox workers
// present. It is nil when the deployment runs without sandbox provisioning, in
// which case the worker routes report 404 rather than failing open.
type WorkerTokens interface {
	Issue(worker.Claims, time.Duration) (string, error)
	Verify(string) (worker.Claims, error)
}

type Server struct {
	store               Store
	workos              auth.WorkOSVerifier
	localAuthEnabled    bool
	localSessionTTL     time.Duration
	localAuthLimiter    *fixedWindowLimiter
	sandboxProvider     string
	provisioning        sandbox.ProvisioningDefaults
	workerTokens        WorkerTokens
	maxSandboxes        int
	environment         string
	release             string
	draining            atomic.Bool
	drainOnce           sync.Once
	drain               chan struct{}
	logger              *slog.Logger
	github              *githubapp.Service
	secretCipher        *secrets.Cipher
	credentialValidator credentialValidator
	webhookMaxBody      int64
	handler             http.Handler
}

type Options struct {
	Store               Store
	WorkOS              auth.WorkOSVerifier
	LocalAuthEnabled    bool
	LocalSessionTTL     time.Duration
	SandboxProvider     string
	Provisioning        sandbox.ProvisioningDefaults
	WorkerTokens        WorkerTokens
	MaxSandboxes        int
	Environment         string
	Release             string
	Logger              *slog.Logger
	GitHub              *githubapp.Service
	SecretCipher        *secrets.Cipher
	CredentialValidator credentialValidator
	WebhookMaxBody      int64
}

func New(options Options) *Server {
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	sandboxProvider := options.SandboxProvider
	if sandboxProvider == "" {
		sandboxProvider = sandbox.DefaultProvider
	}
	environment := options.Environment
	if environment == "" {
		environment = "development"
	}
	release := options.Release
	if release == "" {
		release = "dev"
	}
	webhookMaxBody := options.WebhookMaxBody
	if webhookMaxBody == 0 {
		webhookMaxBody = 2 << 20
	}
	// An unset quota must not read as "no capacity at all", which would reject
	// every session with a 409 the caller cannot act on.
	maxSandboxes := options.MaxSandboxes
	if maxSandboxes <= 0 {
		maxSandboxes = DefaultMaxSandboxesPerOrg
	}
	server := &Server{
		store:               options.Store,
		workos:              options.WorkOS,
		localAuthEnabled:    options.LocalAuthEnabled,
		localSessionTTL:     options.LocalSessionTTL,
		localAuthLimiter:    newFixedWindowLimiter(10, time.Minute, 4096),
		sandboxProvider:     sandboxProvider,
		provisioning:        options.Provisioning,
		workerTokens:        options.WorkerTokens,
		maxSandboxes:        maxSandboxes,
		environment:         environment,
		release:             release,
		drain:               make(chan struct{}),
		logger:              logger,
		github:              options.GitHub,
		secretCipher:        options.SecretCipher,
		credentialValidator: options.CredentialValidator,
		webhookMaxBody:      webhookMaxBody,
	}
	if server.credentialValidator == nil {
		server.credentialValidator = newAgentCredentialValidator(nil)
	}
	server.provisioning.Provider = sandboxProvider
	if server.provisioning.Release == "" {
		server.provisioning.Release = release
	}
	router := chi.NewRouter()
	router.Use(server.requestID)
	router.Use(server.requestLog)
	router.Get("/healthz", server.health)
	router.Get("/readyz", server.ready)
	router.Get("/github/healthz", server.githubHealth)
	if server.github != nil {
		router.Get("/api/cloud/v1/github/install/setup", server.githubSetupCallback)
		router.Get("/api/cloud/v1/github/oauth/callback", server.githubOAuthCallback)
		router.Post("/api/cloud/v1/github/webhooks", server.githubWebhook)
	}
	router.Route("/api/cloud/v1", func(router chi.Router) {
		router.Post("/auth/local/register", server.registerLocal)
		router.Post("/auth/local/login", server.loginLocal)
		router.With(server.authenticate).Post("/auth/local/logout", server.logoutLocal)
		router.With(server.authenticate).Get("/me", server.me)
		// Workers hold no user identity, so they never pass through
		// server.authenticate. Bootstrap is gated by a one-time ticket;
		// everything after it by a short-lived worker token.
		router.Post("/worker/bootstrap", server.workerBootstrap)
		router.Group(func(router chi.Router) {
			router.Use(server.workerAuth)
			router.Post("/worker/heartbeat", server.workerHeartbeat)
			router.Post("/worker/events", server.workerEvent)
		})
		router.Route("/orgs/{orgId}", func(router chi.Router) {
			router.Use(server.authenticate)
			if server.github != nil {
				router.Get("/github/installations", server.listGitHubInstallations)
				router.Post("/github/installations/start", server.startGitHubInstallation)
				router.Post("/github/installations/{installationId}/sync", server.syncGitHubInstallation)
				router.Post("/github/installations/{installationId}/disconnect", server.disconnectGitHubInstallation)
				router.Get("/github/repositories", server.listGitHubRepositories)
				router.Post("/github/projects", server.createGitHubProject)
			}
			router.Get("/projects", server.listProjects)
			router.Post("/projects", server.createProject)
			router.Get("/provider-connections", server.listProviderConnections)
			router.Put("/provider-connections/agents/{agent}", server.putAgentConnection)
			router.Delete("/provider-connections/agents/{agent}", server.deleteAgentConnection)
			router.Get("/sessions", server.listSessions)
			router.Post("/sessions", server.createSession)
			router.Get("/sessions/{sessionId}", server.getSession)
			router.Post("/sessions/{sessionId}/messages", server.sendMessage)
			router.Get("/sessions/{sessionId}/chat-events", server.replayClientEvents)
			router.Get("/sessions/{sessionId}/events", server.streamClientEvents)
		})
	})
	server.handler = router
	return server
}

func (s *Server) Handler() http.Handler {
	return s.handler
}

func (s *Server) SetDraining(draining bool) {
	s.draining.Store(draining)
	if draining {
		s.drainOnce.Do(func() {
			close(s.drain)
		})
	}
}

type contextKey string

const (
	principalKey contextKey = "principal"
	bearerKey    contextKey = "bearer"
	requestIDKey contextKey = "request-id"
)

func (s *Server) requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := strings.TrimSpace(r.Header.Get("X-Request-ID"))
		if requestID == "" || len(requestID) > 200 {
			requestID = uuid.NewString()
		}
		w.Header().Set("X-Request-ID", requestID)
		w.Header().Set("X-AO-Release", s.release)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey, requestID)))
	})
}

type statusResponseWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusResponseWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusResponseWriter) Write(body []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(body)
}

func (w *statusResponseWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (s *Server) requestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		response := &statusResponseWriter{ResponseWriter: w}
		next.ServeHTTP(response, r)
		status := response.status
		if status == 0 {
			status = http.StatusOK
		}
		s.logger.Info(
			"HTTP request complete",
			"method",
			r.Method,
			"route",
			chi.RouteContext(r.Context()).RoutePattern(),
			"status",
			status,
			"duration_ms",
			time.Since(started).Milliseconds(),
			"request_id",
			requestID(r),
			"release",
			s.release,
		)
	})
}

func (s *Server) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := strings.TrimSpace(r.Header.Get("Authorization"))
		scheme, token, ok := strings.Cut(header, " ")
		if !ok || !strings.EqualFold(scheme, "Bearer") || strings.TrimSpace(token) == "" {
			writeError(w, r, http.StatusUnauthorized, "unauthorized", "A bearer token is required.")
			return
		}
		token = strings.TrimSpace(token)
		var principal domain.Principal
		var err error
		if strings.HasPrefix(token, "ao_local_") {
			if !s.localAuthEnabled {
				writeError(w, r, http.StatusUnauthorized, "unauthorized", "Local authentication is disabled.")
				return
			}
			principal, err = s.store.PrincipalFromLocalToken(r.Context(), auth.HashToken(token))
		} else {
			if s.workos == nil {
				writeError(w, r, http.StatusUnauthorized, "unauthorized", "WorkOS authentication is not configured.")
				return
			}
			principal, err = s.workos.Verify(r.Context(), token)
			if err == nil {
				principal, err = s.store.UpsertWorkOSUser(r.Context(), principal)
			}
		}
		if err != nil {
			if errors.Is(err, postgres.ErrNotFound) || errors.Is(err, auth.ErrInvalidToken) {
				writeError(w, r, http.StatusUnauthorized, "unauthorized", "The access token is invalid or expired.")
				return
			}
			s.logger.Error("authenticate request", "error", err, "request_id", requestID(r))
			writeError(w, r, http.StatusServiceUnavailable, "authentication_unavailable", "Authentication is temporarily unavailable.")
			return
		}
		ctx := context.WithValue(r.Context(), principalKey, principal)
		ctx = context.WithValue(ctx, bearerKey, token)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func principalFrom(r *http.Request) domain.Principal {
	principal, _ := r.Context().Value(principalKey).(domain.Principal)
	return principal
}

func bearerFrom(r *http.Request) string {
	token, _ := r.Context().Value(bearerKey).(string)
	return token
}

func requestID(r *http.Request) string {
	value, _ := r.Context().Value(requestIDKey).(string)
	return value
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.statusResponse("ok"))
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	if s.draining.Load() {
		writeError(w, r, http.StatusServiceUnavailable, "draining", "The control plane is draining.")
		return
	}
	if err := s.store.Ping(r.Context()); err != nil {
		writeError(w, r, http.StatusServiceUnavailable, "database_unavailable", "The database is unavailable.")
		return
	}
	writeJSON(w, http.StatusOK, s.statusResponse("ready"))
}

func (s *Server) statusResponse(status string) map[string]string {
	return map[string]string{
		"status":      status,
		"environment": s.environment,
		"release":     s.release,
	}
}
