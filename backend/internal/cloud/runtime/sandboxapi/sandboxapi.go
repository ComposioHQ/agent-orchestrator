// Package sandboxapi serves the published listener that sandboxes call the
// control plane on.
//
// This surface is deliberately separate from the account API. Sandboxes run
// outside the control plane's network and hold a capability, not an AO user
// access token, so mixing the two would mean one middleware deciding between
// two credential classes — the kind of branch that eventually authorizes the
// wrong one. Keeping them apart also keeps this surface tiny: three
// operations, no tenant identifiers accepted from the client, and no route
// that can reach another session.
//
// The load-bearing rule is that EVERY tenant identifier comes from the
// verified capability's scope. Nothing in a request body selects an
// organization, workspace, or session. A compromised sandbox can therefore
// only ever act as itself.
package sandboxapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/capability"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
)

// maxRequestBodyBytes matches the account API's limit. A sandbox has no reason
// to send a large body, and the listener is reachable from the public
// internet.
const maxRequestBodyBytes = 1 << 16

// Compute is the lifecycle surface the listener needs. *runtime.Manager
// satisfies it.
type Compute interface {
	Heartbeat(ctx context.Context, ref runtime.Ref, at time.Time) (runtime.Record, error)
	ReportState(ctx context.Context, ref runtime.Ref, state runtime.State, failure string) (runtime.Record, error)
}

// Rotator exchanges a live capability for a successor. *capability.Authority
// satisfies it.
type Rotator interface {
	Rotate(ctx context.Context, token string) (capability.Grant, error)
}

// Options supplies the listener's dependencies.
type Options struct {
	Compute      Compute
	Capabilities capability.Verifier
	Rotator      Rotator
	Clock        func() time.Time
	Logger       *slog.Logger
}

// Server is the published sandbox listener.
type Server struct {
	compute      Compute
	capabilities capability.Verifier
	rotator      Rotator
	now          func() time.Time
	logger       *slog.Logger
	handler      http.Handler
}

// New builds the listener.
func New(options Options) (*Server, error) {
	if options.Compute == nil || options.Capabilities == nil || options.Rotator == nil {
		return nil, errors.New("sandbox listener requires a compute manager, a capability verifier, and a rotator")
	}
	if options.Clock == nil {
		options.Clock = time.Now
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	server := &Server{
		compute:      options.Compute,
		capabilities: options.Capabilities,
		rotator:      options.Rotator,
		now:          options.Clock,
		logger:       options.Logger,
	}
	server.handler = server.routes()
	return server, nil
}

// Handler returns the listener's HTTP handler. Mount it on the public surface;
// it must not be placed behind the account API's user-token middleware.
func (s *Server) Handler() http.Handler { return s.handler }

// BasePath is where the routes below are expected to be mounted.
const BasePath = "/api/cloud/v1/sandbox"

func (s *Server) routes() http.Handler {
	router := chi.NewRouter()
	router.Use(middleware.RequestID)
	router.Use(middleware.RealIP)
	router.Use(s.limitBody)

	// Each route pins exactly one operation. A sandbox that was granted only
	// heartbeat cannot reach report-state by changing its payload.
	router.With(capability.Require(s.capabilities, capability.OpSandboxHeartbeat)).
		Post("/heartbeat", s.heartbeat)
	router.With(capability.Require(s.capabilities, capability.OpSandboxReportState)).
		Post("/state", s.reportState)
	router.With(capability.Require(s.capabilities, capability.OpCapabilityRotate)).
		Post("/capability/rotate", s.rotate)
	return router
}

func (s *Server) limitBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		request.Body = http.MaxBytesReader(writer, request.Body, maxRequestBodyBytes)
		next.ServeHTTP(writer, request)
	})
}

// refFor builds the placement reference from the verified scope alone. The
// user id is deliberately absent: a sandbox credential proves which placement
// is calling, never which human owns it.
func refFor(scope capability.Scope) runtime.Ref {
	return runtime.Ref{
		OrgID:       scope.OrgID,
		WorkspaceID: scope.WorkspaceID,
		SessionID:   scope.SessionID,
		Role:        runtime.Role(scope.Role),
	}
}

type heartbeatResponse struct {
	State        string `json:"state"`
	DesiredState string `json:"desiredState"`
	// CapabilityExpiresAt lets a long-lived sandbox rotate before it is locked
	// out, instead of discovering the expiry as a 401 mid-turn.
	CapabilityExpiresAt time.Time `json:"capabilityExpiresAt"`
}

