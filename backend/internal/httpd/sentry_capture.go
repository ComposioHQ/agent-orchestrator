package httpd

import (
	"context"
	"net/http"
)

// sentryCaptureState is a request-scoped flag marking that a failure for this
// request has already been sent to Sentry. It lets the panic recover middleware
// and the outer 5xx access-log seam agree on a single capture: recovery sends
// the panic (fatal, with the Go stack and request id) and sets this, so the
// logger does not then manufacture a second generic "HTTP 500" event with a
// different fingerprint — one panic would otherwise become two issues.
//
// The slot is installed by the outer request logger and confined to a single
// request goroutine (chi serves each request on one goroutine, and the recover
// and logger deferreds both run on it in sequence), so the plain bool needs no
// synchronization.
type sentryCaptureState struct{ captured bool }

type sentryCaptureKey struct{}

// withSentryCaptureState installs the marker on the request context. The request
// logger (outer middleware) installs it so the inner recover middleware shares
// the same slot.
func withSentryCaptureState(r *http.Request) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), sentryCaptureKey{}, &sentryCaptureState{}))
}

// markSentryCaptured records that this request's failure was already captured.
func markSentryCaptured(ctx context.Context) {
	if s, ok := ctx.Value(sentryCaptureKey{}).(*sentryCaptureState); ok {
		s.captured = true
	}
}

// sentryAlreadyCaptured reports whether a failure was already captured for this
// request.
func sentryAlreadyCaptured(ctx context.Context) bool {
	s, ok := ctx.Value(sentryCaptureKey{}).(*sentryCaptureState)
	return ok && s.captured
}
