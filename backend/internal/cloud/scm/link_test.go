package scm

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// memoryLinkStore models the parts of the schema the link flow depends on,
// including the invariant that an installation belongs to exactly one org.
type memoryLinkStore struct {
	mu sync.Mutex

	states        map[string]domain.SCMInstallationLink
	stateExpiry   map[string]time.Time
	installations map[string]domain.SCMInstallation
	byExternal    map[int64]string
	repositories  map[string][]domain.SCMRepository
	syncCalls     []bool
	createErr     error
}

func newMemoryLinkStore() *memoryLinkStore {
	return &memoryLinkStore{
		states:        map[string]domain.SCMInstallationLink{},
		stateExpiry:   map[string]time.Time{},
		installations: map[string]domain.SCMInstallation{},
		byExternal:    map[int64]string{},
		repositories:  map[string][]domain.SCMRepository{},
	}
}

func (s *memoryLinkStore) CreateSCMInstallState(
	_ context.Context,
	tenant tenant.Identity,
	stateHash []byte,
	expiresAt time.Time,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.createErr != nil {
		return s.createErr
	}
	s.states[string(stateHash)] = domain.SCMInstallationLink{OrgID: tenant.OrgID, UserID: tenant.UserID}
	s.stateExpiry[string(stateHash)] = expiresAt
	return nil
}

func (s *memoryLinkStore) ConsumeSCMInstallState(
	_ context.Context,
	stateHash []byte,
) (domain.SCMInstallationLink, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	link, ok := s.states[string(stateHash)]
	if !ok || !time.Now().UTC().Before(s.stateExpiry[string(stateHash)]) {
		return domain.SCMInstallationLink{}, postgres.ErrNotFound
	}
	delete(s.states, string(stateHash))
	return link, nil
}

func (s *memoryLinkStore) UpsertSCMInstallation(
	_ context.Context,
	tenant tenant.Identity,
	installation domain.SCMInstallation,
) (domain.SCMInstallation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if existingID, claimed := s.byExternal[installation.ExternalInstallationID]; claimed {
		if s.installations[existingID].OrgID != tenant.OrgID {
			// The database enforces this with a unique constraint that RLS
			// hides behind a conflict error.
			return domain.SCMInstallation{}, postgres.ErrConflict
		}
	}
	id, claimed := s.byExternal[installation.ExternalInstallationID]
	if !claimed {
		id = "installation-" + strings.TrimSpace(installation.AccountLogin)
		s.byExternal[installation.ExternalInstallationID] = id
	}
	installation.ID = id
	installation.OrgID = tenant.OrgID
	installation.Provider = domain.SCMProviderGitHub
	s.installations[id] = installation
	return installation, nil
}

func (s *memoryLinkStore) SCMInstallationByID(
	_ context.Context,
	tenant tenant.Identity,
	installationID string,
) (domain.SCMInstallation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	installation, ok := s.installations[installationID]
	if !ok || installation.OrgID != tenant.OrgID {
		return domain.SCMInstallation{}, postgres.ErrNotFound
	}
	return installation, nil
}

func (s *memoryLinkStore) ListSCMInstallations(
	_ context.Context,
	tenant tenant.Identity,
) ([]domain.SCMInstallation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]domain.SCMInstallation, 0, len(s.installations))
	for _, installation := range s.installations {
		if installation.OrgID == tenant.OrgID {
			result = append(result, installation)
		}
	}
	return result, nil
}

func (s *memoryLinkStore) DeleteSCMInstallation(
	_ context.Context,
	tenant tenant.Identity,
	installationID string,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	installation, ok := s.installations[installationID]
	if !ok || installation.OrgID != tenant.OrgID {
		return postgres.ErrNotFound
	}
	delete(s.installations, installationID)
	delete(s.byExternal, installation.ExternalInstallationID)
	delete(s.repositories, installationID)
	return nil
}

func (s *memoryLinkStore) SyncSCMRepositories(
	_ context.Context,
	_ tenant.Identity,
	installationID string,
	repositories []domain.SCMRepository,
	allowNew bool,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.syncCalls = append(s.syncCalls, allowNew)
	existing := map[string]bool{}
	for _, repository := range s.repositories[installationID] {
		existing[repository.FullName] = repository.Allowed
	}
	stored := make([]domain.SCMRepository, 0, len(repositories))
	for _, repository := range repositories {
		repository.ID = "repository-" + repository.FullName
		repository.InstallationID = installationID
		repository.Allowed = existing[repository.FullName] || allowNew
		stored = append(stored, repository)
	}
	s.repositories[installationID] = stored
	return nil
}

