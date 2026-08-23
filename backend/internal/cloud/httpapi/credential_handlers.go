package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/credentials"
)

type putAgentProviderConnectionInput struct {
	CredentialType string `json:"credentialType"`
	Secret         string `json:"secret"`
}

type providerPublicConfig struct {
	CredentialType string `json:"credentialType"`
}

type redactedProviderConnection struct {
	ID              string               `json:"id"`
	Provider        string               `json:"provider"`
	Label           string               `json:"label"`
	Config          providerPublicConfig `json:"config"`
	ValidationState string               `json:"validationState"`
	ValidatedAt     time.Time            `json:"validatedAt"`
	CreatedAt       time.Time            `json:"createdAt"`
	UpdatedAt       time.Time            `json:"updatedAt"`
}

// requirePathTenant reuses the one membership resolver and tenant identity.
// The OpenAPI orgId path is authoritative for these cloud-only routes.
func (s *Server) requirePathTenant(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		orgID := strings.TrimSpace(chi.URLParam(r, "orgId"))
		if orgID == "" {
			writeError(w, r, http.StatusBadRequest, "bad_request", "ORG_REQUIRED", "organization is required")
			return
		}
		request := r.Clone(r.Context())
		request.Header = r.Header.Clone()
		request.Header.Set(orgHeader, orgID)
		s.requireTenant(next).ServeHTTP(w, request)
	})
}

func (s *Server) listProviderConnections(w http.ResponseWriter, r *http.Request) {
	items, err := s.credentials.List(r.Context())
	if err != nil {
		s.credentialError(w, r, "list provider connections", err)
		return
	}
	connections := make([]redactedProviderConnection, 0, len(items))
	for _, item := range items {
		connections = append(connections, redactedConnection(item))
	}
	writeJSON(w, http.StatusOK, map[string]any{"providerConnections": connections})
}

func (s *Server) putAgentProviderConnection(w http.ResponseWriter, r *http.Request) {
	provider := strings.TrimSpace(chi.URLParam(r, "provider"))
	var input putAgentProviderConnectionInput
	if !decodeJSON(w, r, &input) {
		return
	}
	secret := []byte(input.Secret)
	defer credentials.Erase(secret)
	item, err := s.credentials.Put(r.Context(), provider, strings.TrimSpace(input.CredentialType), secret)
	if err != nil {
		s.credentialError(w, r, "put provider connection", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"providerConnection": redactedConnection(item)})
}

func (s *Server) deleteAgentProviderConnection(w http.ResponseWriter, r *http.Request) {
	provider := strings.TrimSpace(chi.URLParam(r, "provider"))
	if err := s.credentials.Delete(r.Context(), provider); err != nil {
		s.credentialError(w, r, "delete provider connection", err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) credentialError(w http.ResponseWriter, r *http.Request, operation string, err error) {
	switch {
	case errors.Is(err, credentials.ErrInvalid):
		writeError(w, r, http.StatusUnprocessableEntity, "validation_error", "INVALID_CREDENTIAL", "credential is invalid or unsupported")
	case errors.Is(err, credentials.ErrNotFound):
		writeError(w, r, http.StatusNotFound, "not_found", "CREDENTIAL_NOT_FOUND", "credential not found")
	default:
		s.internalError(w, r, operation, err)
	}
}

func redactedConnection(item credentials.Metadata) redactedProviderConnection {
	label := item.Provider
	if item.Provider == credentials.ProviderClaudeCode {
		label = "Claude Code"
	}
	return redactedProviderConnection{
		ID: item.ID, Provider: item.Provider, Label: label,
		Config:          providerPublicConfig{CredentialType: item.CredentialType},
		ValidationState: "valid", ValidatedAt: item.UpdatedAt,
		CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt,
	}
}
