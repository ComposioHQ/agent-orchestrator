package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/postgres"
	"github.com/Untrivial-ai/ao-cloud/internal/worker"
)

// Worker events are namespaced so a compromised sandbox cannot forge a
// control-plane or billing event onto its own session stream.
var workerEventPrefixes = []string{
	"worker.",
	"agent.",
	"terminal.",
	"repository.",
	"chat.",
}

const maxWorkerEventType = 100

// workerBootstrap redeems a one-time ticket for a live worker credential. It is
// the only unauthenticated worker route: the ticket itself is the proof, and it
// is consumed atomically so a replayed token buys nothing.
func (s *Server) workerBootstrap(w http.ResponseWriter, r *http.Request) {
	if s.workerTokens == nil {
		writeError(w, r, http.StatusNotFound, "not_found", "Worker bootstrap is not enabled.")
		return
	}
	var input worker.BootstrapRequest
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if strings.TrimSpace(input.BootstrapToken) == "" {
		writeError(w, r, http.StatusUnauthorized, "INVALID_BOOTSTRAP", "A bootstrap token is required.")
		return
	}

	ticket, err := s.store.RedeemWorkerBootstrapTicket(r.Context(), input.BootstrapToken)
	if errors.Is(err, postgres.ErrInvalidTicket) {
		writeError(w, r, http.StatusUnauthorized, "INVALID_BOOTSTRAP", "The bootstrap token is invalid, expired, or already used.")
		return
	}
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	if ticket.WorkerEpoch <= 0 {
		s.logger.Error("worker bootstrap produced no epoch", "session_id", ticket.SessionID, "request_id", requestID(r))
		writeError(w, r, http.StatusInternalServerError, "BOOTSTRAP_FAILED", "Worker bootstrap identity was not assigned.")
		return
	}

	launch, err := s.store.WorkerLaunchSpec(r.Context(), ticket.OrgID, ticket.SessionID)
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}

	workerID := worker.NextWorkerID(ticket.SessionID, ticket.WorkerEpoch)
	if err := s.store.RegisterWorkerBootstrap(
		r.Context(),
		ticket.OrgID,
		ticket.SessionID,
		workerID,
		input.Version,
		ticket.WorkerEpoch,
		input.Capabilities,
	); err != nil {
		s.writeStoreError(w, r, err)
		return
	}

	token, err := s.workerTokens.Issue(worker.Claims{
		OrgID:     ticket.OrgID,
		SessionID: ticket.SessionID,
		WorkerID:  workerID,
		Epoch:     ticket.WorkerEpoch,
		Scopes:    ticket.Scopes,
	}, s.workerTokenTTL())
	if err != nil {
		s.logger.Error("issue worker token", "error", err, "request_id", requestID(r))
		writeError(w, r, http.StatusInternalServerError, "internal_error", "The worker credential could not be issued.")
		return
	}

	payload, _ := json.Marshal(map[string]any{"workerId": workerID, "epoch": ticket.WorkerEpoch})
	if _, err := s.store.AppendSessionEvent(
		r.Context(), ticket.OrgID, ticket.SessionID, "worker.connected", payload,
	); err != nil {
		s.logger.Warn("append worker.connected event", "error", err, "request_id", requestID(r))
	}

	writeJSON(w, http.StatusOK, worker.BootstrapResponse{
		WorkerToken: token,
		WorkerID:    workerID,
		Epoch:       ticket.WorkerEpoch,
		ExpiresIn:   int(s.workerTokenTTL().Seconds()),
		SessionID:   ticket.SessionID,
		Launch: worker.LaunchContext{
			SessionID:     launch.SessionID,
			ProjectID:     launch.ProjectID,
			Kind:          launch.Kind,
			Harness:       launch.Harness,
			DisplayName:   launch.DisplayName,
			Branch:        launch.Branch,
			RepositoryURL: launch.RepositoryURL,
			DefaultBranch: launch.DefaultBranch,
		},
	})
}

type workerContextKey struct{}

