package scm

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	scmgithub "github.com/aoagents/agent-orchestrator/backend/internal/adapters/scm/github"
	"github.com/aoagents/agent-orchestrator/backend/internal/observe/scm"
)

// The hosted provider must remain usable by the shared observer. If the
// observer's contract changes, this fails to compile rather than at runtime.
var _ scm.Provider = (*ObservationProvider)(nil)

func TestInstallationTokenSourceBrokersAndCaches(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryBrokerStore()
	store.allow("org-1", "acme/widgets", 55, 900)
	broker := newTestBroker(t, fake, store)

	source, err := NewInstallationTokenSource(broker, BrokerRequest{
		OrgID: "org-1", UserID: "user-1", Repository: "Acme/Widgets",
	})
	if err != nil {
		t.Fatal(err)
	}
	first, err := source.Token(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := source.Token(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if first != second || len(fake.minted()) != 1 {
		t.Fatal("a live credential was re-minted for every call")
	}
	// The default purpose is read-only observation.
	if permissions := fake.minted()[0].Permissions; permissions["contents"] != "read" {
		t.Fatalf("observe permissions = %#v", permissions)
	}

	source.InvalidateToken()
	third, err := source.Token(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if third == first || len(fake.minted()) != 2 {
		t.Fatal("invalidation did not force a re-broker")
	}
}

func TestInstallationTokenSourceSurfacesAllowlistDenial(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryBrokerStore()
	broker := newTestBroker(t, fake, store)

	source, err := NewInstallationTokenSource(broker, BrokerRequest{
		OrgID: "org-1", UserID: "user-1", Repository: "acme/widgets",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := source.Token(context.Background()); !errors.Is(err, ErrRepositoryNotAllowed) {
		t.Fatalf("error = %v", err)
	}
}

func TestObservationProviderAttributesToTheAppBot(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryBrokerStore()
	store.allow("org-1", "acme/widgets", 55, 900)
	broker := newTestBroker(t, fake, store)

	provider, err := NewObservationProvider(ObservationProviderOptions{
		Broker:  broker,
		Request: BrokerRequest{OrgID: "org-1", UserID: "user-1", Repository: "acme/widgets"},
	})
	if err != nil {
		t.Fatal(err)
	}
	identity, err := provider.AuthenticatedIdentity(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	// An installation token cannot read /user, so identity must come from the
	// app slug. Attribution logic compares comment authors against this.
	if identity.Login != "ao-cloud[bot]" || identity.Human {
		t.Fatalf("identity = %#v", identity)
	}
	if len(fake.minted()) != 0 {
		t.Fatal("resolving identity spent a credential")
	}

	scoped, err := provider.AuthenticatedIdentityForProvider(context.Background(), "GitHub", "github.com")
	if err != nil || scoped.Login != identity.Login {
		t.Fatalf("scoped identity = %#v, %v", scoped, err)
	}
	if _, err := provider.AuthenticatedIdentityForProvider(context.Background(), "gitlab", "gitlab.com"); err == nil {
		t.Fatal("the GitHub provider answered for GitLab")
	}
}

// TestObservationProviderSendsBrokeredCredential proves the hosted path reuses
// the ordinary GitHub adapter: the request that reaches the API carries the
// brokered installation token as its bearer.
func TestObservationProviderSendsBrokeredCredential(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryBrokerStore()
	store.allow("org-1", "acme/widgets", 55, 900)
	broker := newTestBroker(t, fake, store)

	var mu sync.Mutex
	var seen []string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Header.Get("Authorization"))
		mu.Unlock()
		writeTestJSON(w, http.StatusOK, []map[string]any{})
	}))
	t.Cleanup(api.Close)

	provider, err := NewObservationProvider(ObservationProviderOptions{
		Broker:   broker,
		Request:  BrokerRequest{OrgID: "org-1", UserID: "user-1", Repository: "acme/widgets"},
		RESTBase: api.URL,
	})
	if err != nil {
		t.Fatal(err)
	}
	repository, ok := provider.ParseRepository("https://github.com/acme/widgets")
	if !ok {
		t.Fatal("the adapter could not parse its own repository URL")
	}
	if _, err := provider.RepoPRListGuard(context.Background(), repository, ""); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(seen) == 0 {
		t.Fatal("the provider made no request")
	}
	if !strings.Contains(seen[0], "ghs_installation_token_") {
		t.Fatalf("authorization = %q", seen[0])
	}
	if len(fake.minted()) != 1 {
		t.Fatalf("minted %d credentials", len(fake.minted()))
	}
}

func TestNewObservationProviderRequiresABroker(t *testing.T) {
	if _, err := NewObservationProvider(ObservationProviderOptions{}); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("error = %v", err)
	}
}

// The adapter's own contract must keep accepting our token source, including
// the cache-invalidation capability it uses on auth failures.
func TestInstallationTokenSourceSatisfiesTheAdapterContract(t *testing.T) {
	var source any = &InstallationTokenSource{}
	if _, ok := source.(scmgithub.TokenSource); !ok {
		t.Fatal("InstallationTokenSource is no longer a github.TokenSource")
	}
	if _, ok := source.(interface{ InvalidateToken() }); !ok {
		t.Fatal("InstallationTokenSource lost its invalidation capability")
	}
}