func (s *memoryLinkStore) ListSCMRepositories(
	_ context.Context,
	_ tenant.Identity,
	installationID string,
) ([]domain.SCMRepository, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]domain.SCMRepository(nil), s.repositories[installationID]...), nil
}

func (s *memoryLinkStore) SetSCMRepositoryAllowlist(
	_ context.Context,
	_ tenant.Identity,
	installationID string,
	allowedExternalIDs []int64,
) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	allowed := map[int64]bool{}
	for _, id := range allowedExternalIDs {
		allowed[id] = true
	}
	stored := s.repositories[installationID]
	for index := range stored {
		stored[index].Allowed = allowed[stored[index].ExternalRepositoryID]
	}
	s.repositories[installationID] = stored
	return nil
}

func newTestLinkService(t *testing.T, fake *fakeGitHub, store LinkStore, oauth bool) *LinkService {
	t.Helper()
	options := AppClientOptions{
		Credentials: testCredentials(t),
		APIBase:     fake.baseURL(),
		WebBase:     fake.baseURL(),
	}
	if oauth {
		options.OAuthClientID = "client-id"
		options.OAuthClientSecret = "client-secret"
	}
	app, err := NewAppClient(options)
	if err != nil {
		t.Fatal(err)
	}
	service, err := NewLinkService(app, store)
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func TestStartInstallIssuesSingleUseState(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryLinkStore()
	service := newTestLinkService(t, fake, store, false)

	redirect, state, err := service.StartInstall(context.Background(), tenant.Identity{OrgID: "org-1", UserID: "user-1"})
	if err != nil {
		t.Fatal(err)
	}
	if state == "" || redirect.ExpiresAt.IsZero() {
		t.Fatalf("redirect = %#v state = %q", redirect, state)
	}
	parsed, err := url.Parse(redirect.InstallURL)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Query().Get("state") != state {
		t.Fatalf("install URL did not echo the state: %s", redirect.InstallURL)
	}
	// Only the digest is retained, so a database read cannot replay the link.
	digest := sha256.Sum256([]byte(state))
	if _, ok := store.states[string(digest[:])]; !ok {
		t.Fatal("state digest was not persisted")
	}
	for stored := range store.states {
		if strings.Contains(stored, state) {
			t.Fatal("the raw state token was persisted")
		}
	}
}

func TestCompleteInstallKeepsSelectedRepositoriesDefaultDeny(t *testing.T) {
	fake := newFakeGitHub(t)
	fake.repositories = []RepositoryRef{
		{ExternalID: 900, FullName: "acme/widgets", Private: true},
		{ExternalID: 901, FullName: "acme/docs"},
	}
	store := newMemoryLinkStore()
	service := newTestLinkService(t, fake, store, false)

	_, state, err := service.StartInstall(context.Background(), tenant.Identity{OrgID: "org-1", UserID: "user-1"})
	if err != nil {
		t.Fatal(err)
	}
	installation, err := service.CompleteInstall(context.Background(), CallbackParams{
		State: state, ExternalInstallationID: 55, SetupAction: "install",
	})
	if err != nil {
		t.Fatal(err)
	}
	if installation.OrgID != "org-1" || installation.Status != domain.InstallationStatusActive {
		t.Fatalf("installation = %#v", installation)
	}
	// GitHub visibility never substitutes for an explicit AO allowlist act.
	if len(store.syncCalls) != 1 || store.syncCalls[0] {
		t.Fatalf("sync calls = %#v", store.syncCalls)
	}
	repositories, err := service.ListRepositories(context.Background(), tenant.Identity{OrgID: "org-1", UserID: "user-1"}, installation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(repositories) != 2 || repositories[0].Allowed || repositories[1].Allowed {
		t.Fatalf("repositories = %#v", repositories)
	}
}

func TestCompleteInstallWithAllRepositoriesStaysDefaultDeny(t *testing.T) {
	fake := newFakeGitHub(t)
	fake.repositorySelection = "all"
	fake.repositories = []RepositoryRef{{ExternalID: 900, FullName: "acme/widgets"}}
	store := newMemoryLinkStore()
	service := newTestLinkService(t, fake, store, false)

	_, state, err := service.StartInstall(context.Background(), tenant.Identity{OrgID: "org-1", UserID: "user-1"})
	if err != nil {
		t.Fatal(err)
	}
	installation, err := service.CompleteInstall(context.Background(), CallbackParams{
		State: state, ExternalInstallationID: 55,
	})
	if err != nil {
		t.Fatal(err)
	}
	repositories, err := service.ListRepositories(context.Background(), tenant.Identity{OrgID: "org-1", UserID: "user-1"}, installation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(repositories) != 1 || repositories[0].Allowed {
		t.Fatalf("an all-repositories installation allowlisted itself: %#v", repositories)
	}
}

func TestCompleteInstallRejectsReplayedAndForgedState(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryLinkStore()
	service := newTestLinkService(t, fake, store, false)

	_, state, err := service.StartInstall(context.Background(), tenant.Identity{OrgID: "org-1", UserID: "user-1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.CompleteInstall(context.Background(), CallbackParams{
		State: state, ExternalInstallationID: 55,
	}); err != nil {
		t.Fatal(err)
	}
	// Replaying the same state must not link a second installation.
	if _, err := service.CompleteInstall(context.Background(), CallbackParams{
		State: state, ExternalInstallationID: 66,
	}); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("replayed state error = %v", err)
	}
	if _, err := service.CompleteInstall(context.Background(), CallbackParams{
		State: "forged", ExternalInstallationID: 66,
	}); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("forged state error = %v", err)
	}
	if _, err := service.CompleteInstall(context.Background(), CallbackParams{
		State: "", ExternalInstallationID: 66,
	}); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("empty state error = %v", err)
	}
}

