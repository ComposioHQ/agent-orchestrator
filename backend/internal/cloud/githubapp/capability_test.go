package githubapp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// shrinkRepositoryVisibilityDelay lets a test exercise the retry loop without
// actually sleeping through it.
func shrinkRepositoryVisibilityDelay(t *testing.T) {
	t.Helper()
	original := repositoryVisibilityDelay
	repositoryVisibilityDelay = time.Millisecond
	t.Cleanup(func() { repositoryVisibilityDelay = original })
}

// installationTokenRoute answers the app-level installation-token exchange
// every Client.ListRepositories call makes before it can list anything.
func installationTokenRoute(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != "/app/installations/7/access_tokens" {
		return false
	}
	_, _ = w.Write([]byte(`{"token":"installation-token","expires_at":"2030-01-01T00:00:00Z"}`))
	return true
}

func TestWaitForRepositoryVisibleSucceedsOnceGitHubCatchesUp(t *testing.T) {
	shrinkRepositoryVisibilityDelay(t)
	var calls int
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if installationTokenRoute(w, r) {
			return
		}
		if r.URL.Path != "/installation/repositories" {
			http.NotFound(w, r)
			return
		}
		calls++
		if calls < 3 {
			_, _ = w.Write([]byte(`{"repositories":[]}`))
			return
		}
		_, _ = w.Write([]byte(`{"repositories":[{
			"id":9,
			"name":"my-project",
			"full_name":"acme/my-project",
			"owner":{"id":8,"login":"acme","type":"Organization"}
		}]}`))
	}))
	defer github.Close()

	service := &Service{client: testClient(t, github.URL)}

	if err := service.waitForRepositoryVisible(context.Background(), 7, 9); err != nil {
		t.Fatalf("waitForRepositoryVisible() error = %v, want nil once the repository becomes visible", err)
	}
	if calls < 3 {
		t.Errorf("calls = %d, want at least 3 — the repository only appears on the 3rd listing", calls)
	}
}

func TestWaitForRepositoryVisibleGivesUpAfterTheBudget(t *testing.T) {
	shrinkRepositoryVisibilityDelay(t)
	var calls int
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if installationTokenRoute(w, r) {
			return
		}
		calls++
		_, _ = w.Write([]byte(`{"repositories":[]}`))
	}))
	defer github.Close()

	service := &Service{client: testClient(t, github.URL)}

	if err := service.waitForRepositoryVisible(context.Background(), 7, 9); err == nil {
		t.Fatal("waitForRepositoryVisible() error = nil, want an error when the repository never appears")
	}
	if calls != repositoryVisibilityAttempts {
		t.Errorf("calls = %d, want exactly %d — the full retry budget", calls, repositoryVisibilityAttempts)
	}
}

func TestWaitForRepositoryVisibleIgnoresARepositoryWithADifferentID(t *testing.T) {
	shrinkRepositoryVisibilityDelay(t)
	github := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if installationTokenRoute(w, r) {
			return
		}
		_, _ = w.Write([]byte(`{"repositories":[{
			"id":123,
			"name":"someone-elses-repo",
			"full_name":"acme/someone-elses-repo",
			"owner":{"id":8,"login":"acme","type":"Organization"}
		}]}`))
	}))
	defer github.Close()

	service := &Service{client: testClient(t, github.URL)}

	if err := service.waitForRepositoryVisible(context.Background(), 7, 9); err == nil {
		t.Fatal("waitForRepositoryVisible() error = nil, want an error: repository 9 is never in the listing")
	}
}