// workerAuth authenticates a live worker. A valid signature is not enough: the
// claimed epoch must still be the session's current one, so a worker that a
// recreate replaced is rejected even while its token is unexpired.
func (s *Server) workerAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.workerTokens == nil {
			writeError(w, r, http.StatusNotFound, "not_found", "Worker routes are not enabled.")
			return
		}
		scheme, token, ok := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " ")
		if !ok || !strings.EqualFold(scheme, "Worker") {
			writeError(w, r, http.StatusUnauthorized, "WORKER_AUTH_REQUIRED", "A worker credential is required.")
			return
		}
		claims, err := s.workerTokens.Verify(strings.TrimSpace(token))
		if err != nil {
			writeError(w, r, http.StatusUnauthorized, "INVALID_WORKER_TOKEN", "The worker credential is invalid or expired.")
			return
		}
		current, err := s.store.WorkerConnectionCurrent(
			r.Context(), claims.OrgID, claims.SessionID, claims.WorkerID, claims.Epoch,
		)
		if err != nil {
			s.writeStoreError(w, r, err)
			return
		}
		if !current {
			writeError(w, r, http.StatusUnauthorized, "STALE_WORKER_TOKEN", "The worker credential has been replaced.")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), workerContextKey{}, claims)))
	})
}

func workerFrom(r *http.Request) worker.Claims {
	claims, _ := r.Context().Value(workerContextKey{}).(worker.Claims)
	return claims
}

// workerHeartbeat records liveness and renews the worker's short-lived token.
// This is the only path that promotes a sandbox to running.
func (s *Server) workerHeartbeat(w http.ResponseWriter, r *http.Request) {
	claims := workerFrom(r)
	if !worker.HasScope(claims, "worker:connect") {
		writeError(w, r, http.StatusForbidden, "SCOPE_REQUIRED", "The worker:connect scope is required.")
		return
	}
	var input worker.HeartbeatRequest
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if err := s.store.MarkWorkerSeen(
		r.Context(),
		claims.OrgID,
		claims.SessionID,
		claims.WorkerID,
		input.Version,
		claims.Epoch,
		input.Capabilities,
	); err != nil {
		if errors.Is(err, postgres.ErrStaleWorker) {
			writeError(w, r, http.StatusUnauthorized, "STALE_WORKER_TOKEN", "The worker credential has been replaced.")
			return
		}
		s.writeStoreError(w, r, err)
		return
	}
	renewed, err := s.workerTokens.Issue(claims, s.workerTokenTTL())
	if err != nil {
		s.logger.Error("renew worker token", "error", err, "request_id", requestID(r))
		writeError(w, r, http.StatusInternalServerError, "internal_error", "The worker credential could not be renewed.")
		return
	}
	writeJSON(w, http.StatusOK, worker.HeartbeatResponse{
		OK:          true,
		WorkerToken: renewed,
		ExpiresIn:   int(s.workerTokenTTL().Seconds()),
	})
}

// workerEvent publishes one worker-originated event onto the session stream.
func (s *Server) workerEvent(w http.ResponseWriter, r *http.Request) {
	claims := workerFrom(r)
	if !worker.HasScope(claims, "worker:event") {
		writeError(w, r, http.StatusForbidden, "SCOPE_REQUIRED", "The worker:event scope is required.")
		return
	}
	var input struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := decodeJSON(w, r, &input); err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	input.Type = strings.TrimSpace(input.Type)
	if !allowedWorkerEventType(input.Type) {
		writeError(w, r, http.StatusBadRequest, "INVALID_EVENT_TYPE", "The worker event type is not allowed.")
		return
	}
	// ao_events.payload is constrained to a JSON object. Unmarshalling into a
	// map is not enough of a check on its own: JSON null unmarshals into a nil
	// map without error, so it would pass here and then fail the constraint as
	// a 500 rather than being refused as the bad request it is.
	if len(input.Payload) > 0 {
		var object map[string]any
		if err := json.Unmarshal(input.Payload, &object); err != nil || object == nil {
			writeError(w, r, http.StatusBadRequest, "INVALID_EVENT_PAYLOAD", "The worker event payload must be a JSON object.")
			return
		}
	}
	if _, err := s.store.AppendSessionEvent(
		r.Context(), claims.OrgID, claims.SessionID, input.Type, input.Payload,
	); err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]bool{"ok": true})
}

func allowedWorkerEventType(eventType string) bool {
	if eventType == "" || len(eventType) > maxWorkerEventType {
		return false
	}
	for _, prefix := range workerEventPrefixes {
		if strings.HasPrefix(eventType, prefix) {
			return true
		}
	}
	return false
}

// workerTokenTTL is how long an issued worker credential stays valid. An
// operator who shortens it gets a shorter blast radius on a leaked token at the
// cost of more renewals; an unset value falls back to the protocol default
// rather than to zero, which Issue would treat as "no lifetime at all".
func (s *Server) workerTokenTTL() time.Duration {
	if s.workerTokenLifetime > 0 {
		return s.workerTokenLifetime
	}
	return worker.DefaultTokenTTL
}
