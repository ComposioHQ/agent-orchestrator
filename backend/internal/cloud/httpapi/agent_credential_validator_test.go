package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClaudeCredentialValidatorRejectsUnauthorizedAPIKey(t *testing.T) {
	validator := testAgentCredentialValidator(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "invalid-key" {
			t.Fatalf("x-api-key = %q", r.Header.Get("x-api-key"))
		}
		w.WriteHeader(http.StatusUnauthorized)
	})

	err := validator.Validate(
		context.Background(),
		"claude-code",
		"api_key",
		[]byte("invalid-key"),
	)
	if !errors.Is(err, errInvalidAgentCredential) {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestClaudeCredentialValidatorAcceptsAuthenticatedBadRequest(t *testing.T) {
	validator := testAgentCredentialValidator(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "valid-key" {
			t.Fatalf("x-api-key = %q", r.Header.Get("x-api-key"))
		}
		w.WriteHeader(http.StatusBadRequest)
	})

	if err := validator.Validate(
		context.Background(),
		"claude-code",
		"api_key",
		[]byte("valid-key"),
	); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestClaudeCredentialValidatorAcceptsSetupToken(t *testing.T) {
	token := "sk-ant-oat01-" + strings.Repeat("a", 90)
	validator := testAgentCredentialValidator(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer "+token {
			t.Fatalf("Authorization = %q", got)
		}
		if got := r.Header.Get("x-app"); got != "cli" {
			t.Fatalf("x-app = %q", got)
		}
		w.WriteHeader(http.StatusBadRequest)
	})

	if err := validator.Validate(
		context.Background(),
		"claude-code",
		"oauth_token",
		[]byte(token),
	); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestAgentCredentialValidatorValidatesBearerProviders(t *testing.T) {
	validator := testAgentCredentialValidator(t, func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer valid-key" {
			t.Fatalf("Authorization = %q", got)
		}
		w.WriteHeader(http.StatusOK)
	})

	for _, test := range []struct {
		provider       string
		credentialType string
	}{
		{provider: "codex", credentialType: "api_key"},
		{provider: "codex", credentialType: "access_token"},
		{provider: "cursor", credentialType: "api_key"},
	} {
		if err := validator.Validate(
			context.Background(),
			test.provider,
			test.credentialType,
			[]byte("valid-key"),
		); err != nil {
			t.Fatalf("Validate(%s, %s) error = %v", test.provider, test.credentialType, err)
		}
	}
}

func TestNormalizeAgentCredentialSecretRemovesWrappedWhitespace(t *testing.T) {
	got := string(normalizeAgentCredentialSecret(" sk-ant-oat01-first\n second\t"))
	if got != "sk-ant-oat01-firstsecond" {
		t.Fatalf("normalized secret = %q", got)
	}
}

func testAgentCredentialValidator(
	t *testing.T,
	handler http.HandlerFunc,
) *agentCredentialValidator {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	validator := newAgentCredentialValidator(server.Client())
	validator.anthropicBaseURL = server.URL
	validator.openAIBaseURL = server.URL
	validator.cursorBaseURL = server.URL
	return validator
}
