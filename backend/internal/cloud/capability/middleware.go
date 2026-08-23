package capability

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

type verifiedContextKey struct{}

type bearerContextKey struct{}

// Verifier is the narrow interface a grant-bound HTTP surface needs.
// *Authority satisfies it; tests substitute a stub.
type Verifier interface {
	Verify(ctx context.Context, token string, op Operation) (Verified, error)
}

// Authorizer is what a target-bound HTTP surface needs. *Authority satisfies
// it.
type Authorizer interface {
	Authorize(ctx context.Context, token string, op Operation, target Target) (Verified, error)
}

// FromContext returns the verified capability attached by Require.
func FromContext(ctx context.Context) (Verified, bool) {
	verified, ok := ctx.Value(verifiedContextKey{}).(Verified)
	return verified, ok
}

// BearerFromContext returns the raw presented capability. Only rotation needs
// it — every other handler must authorize from the verified scope, never from
// the token — so it is deliberately a separate accessor rather than a field on
// Verified that a handler could log by printing the struct.
func BearerFromContext(ctx context.Context) (string, bool) {
	token, ok := ctx.Value(bearerContextKey{}).(string)
	return token, ok
}

// Require builds middleware that authenticates the Authorization bearer
// capability and authorizes exactly one GRANT-BOUND operation.
//
// The operation is fixed per route rather than derived from the request body:
// a sandbox must not be able to widen its own authorization by naming a
// different operation in a payload. Handlers read the granted scope from the
// context and must ignore org/workspace/session ids sent in the body.
//
// A workspace- or self-bound operation cannot be used here; the authority
// rejects it. Use RequireTarget, which forces the route to say what it
// resolved.
func Require(verifier Verifier, op Operation) func(http.Handler) http.Handler {
	return authorizeWith(op, func(ctx context.Context, token string, _ *http.Request) (Verified, error) {
		return verifier.Verify(ctx, token, op)
	})
}

// TargetResolver derives the target of a request from the route. It must read
// the target from the path and from durable records — never from a body field
// the caller controls, which would let a token holder nominate its own target
// and defeat the binding entirely.
//
// Returning an error rejects the request as a bad request.
type TargetResolver func(*http.Request) (Target, error)

// RequireTarget builds middleware for a workspace- or self-bound operation.
// The resolver runs before authorization, so the binding is always applied to
// a target the server derived.
func RequireTarget(authorizer Authorizer, op Operation, resolve TargetResolver) func(http.Handler) http.Handler {
	return authorizeWith(op, func(ctx context.Context, token string, request *http.Request) (Verified, error) {
		target, err := resolve(request)
		if err != nil {
			return Verified{}, fmt.Errorf("%w: %w", errUnresolvedTarget, err)
		}
		return authorizer.Authorize(ctx, token, op, target)
	})
}

// errUnresolvedTarget separates "the route could not work out what is being
// acted on" from a credential failure, so an unresolvable target is a 400
// rather than a misleading 401.
var errUnresolvedTarget = errors.New("target could not be resolved")

func authorizeWith(_ Operation, decide func(context.Context, string, *http.Request) (Verified, error)) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			token, ok := bearerToken(request)
			if !ok {
				writeAuthError(writer, http.StatusUnauthorized, "capability_required", "a capability token is required")
				return
			}
			verified, err := decide(request.Context(), token, request)
			if err != nil {
				status, code := authErrorFor(err)
				writeAuthError(writer, status, code, http.StatusText(status))
				return
			}
			ctx := context.WithValue(request.Context(), verifiedContextKey{}, verified)
			ctx = context.WithValue(ctx, bearerContextKey{}, token)
			next.ServeHTTP(writer, request.WithContext(ctx))
		})
	}
}

// bearerToken extracts the credential. Only the Authorization header is
// accepted: a capability in a query string would land in proxy and access logs.
func bearerToken(request *http.Request) (string, bool) {
	header := strings.TrimSpace(request.Header.Get("Authorization"))
	if header == "" {
		return "", false
	}
	scheme, value, found := strings.Cut(header, " ")
	if !found || !strings.EqualFold(strings.TrimSpace(scheme), "bearer") {
		return "", false
	}
	value = strings.TrimSpace(value)
	if value == "" {
		return "", false
	}
	return value, true
}

func authErrorFor(err error) (int, string) {
	switch {
	case errors.Is(err, errUnresolvedTarget):
		return http.StatusBadRequest, "target_unresolved"
	case errors.Is(err, ErrNotPermitted):
		return http.StatusForbidden, "capability_forbidden"
	case errors.Is(err, ErrExpired):
		return http.StatusUnauthorized, "capability_expired"
	case errors.Is(err, ErrRevoked):
		return http.StatusUnauthorized, "capability_revoked"
	case errors.Is(err, ErrInvalidToken):
		return http.StatusUnauthorized, "capability_invalid"
	default:
		return http.StatusInternalServerError, "capability_unavailable"
	}
}

func writeAuthError(writer http.ResponseWriter, status int, code, message string) {
	writer.Header().Set("Content-Type", "application/json")
	if status == http.StatusUnauthorized {
		writer.Header().Set("WWW-Authenticate", `Bearer realm="ao-cloud-sandbox"`)
	}
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(map[string]any{
		"error": map[string]string{"code": code, "message": message},
	})
}
