package envelope

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5/middleware"

	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

// errCapture is a request-scoped slot WriteError records the raw service error
// into. The wire envelope deliberately hides internals behind "Internal server
// error", which previously meant a 500's cause was lost entirely — the access
// log reads the captured error back so the daemon log keeps the diagnosis.
type errCapture struct{ err error }

type errCaptureKey struct{}

// WithErrorCapture returns a copy of the request whose context carries an
// error-capture slot, plus a getter for the error recorded by WriteError while
// handling it. The request logger installs it and reads it after the handler.
func WithErrorCapture(r *http.Request) (*http.Request, func() error) {
	capture := &errCapture{}
	req := r.WithContext(context.WithValue(r.Context(), errCaptureKey{}, capture))
	return req, func() error { return capture.err }
}

// captureError records err for the request if a capture slot is present.
func captureError(r *http.Request, err error) {
	if c, ok := r.Context().Value(errCaptureKey{}).(*errCapture); ok {
		c.err = err
	}
}

// APIError is the locked wire shape for every non-2xx response.
type APIError struct {
	Error     string         `json:"error"`
	Code      string         `json:"code"`
	Message   string         `json:"message"`
	RequestID string         `json:"requestId,omitempty"`
	Details   map[string]any `json:"details,omitempty"`
}

// WriteJSON serialises v as JSON with the given status.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// WriteAPIError emits the locked envelope for any non-2xx response.
func WriteAPIError(w http.ResponseWriter, r *http.Request, status int, kind, code, message string, details map[string]any) {
	WriteJSON(w, status, APIError{
		Error:     kind,
		Code:      code,
		Message:   message,
		RequestID: middleware.GetReqID(r.Context()),
		Details:   details,
	})
}

// WriteError is the single path from any service error to the wire envelope. It
// renders an *apierr.Error (anywhere in the chain) using its Kind, and falls
// back to a 500 for any other error so internal details never leak. This is the
// only place an apierr.Kind is translated into an HTTP status and wire word.
func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	captureError(r, err)
	var e *apierr.Error
	if errors.As(err, &e) {
		status, kind := httpStatus(e.Kind)
		WriteAPIError(w, r, status, kind, e.Code, e.Message, e.Details)
		return
	}
	// A transient failure (the database was momentarily busy/locked, or a
	// server-side deadline elapsed) is retryable, not a server fault. Map it to
	// 503 with a stable code so it is not counted or alerted as an
	// INTERNAL_ERROR 500 and so clients can back off and retry.
	if isTransient(err) {
		WriteAPIError(w, r, http.StatusServiceUnavailable, "unavailable", "SERVICE_UNAVAILABLE",
			"The service is momentarily unavailable, please retry.", nil)
		return
	}
	WriteAPIError(w, r, http.StatusInternalServerError, "internal", "INTERNAL_ERROR", "Internal server error", nil)
}

// SQLite primary result codes for a busy/locked database. Extended codes (e.g.
// SQLITE_BUSY_SNAPSHOT) carry these in their low byte. Declared here rather
// than imported so the envelope layer does not depend on the DB driver; the
// modernc.org/sqlite error type is matched structurally by its Code() method.
const (
	sqliteBusy   = 5
	sqliteLocked = 6
)

// isTransient reports whether err is a retryable contention/timeout condition
// rather than a genuine server fault. It matches the SQLite driver's error via
// a Code() method (no driver import), plus server-side context deadlines.
// Context cancellation (the client went away) is deliberately excluded — the
// response never reaches that caller, and it is not retryable.
func isTransient(err error) bool {
	if errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	var coder interface{ Code() int }
	if errors.As(err, &coder) {
		c := coder.Code()
		return c == sqliteBusy || c == sqliteLocked || c&0xFF == sqliteBusy || c&0xFF == sqliteLocked
	}
	return false
}

// httpStatus maps a semantic failure Kind to its HTTP status and wire word.
func httpStatus(k apierr.Kind) (int, string) {
	switch k {
	case apierr.KindInvalid:
		return http.StatusBadRequest, "bad_request"
	case apierr.KindNotFound:
		return http.StatusNotFound, "not_found"
	case apierr.KindConflict:
		return http.StatusConflict, "conflict"
	case apierr.KindForbidden:
		return http.StatusForbidden, "forbidden"
	case apierr.KindUnavailable:
		return http.StatusServiceUnavailable, "unavailable"
	case apierr.KindInternal:
		return http.StatusInternalServerError, "internal"
	default:
		return http.StatusInternalServerError, "internal"
	}
}
