package scm

import (
	"context"
	"crypto/sha256"
	"errors"
	"net/url"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

type linkProviderStub struct {
	account      InstallationAccount
	repositories []RepositoryRef
	verifiedCode string
}

func (*linkProviderStub) RequiresUserAuthorization() bool { return true }
func (*linkProviderStub) InstallURL(state string) string {
	return "https://github.com/apps/ao/installations/new?state=" + url.QueryEscape(state)
}
func (p *linkProviderStub) Installation(context.Context, int64) (InstallationAccount, error) {
	return p.account, nil
}
func (p *linkProviderStub) VerifyUserInstallation(_ context.Context, code string, _ int64) error {
	p.verifiedCode = code
	if code == "" {
		return ErrInstallationNotOwned
	}
	return nil
}
func (p *linkProviderStub) ListInstallationRepositories(context.Context, int64) ([]RepositoryRef, error) {
	return p.repositories, nil
}

type linkStoreStub struct {
	stateHash    []byte
	stateLink    domain.SCMInstallationLink
	stateUsed    bool
	installation domain.SCMInstallation
	repositories []domain.SCMRepository
	allowed      []int64
}

func (s *linkStoreStub) CreateSCMInstallState(_ context.Context, identity tenant.Identity, hash []byte, _ time.Time) error {
	s.stateHash = append([]byte(nil), hash...)
	s.stateLink = domain.SCMInstallationLink{OrgID: identity.OrgID, UserID: identity.UserID}
	return nil
}
func (s *linkStoreStub) ConsumeSCMInstallState(_ context.Context, hash []byte) (domain.SCMInstallationLink, error) {
	if s.stateUsed || !equalBytes(hash, s.stateHash) {
		return domain.SCMInstallationLink{}, domain.ErrSCMNotFound
	}
	s.stateUsed = true
	return s.stateLink, nil
}
func (s *linkStoreStub) UpsertSCMInstallation(_ context.Context, identity tenant.Identity, installation domain.SCMInstallation) (domain.SCMInstallation, error) {
	installation.ID, installation.OrgID, installation.LinkedByUserID = "installation", identity.OrgID, identity.UserID
	s.installation = installation
	return installation, nil
}
func (s *linkStoreStub) SCMInstallationByID(context.Context, tenant.Identity, string) (domain.SCMInstallation, error) {
	if s.installation.ID == "" {
		return domain.SCMInstallation{}, domain.ErrSCMNotFound
	}
	return s.installation, nil
}
func (s *linkStoreStub) ListSCMInstallations(context.Context, tenant.Identity) ([]domain.SCMInstallation, error) {
	return []domain.SCMInstallation{s.installation}, nil
}
func (*linkStoreStub) DeleteSCMInstallation(context.Context, tenant.Identity, string) error {
	return nil
}
func (s *linkStoreStub) SyncSCMRepositories(_ context.Context, _ tenant.Identity, installationID string, repositories []domain.SCMRepository) error {
	for index := range repositories {
		repositories[index].ID = "repository"
		repositories[index].InstallationID = installationID
		repositories[index].Allowed = false
	}
	s.repositories = append([]domain.SCMRepository(nil), repositories...)
	return nil
}
func (s *linkStoreStub) ListSCMRepositories(context.Context, tenant.Identity, string) ([]domain.SCMRepository, error) {
	return append([]domain.SCMRepository(nil), s.repositories...), nil
}
func (s *linkStoreStub) SetSCMRepositoryAllowlist(_ context.Context, _ tenant.Identity, _ string, ids []int64) error {
	s.allowed = append([]int64(nil), ids...)
	for index := range s.repositories {
		s.repositories[index].Allowed = len(ids) == 1 && ids[0] == s.repositories[index].ExternalRepositoryID
	}
	return nil
}

func TestInstallationServiceStateOwnershipAndDefaultDeny(t *testing.T) {
	provider := &linkProviderStub{
		account:      InstallationAccount{ExternalID: 55, AccountLogin: "Acme", AccountType: "Organization", AppSlug: "ao", RepositorySelection: "selected"},
		repositories: []RepositoryRef{{ExternalID: 77, FullName: "acme/widgets", Private: true}},
	}
	store := &linkStoreStub{}
	service, err := NewLinkService(provider, store)
	if err != nil {
		t.Fatal(err)
	}
	identity := tenant.Identity{OrgID: "org", UserID: "user"}
	redirect, err := service.StartInstall(t.Context(), identity)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := url.Parse(redirect.InstallURL)
	if err != nil {
		t.Fatal(err)
	}
	state := parsed.Query().Get("state")
	digest := sha256.Sum256([]byte(state))
	if state == "" || !equalBytes(digest[:], store.stateHash) {
		t.Fatal("install state was not persisted as a digest")
	}
	installation, err := service.CompleteInstall(t.Context(), CallbackParams{State: state, ExternalInstallationID: 55, Code: "oauth-code"})
	if err != nil {
		t.Fatal(err)
	}
	if installation.OrgID != identity.OrgID || provider.verifiedCode != "oauth-code" {
		t.Fatalf("installation=%#v code=%q", installation, provider.verifiedCode)
	}
	if len(store.repositories) != 1 || store.repositories[0].Allowed {
		t.Fatalf("repositories=%#v", store.repositories)
	}
	if _, err := service.CompleteInstall(t.Context(), CallbackParams{State: state, ExternalInstallationID: 55, Code: "oauth-code"}); !errors.Is(err, ErrInvalidState) {
		t.Fatalf("replayed state error = %v", err)
	}
}

func TestInstallationServiceAllowlistIsFullReplacement(t *testing.T) {
	store := &linkStoreStub{
		installation: domain.SCMInstallation{ID: "installation", Status: domain.InstallationStatusActive},
		repositories: []domain.SCMRepository{{ID: "repo", ExternalRepositoryID: 77, FullName: "acme/widgets"}},
	}
	service, err := NewLinkService(&linkProviderStub{}, store)
	if err != nil {
		t.Fatal(err)
	}
	repositories, err := service.SetAllowlist(t.Context(), tenant.Identity{OrgID: "org", UserID: "user"}, "installation", []string{"https://github.com/Acme/Widgets.git"})
	if err != nil {
		t.Fatal(err)
	}
	if len(store.allowed) != 1 || store.allowed[0] != 77 || len(repositories) != 1 || !repositories[0].Allowed {
		t.Fatalf("allowed=%#v repositories=%#v", store.allowed, repositories)
	}
	if _, err := service.SetAllowlist(t.Context(), tenant.Identity{OrgID: "org", UserID: "user"}, "installation", []string{"evil/repository"}); !errors.Is(err, ErrRepositoryNotAllowed) {
		t.Fatalf("unknown repository error = %v", err)
	}
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
