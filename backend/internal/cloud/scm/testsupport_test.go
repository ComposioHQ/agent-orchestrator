package scm

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
)

// Generating a 2048-bit key costs real time, so the suite shares one.
var (
	testKeyOnce sync.Once
	testKeyPEM  []byte
	testKey     *rsa.PrivateKey
)

func testPrivateKeyPEM(t *testing.T) []byte {
	t.Helper()
	testKeyOnce.Do(func() {
		key, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			panic(err)
		}
		testKey = key
		testKeyPEM = pem.EncodeToMemory(&pem.Block{
			Type:  "RSA PRIVATE KEY",
			Bytes: x509.MarshalPKCS1PrivateKey(key),
		})
	})
	return testKeyPEM
}

func testCredentials(t *testing.T) *AppCredentials {
	t.Helper()
	credentials, err := NewAppCredentials(4242, "ao-cloud", testPrivateKeyPEM(t))
	if err != nil {
		t.Fatal(err)
	}
	return credentials
}

// mintedTokenRequest records what the control plane asked GitHub to mint, so
// tests can assert that a credential was actually narrowed.
type mintedTokenRequest struct {
	InstallationID string
	RepositoryIDs  []int64           `json:"repository_ids"`
	Permissions    map[string]string `json:"permissions"`
	Authorization  string
}

// fakeGitHub is a minimal stand-in for the GitHub App API surface.
type fakeGitHub struct {
	mu sync.Mutex

	server *httptest.Server

	// Installation returns.
	accountLogin        string
	accountType         string
	repositorySelection string
	suspendedAt         string
	installationStatus  int

	// Token minting.
	tokenTTL      time.Duration
	tokenStatus   int
	mintedTokens  []mintedTokenRequest
	tokenSequence int

	// Repository listing.
	repositories []RepositoryRef

	// OAuth.
	oauthCode         string
	userInstallations []int64
}

func newFakeGitHub(t *testing.T) *fakeGitHub {
	t.Helper()
	fake := &fakeGitHub{
		accountLogin:        "acme",
		accountType:         "Organization",
		repositorySelection: "selected",
		tokenTTL:            time.Hour,
		installationStatus:  http.StatusOK,
		tokenStatus:         http.StatusCreated,
	}
	fake.server = httptest.NewServer(http.HandlerFunc(fake.serve))
	t.Cleanup(fake.server.Close)
	return fake
}

func (f *fakeGitHub) baseURL() string { return f.server.URL }

func (f *fakeGitHub) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	path := r.URL.Path
	switch {
	case r.Method == http.MethodPost && strings.HasSuffix(path, "/access_tokens"):
		f.serveAccessToken(w, r, path)
	case r.Method == http.MethodGet && strings.HasPrefix(path, "/app/installations/"):
		if f.installationStatus != http.StatusOK {
			w.WriteHeader(f.installationStatus)
			return
		}
		id := strings.TrimPrefix(path, "/app/installations/")
		writeTestJSON(w, http.StatusOK, map[string]any{
			"id":                   parseInt(id),
			"account":              map[string]any{"login": f.accountLogin, "type": f.accountType},
			"app_slug":             "ao-cloud",
			"repository_selection": f.repositorySelection,
			"suspended_at":         f.suspendedAt,
		})
	case r.Method == http.MethodGet && path == "/installation/repositories":
		repositories := make([]map[string]any, 0, len(f.repositories))
		for _, repository := range f.repositories {
			repositories = append(repositories, map[string]any{
				"id":        repository.ExternalID,
				"full_name": repository.FullName,
				"private":   repository.Private,
			})
		}
		writeTestJSON(w, http.StatusOK, map[string]any{
			"total_count":  len(repositories),
			"repositories": repositories,
		})
	case r.Method == http.MethodPost && path == "/login/oauth/access_token":
		if err := r.ParseForm(); err != nil || r.Form.Get("code") != f.oauthCode || f.oauthCode == "" {
			writeTestJSON(w, http.StatusOK, map[string]any{"error": "bad_verification_code"})
			return
		}
		writeTestJSON(w, http.StatusOK, map[string]any{"access_token": "gho_user_token"})
	case r.Method == http.MethodGet && path == "/user/installations":
		installations := make([]map[string]any, 0, len(f.userInstallations))
		for _, id := range f.userInstallations {
			installations = append(installations, map[string]any{"id": id})
		}
		writeTestJSON(w, http.StatusOK, map[string]any{"installations": installations})
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (f *fakeGitHub) serveAccessToken(w http.ResponseWriter, r *http.Request, path string) {
	if f.tokenStatus != http.StatusCreated {
		w.WriteHeader(f.tokenStatus)
		return
	}
	var body mintedTokenRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	body.InstallationID = strings.TrimSuffix(strings.TrimPrefix(path, "/app/installations/"), "/access_tokens")
	body.Authorization = r.Header.Get("Authorization")
	f.mintedTokens = append(f.mintedTokens, body)
	f.tokenSequence++
	writeTestJSON(w, http.StatusCreated, map[string]any{
		"token":      fmt.Sprintf("ghs_installation_token_%d", f.tokenSequence),
		"expires_at": time.Now().UTC().Add(f.tokenTTL).Format(time.RFC3339),
	})
}

func (f *fakeGitHub) minted() []mintedTokenRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]mintedTokenRequest(nil), f.mintedTokens...)
}

func writeTestJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func parseInt(value string) int64 {
	var parsed int64
	_, _ = fmt.Sscanf(value, "%d", &parsed)
	return parsed
}

// memoryBrokerStore is an in-memory allowlist for broker tests.
type memoryBrokerStore struct {
	mu            sync.Mutex
	installations map[string]domain.SCMInstallation
	repositories  map[string]domain.SCMRepository
	grants        []domain.SCMTokenGrant
	grantErr      error
	// tenants records the RLS scope every call ran under.
	tenants []postgres.Tenant
}

func newMemoryBrokerStore() *memoryBrokerStore {
	return &memoryBrokerStore{
		installations: map[string]domain.SCMInstallation{},
		repositories:  map[string]domain.SCMRepository{},
	}
}

// allow registers an allowlisted repository for one organization.
func (s *memoryBrokerStore) allow(orgID, fullName string, externalInstallationID, externalRepositoryID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	installationID := fmt.Sprintf("installation-%d", externalInstallationID)
	s.installations[installationID] = domain.SCMInstallation{
		ID:                     installationID,
		OrgID:                  orgID,
		Provider:               domain.SCMProviderGitHub,
		ExternalInstallationID: externalInstallationID,
		AccountLogin:           strings.Split(fullName, "/")[0],
		Status:                 domain.InstallationStatusActive,
	}
	s.repositories[orgID+"|"+fullName] = domain.SCMRepository{
		ID:                   "repository-" + fullName,
		InstallationID:       installationID,
		OrgID:                orgID,
		ExternalRepositoryID: externalRepositoryID,
		FullName:             fullName,
		Allowed:              true,
	}
}

func (s *memoryBrokerStore) setInstallationStatus(externalInstallationID int64, status string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := fmt.Sprintf("installation-%d", externalInstallationID)
	installation := s.installations[id]
	installation.Status = status
	s.installations[id] = installation
}

func (s *memoryBrokerStore) AllowedSCMRepository(
	_ context.Context,
	tenant postgres.Tenant,
	fullName string,
) (domain.SCMInstallation, domain.SCMRepository, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tenants = append(s.tenants, tenant)
	repository, ok := s.repositories[tenant.OrgID+"|"+fullName]
	if !ok || !repository.Allowed {
		return domain.SCMInstallation{}, domain.SCMRepository{}, postgres.ErrNotFound
	}
	return s.installations[repository.InstallationID], repository, nil
}

func (s *memoryBrokerStore) RecordSCMTokenGrant(
	_ context.Context,
	tenant postgres.Tenant,
	grant domain.SCMTokenGrant,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.grantErr != nil {
		return s.grantErr
	}
	grant.RequestedByUserID = tenant.UserID
	s.grants = append(s.grants, grant)
	return nil
}

func (s *memoryBrokerStore) grantCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.grants)
}

func newTestBroker(t *testing.T, fake *fakeGitHub, store BrokerStore) *Broker {
	t.Helper()
	app, err := NewAppClient(AppClientOptions{
		Credentials: testCredentials(t),
		APIBase:     fake.baseURL(),
		WebBase:     fake.baseURL(),
	})
	if err != nil {
		t.Fatal(err)
	}
	broker, err := NewBroker(app, store)
	if err != nil {
		t.Fatal(err)
	}
	return broker
}