func TestCompleteInstallRefusesInstallationClaimedByAnotherOrganization(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryLinkStore()
	service := newTestLinkService(t, fake, store, false)

	_, firstState, err := service.StartInstall(context.Background(), tenant.Identity{OrgID: "org-1", UserID: "user-1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.CompleteInstall(context.Background(), CallbackParams{
		State: firstState, ExternalInstallationID: 55,
	}); err != nil {
		t.Fatal(err)
	}
	_, secondState, err := service.StartInstall(context.Background(), tenant.Identity{OrgID: "org-2", UserID: "user-2"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.CompleteInstall(context.Background(), CallbackParams{
		State: secondState, ExternalInstallationID: 55,
	}); !errors.Is(err, ErrInstallationClaimed) {
		t.Fatalf("cross-tenant claim error = %v", err)
	}
}

func TestCompleteInstallRequiresUserAuthorizationWhenConfigured(t *testing.T) {
	fake := newFakeGitHub(t)
	fake.oauthCode = "valid-code"
	fake.userInstallations = []int64{77}
	store := newMemoryLinkStore()
	service := newTestLinkService(t, fake, store, true)

	newState := func(t *testing.T) string {
		t.Helper()
		_, state, err := service.StartInstall(context.Background(), tenant.Identity{OrgID: "org-1", UserID: "user-1"})
		if err != nil {
			t.Fatal(err)
		}
		return state
	}

	// No code at all: the completing user proved nothing.
	if _, err := service.CompleteInstall(context.Background(), CallbackParams{
		State: newState(t), ExternalInstallationID: 77,
	}); !errors.Is(err, ErrInstallationNotOwned) {
		t.Fatalf("missing code error = %v", err)
	}
	// A code that GitHub rejects.
	if _, err := service.CompleteInstall(context.Background(), CallbackParams{
		State: newState(t), ExternalInstallationID: 77, Code: "stale-code",
	}); !errors.Is(err, ErrInstallationNotOwned) {
		t.Fatalf("bad code error = %v", err)
	}
	// A valid code, but for an installation the user cannot see.
	if _, err := service.CompleteInstall(context.Background(), CallbackParams{
		State: newState(t), ExternalInstallationID: 88, Code: "valid-code",
	}); !errors.Is(err, ErrInstallationNotOwned) {
		t.Fatalf("foreign installation error = %v", err)
	}
	// The real path.
	if _, err := service.CompleteInstall(context.Background(), CallbackParams{
		State: newState(t), ExternalInstallationID: 77, Code: "valid-code",
	}); err != nil {
		t.Fatal(err)
	}
}

func TestCompleteInstallRecordsSuspendedInstallation(t *testing.T) {
	fake := newFakeGitHub(t)
	fake.suspendedAt = "2026-08-01T00:00:00Z"
	store := newMemoryLinkStore()
	service := newTestLinkService(t, fake, store, false)

	_, state, err := service.StartInstall(context.Background(), tenant.Identity{OrgID: "org-1", UserID: "user-1"})
	if err != nil {
		t.Fatal(err)
	}
	installation, err := service.CompleteInstall(context.Background(), CallbackParams{
		State: state, ExternalInstallationID: 55,
	})
	if err != nil {
		t.Fatal(err)
	}
	if installation.Status != domain.InstallationStatusSuspended {
		t.Fatalf("status = %q", installation.Status)
	}
}

func TestCompleteInstallRequiresAnInstallationID(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryLinkStore()
	service := newTestLinkService(t, fake, store, false)

	_, state, err := service.StartInstall(context.Background(), tenant.Identity{OrgID: "org-1", UserID: "user-1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.CompleteInstall(context.Background(), CallbackParams{
		State: state, SetupAction: "request",
	}); !errors.Is(err, ErrInstallationNotFound) {
		t.Fatalf("error = %v", err)
	}
}

func TestSetAllowlistIsAFullReplacementBoundedByVisibility(t *testing.T) {
	fake := newFakeGitHub(t)
	fake.repositorySelection = "all"
	fake.repositories = []RepositoryRef{
		{ExternalID: 900, FullName: "acme/widgets"},
		{ExternalID: 901, FullName: "acme/docs"},
	}
	store := newMemoryLinkStore()
	service := newTestLinkService(t, fake, store, false)
	identity := tenant.Identity{OrgID: "org-1", UserID: "user-1"}

	_, state, err := service.StartInstall(context.Background(), identity)
	if err != nil {
		t.Fatal(err)
	}
	installation, err := service.CompleteInstall(context.Background(), CallbackParams{State: state, ExternalInstallationID: 55})
	if err != nil {
		t.Fatal(err)
	}

	repositories, err := service.SetAllowlist(context.Background(), identity, installation.ID, []string{"Acme/Widgets"})
	if err != nil {
		t.Fatal(err)
	}
	allowed := map[string]bool{}
	for _, repository := range repositories {
		allowed[repository.FullName] = repository.Allowed
	}
	if !allowed["acme/widgets"] || allowed["acme/docs"] {
		t.Fatalf("allowlist = %#v", allowed)
	}

	// Replacing with the other repository must deny the first one.
	repositories, err = service.SetAllowlist(context.Background(), identity, installation.ID, []string{"acme/docs"})
	if err != nil {
		t.Fatal(err)
	}
	for _, repository := range repositories {
		if repository.FullName == "acme/widgets" && repository.Allowed {
			t.Fatal("allowlist replacement did not revoke the previous entry")
		}
	}

	// A repository the installation cannot see can never be allowlisted.
	if _, err := service.SetAllowlist(context.Background(), identity, installation.ID, []string{"other/secret"}); !errors.Is(err, ErrRepositoryNotAllowed) {
		t.Fatalf("error = %v", err)
	}
	if _, err := service.SetAllowlist(context.Background(), identity, installation.ID, []string{"garbage"}); !errors.Is(err, ErrInvalidRepository) {
		t.Fatalf("error = %v", err)
	}
}

func TestSyncInstallationNeverWidensTheAllowlist(t *testing.T) {
	fake := newFakeGitHub(t)
	fake.repositories = []RepositoryRef{{ExternalID: 900, FullName: "acme/widgets"}}
	store := newMemoryLinkStore()
	service := newTestLinkService(t, fake, store, false)
	identity := tenant.Identity{OrgID: "org-1", UserID: "user-1"}

	_, state, err := service.StartInstall(context.Background(), identity)
	if err != nil {
		t.Fatal(err)
	}
	installation, err := service.CompleteInstall(context.Background(), CallbackParams{State: state, ExternalInstallationID: 55})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.SetAllowlist(context.Background(), identity, installation.ID, nil); err != nil {
		t.Fatal(err)
	}

	fake.mu.Lock()
	fake.repositories = append(fake.repositories, RepositoryRef{ExternalID: 902, FullName: "acme/new"})
	fake.mu.Unlock()

	repositories, err := service.SyncInstallation(context.Background(), identity, installation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(repositories) != 2 {
		t.Fatalf("repositories = %#v", repositories)
	}
	for _, repository := range repositories {
		if repository.Allowed {
			t.Fatalf("sync allowlisted %s", repository.FullName)
		}
	}
	if store.syncCalls[len(store.syncCalls)-1] {
		t.Fatal("a refresh sync requested allow-by-default")
	}
}

func TestUnlinkScopesToTenant(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryLinkStore()
	service := newTestLinkService(t, fake, store, false)
	identity := tenant.Identity{OrgID: "org-1", UserID: "user-1"}

	_, state, err := service.StartInstall(context.Background(), identity)
	if err != nil {
		t.Fatal(err)
	}
	installation, err := service.CompleteInstall(context.Background(), CallbackParams{State: state, ExternalInstallationID: 55})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Unlink(context.Background(), tenant.Identity{OrgID: "org-2", UserID: "user-2"}, installation.ID); !errors.Is(err, postgres.ErrNotFound) {
		t.Fatalf("cross-tenant unlink error = %v", err)
	}
	if err := service.Unlink(context.Background(), identity, installation.ID); err != nil {
		t.Fatal(err)
	}
	installations, err := service.ListInstallations(context.Background(), identity)
	if err != nil {
		t.Fatal(err)
	}
	if len(installations) != 0 {
		t.Fatalf("installations = %#v", installations)
	}
}
