package httpapi

import (
	"errors"
	"net/http"
	"net/mail"
	"regexp"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
)

var orgSlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,62}$`)

const maxLocalPasswordBytes = 72

type localRegisterRequest struct {
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
	Password    string `json:"password"`
	OrgSlug     string `json:"orgSlug"`
	OrgName     string `json:"orgName"`
}

type localLoginRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type userResponse struct {
	ID          string `json:"id"`
	Email       string `json:"email"`
	DisplayName string `json:"displayName"`
	Provider    string `json:"authProvider"`
}

type organizationResponse struct {
	ID          string `json:"id"`
	Slug        string `json:"slug"`
	DisplayName string `json:"displayName"`
	Role        string `json:"role"`
}

type authResponse struct {
	Token         string                 `json:"token"`
	ExpiresAt     time.Time              `json:"expiresAt"`
	User          userResponse           `json:"user"`
	Organizations []organizationResponse `json:"organizations"`
}

type aoAuthResponse struct {
	AccessToken   string                 `json:"accessToken"`
	RefreshToken  string                 `json:"refreshToken"`
	ExpiresAt     time.Time              `json:"expiresAt"`
	User          userResponse           `json:"user"`
	Organizations []organizationResponse `json:"organizations"`
}

type refreshTokenRequest struct {
	RefreshToken string `json:"refreshToken"`
}

func (s *Server) exchangeGoogleIdentity(w http.ResponseWriter, r *http.Request) {
	if s.google == nil || s.accessTokens == nil {
		writeError(w, r, http.StatusServiceUnavailable, "authentication_unavailable", "Google authentication is not configured.")
		return
	}
	if !s.allowLocalAuthAttempt(w, r) {
		return
	}
	var request struct {
		IDToken string `json:"idToken"`
	}
	if err := decodeJSON(w, r, &request); err != nil ||
		len(strings.TrimSpace(request.IDToken)) == 0 || len(request.IDToken) > 64<<10 {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "A Google ID token is required.")
		return
	}
	principal, err := s.google.Verify(r.Context(), request.IDToken)
	if err != nil {
		if errors.Is(err, auth.ErrInvalidToken) {
			writeError(w, r, http.StatusUnauthorized, "unauthorized", "The Google identity token is invalid or expired.")
			return
		}
		s.logger.Error("verify Google identity", "error", err, "request_id", requestID(r))
		writeError(w, r, http.StatusServiceUnavailable, "authentication_unavailable", "Google authentication is temporarily unavailable.")
		return
	}
	principal, err = s.store.UpsertGoogleUser(r.Context(), principal)
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	s.issueAOAuth(w, r, principal, nil)
}

func (s *Server) refreshAOAccess(w http.ResponseWriter, r *http.Request) {
	if s.accessTokens == nil {
		writeError(w, r, http.StatusServiceUnavailable, "authentication_unavailable", "AO authentication is not configured.")
		return
	}
	if !s.allowLocalAuthAttempt(w, r) {
		return
	}
	var request refreshTokenRequest
	if err := decodeJSON(w, r, &request); err != nil ||
		!strings.HasPrefix(request.RefreshToken, "ao_refresh_") {
		writeError(w, r, http.StatusUnauthorized, "unauthorized", "The refresh token is invalid or expired.")
		return
	}
	newToken, newHash, err := auth.NewRefreshToken()
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	principal, err := s.store.RotateRefreshSession(
		r.Context(),
		auth.HashToken(request.RefreshToken),
		newHash,
		time.Now().UTC().Add(s.refreshTokenTTL),
	)
	if err != nil {
		if errors.Is(err, postgres.ErrNotFound) {
			writeError(w, r, http.StatusUnauthorized, "unauthorized", "The refresh token is invalid or expired.")
			return
		}
		s.writeStoreError(w, r, err)
		return
	}
	s.issueAOAuth(w, r, principal, &newToken)
}

func (s *Server) logoutAO(w http.ResponseWriter, r *http.Request) {
	var request refreshTokenRequest
	if err := decodeJSON(w, r, &request); err != nil ||
		!strings.HasPrefix(request.RefreshToken, "ao_refresh_") {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "A refresh token is required.")
		return
	}
	if err := s.store.RevokeRefreshSession(r.Context(), auth.HashToken(request.RefreshToken)); err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) issueAOAuth(
	w http.ResponseWriter,
	r *http.Request,
	principal domain.Principal,
	rotatedRefreshToken *string,
) {
	accessToken, expiresAt, err := s.accessTokens.Issue(principal.UserID)
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	var refreshToken string
	if rotatedRefreshToken != nil {
		refreshToken = *rotatedRefreshToken
	} else {
		var refreshHash []byte
		refreshToken, refreshHash, err = auth.NewRefreshToken()
		if err != nil {
			s.writeStoreError(w, r, err)
			return
		}
		if err := s.store.CreateRefreshSession(
			r.Context(),
			principal.UserID,
			refreshHash,
			time.Now().UTC().Add(s.refreshTokenTTL),
		); err != nil {
			s.writeStoreError(w, r, err)
			return
		}
	}
	memberships, err := s.store.ListMemberships(r.Context(), principal)
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, aoAuthResponse{
		AccessToken:   accessToken,
		RefreshToken:  refreshToken,
		ExpiresAt:     expiresAt,
		User:          toUserResponse(principal),
		Organizations: toOrganizations(memberships),
	})
}

func (s *Server) registerLocal(w http.ResponseWriter, r *http.Request) {
	if !s.localAuthEnabled {
		writeError(w, r, http.StatusNotFound, "not_found", "Local authentication is disabled.")
		return
	}
	if !s.allowLocalAuthAttempt(w, r) {
		return
	}
	var request localRegisterRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "The request body is invalid.")
		return
	}
	request.Email = strings.ToLower(strings.TrimSpace(request.Email))
	request.DisplayName = strings.TrimSpace(request.DisplayName)
	request.OrgSlug = strings.ToLower(strings.TrimSpace(request.OrgSlug))
	request.OrgName = strings.TrimSpace(request.OrgName)
	if !validEmail(request.Email) ||
		len(request.DisplayName) < 1 || len(request.DisplayName) > 120 ||
		len(request.Password) < 12 || len(request.Password) > maxLocalPasswordBytes ||
		!orgSlugPattern.MatchString(request.OrgSlug) ||
		len(request.OrgName) < 1 || len(request.OrgName) > 120 {
		writeError(w, r, http.StatusUnprocessableEntity, "validation_error", "Email, name, password, or organization details are invalid.")
		return
	}
	passwordHash, err := auth.HashPassword(request.Password)
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	token, tokenHash, err := auth.NewOpaqueToken()
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	expiresAt := time.Now().UTC().Add(s.localSessionTTL)
	principal, orgID, err := s.store.RegisterLocal(r.Context(), domain.LocalRegistration{
		Email:        request.Email,
		DisplayName:  request.DisplayName,
		PasswordHash: passwordHash,
		OrgSlug:      request.OrgSlug,
		OrgName:      request.OrgName,
	}, tokenHash, expiresAt)
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusCreated, authResponse{
		Token:     token,
		ExpiresAt: expiresAt,
		User:      toUserResponse(principal),
		Organizations: []organizationResponse{{
			ID:          orgID,
			Slug:        request.OrgSlug,
			DisplayName: request.OrgName,
			Role:        "owner",
		}},
	})
}

func (s *Server) loginLocal(w http.ResponseWriter, r *http.Request) {
	if !s.localAuthEnabled {
		writeError(w, r, http.StatusNotFound, "not_found", "Local authentication is disabled.")
		return
	}
	if !s.allowLocalAuthAttempt(w, r) {
		return
	}
	var request localLoginRequest
	if err := decodeJSON(w, r, &request); err != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "The request body is invalid.")
		return
	}
	if len(request.Password) > maxLocalPasswordBytes {
		writeError(w, r, http.StatusUnauthorized, "invalid_credentials", "The email or password is incorrect.")
		return
	}
	principal, passwordHash, err := s.store.LocalUserByEmail(r.Context(), request.Email)
	if err != nil && !errors.Is(err, postgres.ErrNotFound) {
		s.writeStoreError(w, r, err)
		return
	}
	if !auth.VerifyPassword(passwordHash, request.Password) || errors.Is(err, postgres.ErrNotFound) {
		writeError(w, r, http.StatusUnauthorized, "invalid_credentials", "The email or password is incorrect.")
		return
	}
	memberships, err := s.store.ListMemberships(r.Context(), principal)
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	token, tokenHash, err := auth.NewOpaqueToken()
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	expiresAt := time.Now().UTC().Add(s.localSessionTTL)
	if err := s.store.CreateLocalSession(r.Context(), principal.UserID, tokenHash, expiresAt); err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, authResponse{
		Token:         token,
		ExpiresAt:     expiresAt,
		User:          toUserResponse(principal),
		Organizations: toOrganizations(memberships),
	})
}

func (s *Server) logoutLocal(w http.ResponseWriter, r *http.Request) {
	token := bearerFrom(r)
	if !strings.HasPrefix(token, "ao_local_") {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "WorkOS sessions must be signed out through WorkOS.")
		return
	}
	if err := s.store.RevokeLocalSession(r.Context(), auth.HashToken(token)); err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	principal := principalFrom(r)
	memberships, err := s.store.ListMemberships(r.Context(), principal)
	if err != nil {
		s.writeStoreError(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user":          toUserResponse(principal),
		"organizations": toOrganizations(memberships),
	})
}

func toUserResponse(principal domain.Principal) userResponse {
	return userResponse{
		ID:          principal.UserID,
		Email:       principal.Email,
		DisplayName: principal.DisplayName,
		Provider:    principal.Provider,
	}
}

func toOrganizations(memberships []domain.Membership) []organizationResponse {
	organizations := make([]organizationResponse, 0, len(memberships))
	for _, membership := range memberships {
		organizations = append(organizations, organizationResponse{
			ID:          membership.OrgID,
			Slug:        membership.OrgSlug,
			DisplayName: membership.DisplayName,
			Role:        membership.Role,
		})
	}
	return organizations
}

func validEmail(value string) bool {
	address, err := mail.ParseAddress(value)
	return err == nil && strings.EqualFold(address.Address, value)
}

func (s *Server) allowLocalAuthAttempt(w http.ResponseWriter, r *http.Request) bool {
	if s.localAuthLimiter.allow(localAuthRateLimitKey(r), time.Now()) {
		return true
	}
	w.Header().Set("Retry-After", "60")
	writeError(w, r, http.StatusTooManyRequests, "rate_limited", "Too many authentication attempts.")
	return false
}
