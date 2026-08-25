package githubapp

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/cloud/internal/domain"
	"github.com/aoagents/agent-orchestrator/cloud/internal/secrets"
)

type remoteCapabilityStore struct {
	authorization domain.RemoteGitHubCheckoutContext
}

func (s remoteCapabilityStore) WorkerRemoteGitHubCheckoutContext(
	context.Context,
	string,
	string,
) (domain.RemoteGitHubCheckoutContext, error) {
	return s.authorization, nil
}

func TestRemoteCheckoutBrokerRedeemsEncryptedCapability(t *testing.T) {
	const capability = "opaque-capability-that-never-reaches-browser-js"
	authorization := domain.RemoteGitHubCheckoutContext{
		OrgID:                "org-1",
		SessionID:            "session-1",
		ProjectID:            "project-1",
		GitHubInstallationID: 7,
		GitHubRepositoryID:   9,
		UserExternalID:       "workos-user-1",
		TargetEnvironment:    "staging",
		RepositoryURL:        "https://github.com/acme/private",
	}
	cipher, err := secrets.New(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	authorization.CapabilityCiphertext, authorization.CapabilityNonce, err =
		cipher.Encrypt(
			[]byte(capability),
			RepositoryCapabilityAssociatedData(authorization),
		)
	if err != nil {
		t.Fatal(err)
	}
	expiresAt := time.Now().UTC().Add(30 * time.Minute)
	server := httptest.NewTLSServer(http.HandlerFunc(func(
		w http.ResponseWriter,
		r *http.Request,
	) {
		if r.URL.Path != "/api/cloud/v1/control/github/capabilities/redeem" ||
			r.Header.Get("Authorization") != "Bearer "+strings.Repeat("b", 40) ||
			r.Header.Get("X-AO-Target-Environment") != "staging" {
			http.Error(w, "unexpected request", http.StatusBadRequest)
			return
		}
		var input capabilityRequestForTest
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			http.Error(w, "invalid JSON", http.StatusBadRequest)
			return
		}
		if input.Capability != capability ||
			input.GitHubInstallationID != "7" ||
			input.GitHubRepositoryID != "9" ||
			input.UserExternalID != "workos-user-1" {
			http.Error(w, "authority mismatch", http.StatusForbidden)
			return
		}
		_ = json.NewEncoder(w).Encode(CheckoutGrant{
			CloneURL:  "https://github.com/acme/private.git",
			Token:     "short-lived-installation-token",
			ExpiresAt: expiresAt,
		})
	}))
	defer server.Close()

	broker, err := NewRemoteCheckoutBroker(
		remoteCapabilityStore{authorization: authorization},
		cipher,
		server.URL,
		"staging",
		strings.Repeat("b", 40),
		server.Client(),
	)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := broker.IssueCheckoutGrant(
		context.Background(),
		"org-1",
		"session-1",
	)
	if err != nil {
		t.Fatal(err)
	}
	if grant.Token != "short-lived-installation-token" ||
		grant.CloneURL != "https://github.com/acme/private.git" ||
		!grant.ExpiresAt.Equal(expiresAt) {
		t.Fatalf("grant = %#v", grant)
	}
}

func TestRemoteCheckoutBrokerFailsClosedOnRejectedCapability(t *testing.T) {
	authorization := domain.RemoteGitHubCheckoutContext{
		OrgID:                "org-1",
		SessionID:            "session-1",
		ProjectID:            "project-1",
		GitHubInstallationID: 7,
		GitHubRepositoryID:   9,
		UserExternalID:       "workos-user-1",
		TargetEnvironment:    "staging",
		RepositoryURL:        "https://github.com/acme/private",
	}
	cipher, _ := secrets.New(make([]byte, 32))
	authorization.CapabilityCiphertext, authorization.CapabilityNonce, _ =
		cipher.Encrypt(
			[]byte("revoked-capability"),
			RepositoryCapabilityAssociatedData(authorization),
		)
	server := httptest.NewTLSServer(http.HandlerFunc(func(
		w http.ResponseWriter,
		_ *http.Request,
	) {
		http.Error(w, "revoked", http.StatusForbidden)
	}))
	defer server.Close()
	broker, err := NewRemoteCheckoutBroker(
		remoteCapabilityStore{authorization: authorization},
		cipher,
		server.URL,
		"staging",
		strings.Repeat("b", 40),
		server.Client(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := broker.IssueCheckoutGrant(
		context.Background(),
		"org-1",
		"session-1",
	); err == nil {
		t.Fatal("IssueCheckoutGrant succeeded for a rejected capability")
	}
}

type capabilityRequestForTest struct {
	Capability           string `json:"capability"`
	GitHubInstallationID string `json:"githubInstallationId"`
	GitHubRepositoryID   string `json:"githubRepositoryId"`
	UserExternalID       string `json:"userExternalId"`
}
