package capability

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type verifiedContextKey struct{}

type bearerContextKey struct{}

// Verifier is the narrow interface an HTTP surface needs. *Authority satisfies
// it; tests substitute a stub.
type Verifier interface {
	Verify(ctx context.Context, token string, op Operation) (Verified, error)
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
// capability and authorizes exactly one operation.
//
// The operation is fixed per route rather than derived from the request body:
// a sandbox must not be able to widen its own authorization by naming a
// different operation in a payload. Handlers read the granted scope from the
// context and must ignore org/workspace/session ids sent in the body.
func Require(verifier Verifier, op Operation) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			token, ok := bearerToken(request)
			if !ok {
				writeAuthError(writer, http.StatusUnauthorized, "capability_required", "a capability token is required")
				return
			}
			verified, err := verifier.Verify(request.Context(), token, op)
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
