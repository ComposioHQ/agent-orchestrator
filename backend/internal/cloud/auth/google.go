package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/coreos/go-oidc/v3/oidc"
)

const (
	GoogleIssuer  = "https://accounts.google.com"
	GoogleJWKSURL = "https://www.googleapis.com/oauth2/v3/certs"
)

// GoogleVerifier validates a Google OpenID Connect ID token. Google establishes
// identity only; AO organizations and memberships remain authoritative in
// PostgreSQL and are never inferred from the hosted-domain claim.
type GoogleVerifier struct {
	verifier  *oidc.IDTokenVerifier
	audiences map[string]struct{}
}

func NewGoogleVerifier(
	ctx context.Context,
	issuer string,
	jwksURL string,
	clientIDs []string,
) (*GoogleVerifier, error) {
	issuer = strings.TrimRight(strings.TrimSpace(issuer), "/")
	jwksURL = strings.TrimSpace(jwksURL)
	if issuer == "" || jwksURL == "" {
		return nil, errors.New("google issuer and JWKS URL are required")
	}
	audiences := make(map[string]struct{}, len(clientIDs))
	for _, clientID := range clientIDs {
		if clientID = strings.TrimSpace(clientID); clientID != "" {
			audiences[clientID] = struct{}{}
		}
	}
	if len(audiences) == 0 {
		return nil, errors.New("at least one Google client ID is required")
	}
	return &GoogleVerifier{
		verifier: oidc.NewVerifier(
			issuer,
			oidc.NewRemoteKeySet(ctx, jwksURL),
			&oidc.Config{SkipClientIDCheck: true},
		),
		audiences: audiences,
	}, nil
}

func (v *GoogleVerifier) Verify(ctx context.Context, token string) (domain.Principal, error) {
	idToken, err := v.verifier.Verify(ctx, strings.TrimSpace(token))
	if err != nil || !v.allowedAudience(idToken) {
		return domain.Principal{}, ErrInvalidToken
	}
	var claims struct {
		Subject       string          `json:"sub"`
		Email         string          `json:"email"`
		EmailVerified json.RawMessage `json:"email_verified"`
		Name          string          `json:"name"`
		AuthorizedID  string          `json:"azp"`
	}
	if err := idToken.Claims(&claims); err != nil ||
		strings.TrimSpace(claims.Subject) == "" ||
		strings.TrimSpace(claims.Email) == "" ||
		!googleEmailVerified(claims.EmailVerified) {
		return domain.Principal{}, ErrInvalidToken
	}
	if len(idToken.Audience) > 1 && strings.TrimSpace(claims.AuthorizedID) == "" {
		return domain.Principal{}, ErrInvalidToken
	}
	if claims.AuthorizedID != "" {
		if _, ok := v.audiences[strings.TrimSpace(claims.AuthorizedID)]; !ok {
			return domain.Principal{}, ErrInvalidToken
		}
	}
	email := strings.ToLower(strings.TrimSpace(claims.Email))
	displayName := strings.TrimSpace(claims.Name)
	if displayName == "" {
		displayName = email
	}
	return domain.Principal{
		Provider:    "google",
		ExternalID:  strings.TrimSpace(claims.Subject),
		Email:       email,
		DisplayName: displayName,
	}, nil
}

func (v *GoogleVerifier) allowedAudience(token *oidc.IDToken) bool {
	if token == nil {
		return false
	}
	for _, audience := range token.Audience {
		if _, ok := v.audiences[audience]; ok {
			return true
		}
	}
	return false
}

func googleEmailVerified(raw json.RawMessage) bool {
	raw = bytes.TrimSpace(raw)
	return bytes.Equal(raw, []byte("true"))
}
