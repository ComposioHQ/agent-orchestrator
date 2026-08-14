package httpapi

import (
	"context"
	"encoding/json"
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
	// Browsers can take far longer than the handshake itself to actually open
	// the socket: a cold hostname costs a fresh TLS session, and Firefox burns
	// tens of seconds probing HTTP/3 — which it cannot carry a WebSocket over —
	// before falling back. A 30s ticket expired mid-fallback, so every upgrade
	// arrived already dead and the client retried forever. The ticket stays
	// single-use and session-scoped; only the window to redeem it is wider.
	terminalTicketTTL    = 5 * time.Minute
	terminalReadyTimeout = 20 * time.Second
	terminalSessionTTL   = 30 * time.Minute
	agentTerminalTTL     = 24 * time.Hour
)

var errTerminalProcessUnavailable = errors.New("terminal process unavailable")

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
	if input.Kind != "workspace" && input.Kind != "agent" {
		writeError(w, r, http.StatusUnprocessableEntity, "TERMINAL_KIND_UNSUPPORTED", "Terminal kind must be agent or workspace.")
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
	if token == "" || (kind != "workspace" && kind != "agent") || err != nil || after < 0 {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "A valid ticket, kind, and after cursor are required.")
		return
	}
	ttl := terminalSessionTTL
	if kind == "agent" {
		ttl = agentTerminalTTL
	}
	terminal, err := s.store.OpenTerminal(r.Context(), token, kind, ttl)
	if errors.Is(err, postgres.ErrInvalidTicket) {
		if s.logger != nil {
			s.logger.Warn(
				"terminal ticket rejected",
				"reason", err,
				"kind", kind,
				"request_id", requestID(r),
			)
		}
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
		if terminal.Kind != "agent" {
			s.closeTerminal(r, terminal)
		}
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
		s.logger.Warn("terminal stream ended unexpectedly", "error", err, "terminal_id", terminal.ID)
	}
	status, reason := terminalStreamClose(err)
	_ = connection.Close(status, reason)
}

func terminalStreamClose(err error) (websocket.StatusCode, string) {
	if errors.Is(err, errTerminalProcessUnavailable) {
		return websocket.StatusPolicyViolation, "terminal process unavailable"
	}
	if err != nil && !errors.Is(err, context.Canceled) &&
		websocket.CloseStatus(err) == -1 {
		return websocket.StatusInternalError, "terminal stream interrupted"
	}
	return websocket.StatusNormalClosure, "terminal closed"
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
		var message struct {
			Type    string `json:"type"`
			Data    string `json:"data,omitempty"`
			Columns uint16 `json:"columns,omitempty"`
			Rows    uint16 `json:"rows,omitempty"`
		}
		if json.Unmarshal(data, &message) == nil {
			if message.Type == "resize" {
				if message.Columns == 0 || message.Rows == 0 {
					return connection.Close(websocket.StatusPolicyViolation, "invalid terminal size")
				}
				if err := retryTerminalRequest(ctx, func() error {
					return s.store.QueueTerminalResize(
						ctx, terminal, message.Columns, message.Rows,
					)
				}); err != nil {
					return err
				}
				continue
			}
			if message.Type == "input" {
				data = []byte(message.Data)
			}
		}
		if len(data) == 0 {
			continue
		}
		if err := retryTerminalRequest(ctx, func() error {
			return s.store.QueueTerminalInput(ctx, terminal, data)
		}); err != nil {
			return err
		}
	}
}

func retryTerminalRequest(ctx context.Context, operation func() error) error {
	deadline := time.NewTimer(terminalReadyTimeout)
	defer deadline.Stop()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		err := operation()
		if err == nil {
			return nil
		}
		if !errors.Is(err, postgres.ErrWorkerUnavailable) &&
			!errors.Is(err, postgres.ErrConflict) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("terminal request queue did not become ready")
		case <-ticker.C:
		}
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
			// PTY reads are arbitrary byte chunks and can split a multi-byte
			// UTF-8 sequence. Sending them as text makes the WebSocket library
			// reject otherwise valid terminal output and disconnect the viewer.
			if err := connection.Write(ctx, websocket.MessageBinary, frame.Data); err != nil {
				return err
			}
			after = frame.Sequence
		}
		if state == "failed" {
			return errTerminalProcessUnavailable
		}
		if state == "closed" {
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
