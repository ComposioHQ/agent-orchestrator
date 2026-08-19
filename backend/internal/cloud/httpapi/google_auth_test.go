package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
)

type staticGoogleVerifier struct {
	principal domain.Principal
	err       error
	token     string
}

func (v *staticGoogleVerifier) Verify(_ context.Context, token string) (domain.Principal, error) {
	v.token = token
	return v.principal, v.err
}

type authEndpointStore struct {
	Store
	mu          sync.Mutex
	principal   domain.Principal
	memberships []domain.Membership
	refreshes   map[string]string
}

func (s *authEndpointStore) UpsertGoogleUser(
	_ context.Context,
	principal domain.Principal,
) (domain.Principal, error) {
	principal.UserID = s.principal.UserID
	s.principal = principal
	return principal, nil
}

func (s *authEndpointStore) PrincipalByID(
	_ context.Context,
	userID string,
) (domain.Principal, error) {
	if userID != s.principal.UserID {
		return domain.Principal{}, postgres.ErrNotFound
	}
	return s.principal, nil
}

func (s *authEndpointStore) CreateRefreshSession(
	_ context.Context,
	userID string,
	tokenHash []byte,
	_ time.Time,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.refreshes[string(tokenHash)] = userID
	return nil
}

func (s *authEndpointStore) RotateRefreshSession(
	_ context.Context,
	oldHash []byte,
	newHash []byte,
	_ time.Time,
) (domain.Principal, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	userID, ok := s.refreshes[string(oldHash)]
	if !ok {
		return domain.Principal{}, postgres.ErrNotFound
	}
	delete(s.refreshes, string(oldHash))
	s.refreshes[string(newHash)] = userID
	return s.principal, nil
}

func (s *authEndpointStore) RevokeRefreshSession(_ context.Context, hash []byte) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.refreshes, string(hash))
	return nil
}

func (s *authEndpointStore) ListMemberships(
	context.Context,
	domain.Principal,
) ([]domain.Membership, error) {
	return s.memberships, nil
}

func TestGoogleExchangeIssuesAOAccessAndRotatingRefreshTokens(t *testing.T) {
	principal := domain.Principal{
		UserID:      "58fc7182-0360-412f-abd9-5057097db664",
		Provider:    "google",
		ExternalID:  "google-subject",
		Email:       "person@example.com",
		DisplayName: "Person Example",
	}
	store := &authEndpointStore{
		principal: principal,
		memberships: []domain.Membership{{
			OrgID: "org-id", OrgSlug: "personal", DisplayName: "Personal", Role: "owner",
		}},
		refreshes: make(map[string]string),
	}
	google := &staticGoogleVerifier{principal: principal}
	tokens, err := auth.NewAccessTokenManager(
		[]byte("0123456789abcdef0123456789abcdef"),
		"ao-cloud-test",
		"ao-desktop-test",
		15*time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	server := New(Options{
		Store: store, Google: google, AccessTokens: tokens, RefreshTokenTTL: time.Hour,
	})

	exchange := httptest.NewRequest(
		http.MethodPost,
		"/api/cloud/v1/auth/google",
		bytes.NewBufferString(`{"idToken":"google-id-token"}`),
	)
	exchange.Header.Set("Content-Type", "application/json")
	exchangeResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(exchangeResponse, exchange)
	if exchangeResponse.Code != http.StatusOK {
		t.Fatalf("exchange status = %d: %s", exchangeResponse.Code, exchangeResponse.Body.String())
	}
	if exchangeResponse.Header().Get("Cache-Control") != "no-store" || google.token != "google-id-token" {
		t.Fatalf("cache control = %q, verified token = %q", exchangeResponse.Header().Get("Cache-Control"), google.token)
	}
	var issued aoAuthResponse
	if err := json.Unmarshal(exchangeResponse.Body.Bytes(), &issued); err != nil {
		t.Fatal(err)
	}
	if !auth.IsAccessToken(issued.AccessToken) || issued.RefreshToken == "" ||
		issued.User.Provider != "google" || len(issued.Organizations) != 1 {
		t.Fatalf("issued auth = %#v", issued)
	}

	me := httptest.NewRequest(http.MethodGet, "/api/cloud/v1/me", nil)
	me.Header.Set("Authorization", "Bearer "+issued.AccessToken)
	meResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(meResponse, me)
	if meResponse.Code != http.StatusOK {
		t.Fatalf("me status = %d: %s", meResponse.Code, meResponse.Body.String())
	}

	body, _ := json.Marshal(refreshTokenRequest{RefreshToken: issued.RefreshToken})
	firstRefresh := httptest.NewRequest(http.MethodPost, "/api/cloud/v1/auth/refresh", bytes.NewReader(body))
	firstRefresh.Header.Set("Content-Type", "application/json")
	firstResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(firstResponse, firstRefresh)
	if firstResponse.Code != http.StatusOK {
		t.Fatalf("first refresh status = %d: %s", firstResponse.Code, firstResponse.Body.String())
	}
	var rotated aoAuthResponse
	if err := json.Unmarshal(firstResponse.Body.Bytes(), &rotated); err != nil {
		t.Fatal(err)
	}
	if rotated.RefreshToken == issued.RefreshToken || rotated.RefreshToken == "" {
		t.Fatal("refresh token was not rotated")
	}

	replay := httptest.NewRequest(http.MethodPost, "/api/cloud/v1/auth/refresh", bytes.NewReader(body))
	replay.Header.Set("Content-Type", "application/json")
	replayResponse := httptest.NewRecorder()
	server.Handler().ServeHTTP(replayResponse, replay)
	if replayResponse.Code != http.StatusUnauthorized {
		t.Fatalf("refresh replay status = %d: %s", replayResponse.Code, replayResponse.Body.String())
	}
}

func TestGoogleExchangeRejectsUnverifiedIdentity(t *testing.T) {
	server := New(Options{
		Store:  &authEndpointStore{refreshes: make(map[string]string)},
		Google: &staticGoogleVerifier{err: auth.ErrInvalidToken},
		AccessTokens: func() *auth.AccessTokenManager {
			manager, _ := auth.NewAccessTokenManager(
				[]byte("0123456789abcdef0123456789abcdef"), "issuer", "audience", time.Minute,
			)
			return manager
		}(),
	})
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/cloud/v1/auth/google",
		bytes.NewBufferString(`{"idToken":"forged"}`),
	)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d: %s", response.Code, response.Body.String())
	}
}
