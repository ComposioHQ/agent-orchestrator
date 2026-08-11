package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/auth"
	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/postgres"
	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

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
}

type Server struct {
	store            Store
	workos           auth.WorkOSVerifier
	localAuthEnabled bool
	localSessionTTL  time.Duration
	localAuthLimiter *fixedWindowLimiter
	logger           *slog.Logger
	handler          http.Handler
}

type Options struct {
	Store            Store
	WorkOS           auth.WorkOSVerifier
	LocalAuthEnabled bool
	LocalSessionTTL  time.Duration
	Logger           *slog.Logger
}

func New(options Options) *Server {
	logger := options.Logger
	if logger == nil {
		logger = slog.Default()
	}
	server := &Server{
		store:            options.Store,
		workos:           options.WorkOS,
		localAuthEnabled: options.LocalAuthEnabled,
		localSessionTTL:  options.LocalSessionTTL,
		localAuthLimiter: newFixedWindowLimiter(10, time.Minute, 4096),
		logger:           logger,
	}
	router := chi.NewRouter()
	router.Use(server.requestID)
	router.Get("/healthz", server.health)
	router.Get("/readyz", server.ready)
	router.Route("/api/cloud/v1", func(router chi.Router) {
		router.Post("/auth/local/register", server.registerLocal)
		router.Post("/auth/local/login", server.loginLocal)
		router.With(server.authenticate).Post("/auth/local/logout", server.logoutLocal)
		router.With(server.authenticate).Get("/me", server.me)
		router.Route("/orgs/{orgId}", func(router chi.Router) {
			router.Use(server.authenticate)
			router.Get("/projects", server.listProjects)
			router.Post("/projects", server.createProject)
			router.Get("/sessions", server.listSessions)
			router.Post("/sessions", server.createSession)
			router.Get("/sessions/{sessionId}", server.getSession)
		})
	})
	server.handler = router
	return server
}

func (s *Server) Handler() http.Handler {
	return s.handler
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
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDKey, requestID)))
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
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) ready(w http.ResponseWriter, r *http.Request) {
	if err := s.store.Ping(r.Context()); err != nil {
		writeError(w, r, http.StatusServiceUnavailable, "database_unavailable", "The database is unavailable.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}
