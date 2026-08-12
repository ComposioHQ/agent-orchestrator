package githubapp

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/Untrivial-ai/ao-cloud/internal/postgres"
)

func TestCompletionHTMLUsesBrandedSuccessPage(t *testing.T) {
	t.Parallel()
	html := string((&Service{}).CompletionHTML(true))
	for _, expected := range []string{
		"Agent Orchestrator",
		"https://aoagents.dev/ao-logo.svg",
		"GitHub connected",
		"Close window",
		"window.close()",
	} {
		if !strings.Contains(html, expected) {
			t.Fatalf("completion page does not contain %q", expected)
		}
	}
}

func TestCompletionHTMLUsesFailureStateWithoutAutoClose(t *testing.T) {
	t.Parallel()
	html := string((&Service{}).CompletionHTML(false))
	if !strings.Contains(html, "Connection failed") {
		t.Fatal("failure page does not contain its heading")
	}
	if strings.Contains(html, "window.setTimeout") {
		t.Fatal("failure page closes before the user can read it")
	}
}

type checkoutContextStore struct {
	Store
	authorization domain.GitHubCheckoutContext
}

func (s checkoutContextStore) WorkerGitHubCheckoutContext(
	context.Context, string, string,
) (domain.GitHubCheckoutContext, error) {
	return s.authorization, nil
}

func TestIssueCheckoutGrantScopesTokenAfterAuthorization(t *testing.T) {
	const token = "short-lived-installation-secret"
	var body map[string]any
	var requests int
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"token": token, "expires_at": time.Now().UTC().Add(time.Hour),
		})
	}))
	defer github.Close()
	var logs bytes.Buffer
	service, err := NewService(
		checkoutContextStore{authorization: domain.GitHubCheckoutContext{
			OrgID: "org", SessionID: "session", ProjectID: "project",
			GitHubInstallationID: 123, GitHubRepositoryID: 456,
			FullName: "acme/api", CloneURL: "https://github.com/acme/api.git",
		}},
		testClient(t, github.URL), make([]byte, 32), "webhook-secret",
		time.Minute, slog.New(slog.NewJSONHandler(&logs, nil)),
	)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := service.IssueCheckoutGrant(context.Background(), "org", "session")
	if err != nil {
		t.Fatal(err)
	}
	ids, idsOK := body["repository_ids"].([]any)
	permissions, permissionsOK := body["permissions"].(map[string]any)
	if grant.Token != token || grant.CloneURL != "https://github.com/acme/api.git" ||
		!idsOK || len(ids) != 1 || ids[0] != float64(456) ||
		!permissionsOK || permissions["contents"] != "read" ||
		requests != 1 {
		t.Fatalf("grant = %#v, request = %#v", grant, body)
	}
	if strings.Contains(logs.String(), token) {
		t.Fatal("installation token entered service logs")
	}
}

func TestIssueCheckoutGrantRejectsIdentityMismatchBeforeIssuance(t *testing.T) {
	var requests int
	github := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		requests++
	}))
	defer github.Close()
	service, err := NewService(
		checkoutContextStore{authorization: domain.GitHubCheckoutContext{
			OrgID: "org", SessionID: "session", ProjectID: "project",
			GitHubInstallationID: 123, GitHubRepositoryID: 456,
			FullName: "acme/api", CloneURL: "https://github.com/other/repo.git",
		}},
		testClient(t, github.URL), make([]byte, 32), "webhook-secret", time.Minute, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.IssueCheckoutGrant(context.Background(), "org", "session"); err != postgres.ErrForbidden {
		t.Fatalf("error = %v, want forbidden", err)
	}
	if requests != 0 {
		t.Fatalf("GitHub token requests = %d, want 0", requests)
	}
}