// heartbeat records a check-in and returns the state the control plane wants
// the sandbox in, which is how a sandbox learns about a pending stop without
// the control plane holding a connection open.
func (s *Server) heartbeat(writer http.ResponseWriter, request *http.Request) {
	verified, ok := capability.FromContext(request.Context())
	if !ok {
		s.writeError(writer, request, http.StatusUnauthorized, "capability_required", "a capability token is required")
		return
	}
	record, err := s.compute.Heartbeat(request.Context(), refFor(verified.Scope), s.now().UTC())
	if err != nil {
		s.writeFailure(writer, request, err)
		return
	}
	s.writeJSON(writer, http.StatusOK, heartbeatResponse{
		State:               string(record.State),
		DesiredState:        string(record.DesiredState),
		CapabilityExpiresAt: verified.ExpiresAt,
	})
}

type reportStateRequest struct {
	State string `json:"state"`
	Error string `json:"error"`
}

// reportState records the sandbox's own view of itself.
func (s *Server) reportState(writer http.ResponseWriter, request *http.Request) {
	verified, ok := capability.FromContext(request.Context())
	if !ok {
		s.writeError(writer, request, http.StatusUnauthorized, "capability_required", "a capability token is required")
		return
	}
	var body reportStateRequest
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		s.writeError(writer, request, http.StatusBadRequest, "invalid_request", "request body must be JSON")
		return
	}
	record, err := s.compute.ReportState(
		request.Context(),
		refFor(verified.Scope),
		runtime.State(strings.ToLower(strings.TrimSpace(body.State))),
		body.Error,
	)
	if err != nil {
		s.writeFailure(writer, request, err)
		return
	}
	s.writeJSON(writer, http.StatusOK, heartbeatResponse{
		State:               string(record.State),
		DesiredState:        string(record.DesiredState),
		CapabilityExpiresAt: verified.ExpiresAt,
	})
}

type rotateResponse struct {
	Capability string    `json:"capability"`
	ExpiresAt  time.Time `json:"expiresAt"`
}

// rotate exchanges the presented capability for a successor with the same
// scope and the same absolute expiry. The successor is returned once; the
// predecessor is revoked by the authority.
func (s *Server) rotate(writer http.ResponseWriter, request *http.Request) {
	token, ok := capability.BearerFromContext(request.Context())
	if !ok {
		s.writeError(writer, request, http.StatusUnauthorized, "capability_required", "a capability token is required")
		return
	}
	grant, err := s.rotator.Rotate(request.Context(), token)
	if err != nil {
		s.writeFailure(writer, request, err)
		return
	}
	s.writeJSON(writer, http.StatusOK, rotateResponse{Capability: grant.Token, ExpiresAt: grant.ExpiresAt})
}

// writeFailure maps both error families the listener can produce — the
// compute plane's contract and the capability authority's — onto statuses in
// one place. Credential outcomes are checked first so a rotation refused for
// scope reasons is a 403 rather than being swallowed by a later branch.
//
// No branch echoes the caller's input back, and an unmapped error is an
// internal failure rather than a tenant mistake.
func (s *Server) writeFailure(writer http.ResponseWriter, request *http.Request, err error) {
	switch {
	case errors.Is(err, capability.ErrNotPermitted):
		s.writeError(writer, request, http.StatusForbidden, "capability_forbidden", "this capability does not permit the request")
	case errors.Is(err, capability.ErrExpired):
		s.writeError(writer, request, http.StatusUnauthorized, "capability_expired", "the capability has expired")
	case errors.Is(err, capability.ErrRevoked):
		s.writeError(writer, request, http.StatusUnauthorized, "capability_revoked", "the capability was revoked")
	case errors.Is(err, capability.ErrInvalidToken):
		s.writeError(writer, request, http.StatusUnauthorized, "capability_invalid", "the capability is not valid")
	case errors.Is(err, runtime.ErrNotFound):
		s.writeError(writer, request, http.StatusNotFound, "sandbox_not_found", "no sandbox is registered for this capability")
	case errors.Is(err, runtime.ErrDeleting):
		s.writeError(writer, request, http.StatusConflict, "sandbox_deleting", "this sandbox is being deleted")
	case errors.Is(err, runtime.ErrConflict):
		s.writeError(writer, request, http.StatusConflict, "sandbox_conflict", "the sandbox record changed concurrently")
	case errors.Is(err, runtime.ErrInvalid):
		s.writeError(writer, request, http.StatusBadRequest, "invalid_request", "the request is not valid for this sandbox")
	default:
		s.logger.Error("sandbox listener request failed", "error", err, "request_id", middleware.GetReqID(request.Context()))
		s.writeError(writer, request, http.StatusInternalServerError, "internal_error", "the request could not be completed")
	}
}

func (s *Server) writeJSON(writer http.ResponseWriter, status int, body any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(body)
}

func (s *Server) writeError(writer http.ResponseWriter, request *http.Request, status int, code, message string) {
	writer.Header().Set("Content-Type", "application/json")
	if status == http.StatusUnauthorized {
		writer.Header().Set("WWW-Authenticate", `Bearer realm="ao-cloud-sandbox"`)
	}
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(map[string]any{
		"error": map[string]string{
			"code":      code,
			"message":   message,
			"requestId": middleware.GetReqID(request.Context()),
		},
	})
}
