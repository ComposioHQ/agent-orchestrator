package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/postgres"
	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
)

const (
	terminalTicketTTL  = 30 * time.Second
	terminalSessionTTL = 30 * time.Minute
)

func (s *Server) createTerminalTicket(w http.ResponseWriter, r *http.Request) {
	orgID := chi.URLParam(r, "orgId")
	sessionID := chi.URLParam(r, "sessionId")
	if requireUUID(orgID, "orgId") != nil || requireUUID(sessionID, "sessionId") != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "orgId and sessionId must be UUIDs.")
		return
	}
	var input struct {
		Kind string `json:"kind"`
	}
	if err := decodeJSONLimit(w, r, &input, maxWorkerControlBody); err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	if input.Kind != "workspace" {
		writeError(w, r, http.StatusUnprocessableEntity, "TERMINAL_KIND_UNSUPPORTED", "Only workspace terminals are currently supported.")
		return
	}
	token, scopes, err := s.store.IssueTerminalTicket(
		r.Context(), principalFrom(r), orgID, sessionID, input.Kind, terminalTicketTTL,
	)
	if errors.Is(err, postgres.ErrForbidden) {
		writeError(w, r, http.StatusForbidden, "TERMINAL_POLICY_DENIED", "Terminal access is not allowed for this session.")
		return
	}
	if err != nil {
		s.writeWorkspaceStoreError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusCreated, map[string]any{
		"ticket": token, "expiresIn": int(terminalTicketTTL.Seconds()), "scopes": scopes,
	})
}

func (s *Server) connectTerminal(w http.ResponseWriter, r *http.Request) {
	token := strings.TrimSpace(r.URL.Query().Get("ticket"))
	kind := strings.TrimSpace(r.URL.Query().Get("kind"))
	if kind == "" {
		kind = "workspace"
	}
	after, err := strconv.ParseInt(defaultString(r.URL.Query().Get("after"), "0"), 10, 64)
	if token == "" || kind != "workspace" || err != nil || after < 0 {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "A valid ticket, kind, and after cursor are required.")
		return
	}
	terminal, err := s.store.OpenTerminal(r.Context(), token, kind, terminalSessionTTL)
	if errors.Is(err, postgres.ErrInvalidTicket) {
		writeError(w, r, http.StatusUnauthorized, "INVALID_TERMINAL_TICKET", "The terminal ticket is invalid, expired, or already used.")
		return
	}
	if err != nil {
		s.writeWorkspaceStoreError(w, r, err)
		return
	}

	// Browser clients may be hosted on a separate Cloud UI origin. The
	// cryptographically random, single-use ticket is the request's CSRF and
	// authorization boundary, so origin affinity is neither required nor used.
	connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		CompressionMode:    websocket.CompressionDisabled,
		InsecureSkipVerify: true,
	})
	if err != nil {
		s.closeTerminal(r, terminal)
		return
	}
	connection.SetReadLimit(maxTerminalFrame)
	defer func() {
		s.closeTerminal(r, terminal)
		_ = connection.Close(websocket.StatusNormalClosure, "terminal closed")
	}()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	readResult := make(chan error, 1)
	go func() {
		readResult <- s.readTerminalInput(ctx, connection, terminal)
	}()
	writeResult := make(chan error, 1)
	go func() {
		writeResult <- s.writeTerminalOutput(ctx, connection, terminal, after)
	}()

	select {
	case err = <-readResult:
	case err = <-writeResult:
	case <-ctx.Done():
		err = ctx.Err()
	}
	cancel()
	if err != nil && !errors.Is(err, context.Canceled) &&
		websocket.CloseStatus(err) == -1 {
		s.logger.Debug("terminal stream ended", "error", err, "terminal_id", terminal.ID)
	}
}

func (s *Server) readTerminalInput(
	ctx context.Context,
	connection *websocket.Conn,
	terminal domain.TerminalSession,
) error {
	operate := terminalScope(terminal.Scopes, "terminal:operate")
	for {
		_, data, err := connection.Read(ctx)
		if err != nil {
			return err
		}
		if !operate {
			return connection.Close(websocket.StatusPolicyViolation, "terminal is read-only")
		}
		if len(data) == 0 || len(data) > maxTerminalFrame {
			return connection.Close(websocket.StatusMessageTooBig, "terminal input is too large")
		}
		deadline := time.NewTimer(2 * time.Second)
		ticker := time.NewTicker(50 * time.Millisecond)
		for {
			err = s.store.QueueTerminalInput(ctx, terminal, data)
			if err == nil {
				break
			}
			if !errors.Is(err, postgres.ErrWorkerUnavailable) {
				deadline.Stop()
				ticker.Stop()
				return err
			}
			select {
			case <-ctx.Done():
				deadline.Stop()
				ticker.Stop()
				return ctx.Err()
			case <-deadline.C:
				ticker.Stop()
				return errors.New("terminal did not become ready")
			case <-ticker.C:
			}
		}
		deadline.Stop()
		ticker.Stop()
	}
}

func (s *Server) writeTerminalOutput(
	ctx context.Context,
	connection *websocket.Conn,
	terminal domain.TerminalSession,
	after int64,
) error {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		frames, state, err := s.store.ListTerminalOutput(ctx, terminal, after, 100)
		if err != nil {
			return err
		}
		for _, frame := range frames {
			if err := connection.Write(ctx, websocket.MessageText, frame.Data); err != nil {
				return err
			}
			after = frame.Sequence
		}
		if state == "closed" || state == "failed" {
			return connection.Close(websocket.StatusNormalClosure, "terminal process exited")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (s *Server) closeTerminal(r *http.Request, terminal domain.TerminalSession) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), time.Second)
	defer cancel()
	if err := s.store.CloseTerminal(ctx, terminal); err != nil {
		s.logger.Debug("close terminal session", "error", err, "terminal_id", terminal.ID)
	}
}

func terminalScope(scopes []string, expected string) bool {
	for _, scope := range scopes {
		if scope == expected {
			return true
		}
	}
	return false
}

func defaultString(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}
