package scm

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

const defaultInstallStateTTL = 15 * time.Minute

// InstallRedirect describes the short-lived GitHub App installation redirect.
type InstallRedirect struct {
	InstallURL string
	ExpiresAt  time.Time
}

// CallbackParams carries the state and installation identity returned by GitHub.
type CallbackParams struct {
	State                  string
	ExternalInstallationID int64
	SetupAction            string
	Code                   string
}

// LinkProvider is the provider boundary required by installation management.
type LinkProvider interface {
	InstallURL(string) string
	RequiresUserAuthorization() bool
	Installation(context.Context, int64) (InstallationAccount, error)
	VerifyUserInstallation(context.Context, string, int64) error
	ListInstallationRepositories(context.Context, int64) ([]RepositoryRef, error)
}

// LinkStore persists install state, installation ownership, and repository policy.
type LinkStore interface {
	CreateSCMInstallState(context.Context, tenant.Identity, []byte, time.Time) error
	ConsumeSCMInstallState(context.Context, []byte) (domain.SCMInstallationLink, error)
	UpsertSCMInstallation(context.Context, tenant.Identity, domain.SCMInstallation) (domain.SCMInstallation, error)
	SCMInstallationByID(context.Context, tenant.Identity, string) (domain.SCMInstallation, error)
	ListSCMInstallations(context.Context, tenant.Identity) ([]domain.SCMInstallation, error)
	DeleteSCMInstallation(context.Context, tenant.Identity, string) error
	SyncSCMRepositories(context.Context, tenant.Identity, string, []domain.SCMRepository) error
	ListSCMRepositories(context.Context, tenant.Identity, string) ([]domain.SCMRepository, error)
	SetSCMRepositoryAllowlist(context.Context, tenant.Identity, string, []int64) error
}

// InstallationService owns GitHub App linking and repository allowlist policy.
type InstallationService struct {
	provider LinkProvider
	store    LinkStore
	stateTTL time.Duration
	now      func() time.Time
}

// NewLinkService constructs the installation lifecycle service.
func NewLinkService(provider LinkProvider, store LinkStore) (*InstallationService, error) {
	if provider == nil || !provider.RequiresUserAuthorization() {
		return nil, errors.New("cloud scm: github user authorization is required for installation linking")
	}
	if store == nil {
		return nil, errors.New("cloud scm: link service requires a store")
	}
	return &InstallationService{provider: provider, store: store, stateTTL: defaultInstallStateTTL, now: time.Now}, nil
}

// StartInstall persists a one-shot state digest and returns the provider URL.
func (s *InstallationService) StartInstall(ctx context.Context, identity tenant.Identity) (InstallRedirect, error) {
	if !identity.Valid() {
		return InstallRedirect{}, tenant.ErrNoTenant
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return InstallRedirect{}, err
	}
	state := base64.RawURLEncoding.EncodeToString(raw)
	digest := sha256.Sum256([]byte(state))
	expiresAt := s.now().UTC().Add(s.stateTTL)
	if err := s.store.CreateSCMInstallState(ctx, identity, digest[:], expiresAt); err != nil {
		return InstallRedirect{}, err
	}
	return InstallRedirect{InstallURL: s.provider.InstallURL(state), ExpiresAt: expiresAt}, nil
}

// CompleteInstall consumes state, proves user ownership, and links one installation.
func (s *InstallationService) CompleteInstall(ctx context.Context, params CallbackParams) (domain.SCMInstallation, error) {
	state := strings.TrimSpace(params.State)
	if state == "" {
		return domain.SCMInstallation{}, ErrInvalidState
	}
	digest := sha256.Sum256([]byte(state))
	link, err := s.store.ConsumeSCMInstallState(ctx, digest[:])
	if err != nil {
		if errors.Is(err, domain.ErrSCMNotFound) {
			return domain.SCMInstallation{}, ErrInvalidState
		}
		return domain.SCMInstallation{}, err
	}
	if params.ExternalInstallationID <= 0 {
		return domain.SCMInstallation{}, ErrInstallationNotFound
	}
	account, err := s.provider.Installation(ctx, params.ExternalInstallationID)
	if err != nil {
		return domain.SCMInstallation{}, err
	}
	if err := s.provider.VerifyUserInstallation(ctx, params.Code, params.ExternalInstallationID); err != nil {
		return domain.SCMInstallation{}, err
	}
	identity := tenant.Identity{OrgID: link.OrgID, UserID: link.UserID}
	status := domain.InstallationStatusActive
	if account.Suspended {
		status = domain.InstallationStatusSuspended
	}
	installation, err := s.store.UpsertSCMInstallation(ctx, identity, domain.SCMInstallation{
		ExternalInstallationID: account.ExternalID,
		AccountLogin:           account.AccountLogin, AccountType: account.AccountType,
		AppSlug: account.AppSlug, RepositorySelection: account.RepositorySelection,
		Status: status,
	})
	if err != nil {
		if errors.Is(err, domain.ErrSCMConflict) {
			return domain.SCMInstallation{}, ErrInstallationClaimed
		}
		return domain.SCMInstallation{}, err
	}
	if err := s.sync(ctx, identity, installation); err != nil {
		return domain.SCMInstallation{}, err
	}
	return installation, nil
}

// ListInstallations returns installations visible to one tenant administrator.
func (s *InstallationService) ListInstallations(ctx context.Context, identity tenant.Identity) ([]domain.SCMInstallation, error) {
	return s.store.ListSCMInstallations(ctx, identity)
}

// ListRepositories returns provider-visible repositories with allowlist state.
func (s *InstallationService) ListRepositories(ctx context.Context, identity tenant.Identity, installationID string) ([]domain.SCMRepository, error) {
	if _, err := s.store.SCMInstallationByID(ctx, identity, strings.TrimSpace(installationID)); err != nil {
		return nil, err
	}
	return s.store.ListSCMRepositories(ctx, identity, strings.TrimSpace(installationID))
}

// SyncInstallation refreshes provider visibility without changing allowlist state.
func (s *InstallationService) SyncInstallation(ctx context.Context, identity tenant.Identity, installationID string) ([]domain.SCMRepository, error) {
	installation, err := s.store.SCMInstallationByID(ctx, identity, strings.TrimSpace(installationID))
	if err != nil {
		return nil, err
	}
	if installation.Status != domain.InstallationStatusActive {
		return nil, ErrInstallationInactive
	}
	if err := s.sync(ctx, identity, installation); err != nil {
		return nil, err
	}
	return s.store.ListSCMRepositories(ctx, identity, installation.ID)
}

func (s *InstallationService) sync(ctx context.Context, identity tenant.Identity, installation domain.SCMInstallation) error {
	refs, err := s.provider.ListInstallationRepositories(ctx, installation.ExternalInstallationID)
	if err != nil {
		return err
	}
	repositories := make([]domain.SCMRepository, 0, len(refs))
	for _, ref := range refs {
		repositories = append(repositories, domain.SCMRepository{
			ExternalRepositoryID: ref.ExternalID,
			FullName:             ref.FullName,
			Private:              ref.Private,
		})
	}
	return s.store.SyncSCMRepositories(ctx, identity, installation.ID, repositories)
}

// SetAllowlist replaces the allowed repositories for one installation.
func (s *InstallationService) SetAllowlist(
	ctx context.Context,
	identity tenant.Identity,
	installationID string,
	fullNames []string,
) ([]domain.SCMRepository, error) {
	known, err := s.ListRepositories(ctx, identity, installationID)
	if err != nil {
		return nil, err
	}
	byName := make(map[string]int64, len(known))
	for _, repository := range known {
		byName[repository.FullName] = repository.ExternalRepositoryID
	}
	allowed := make([]int64, 0, len(fullNames))
	seen := make(map[int64]struct{}, len(fullNames))
	for _, requested := range fullNames {
		normalized, err := NormalizeRepository(requested)
		if err != nil {
			return nil, err
		}
		externalID, ok := byName[normalized]
		if !ok {
			return nil, ErrRepositoryNotAllowed
		}
		if _, duplicate := seen[externalID]; !duplicate {
			seen[externalID] = struct{}{}
			allowed = append(allowed, externalID)
		}
	}
	if err := s.store.SetSCMRepositoryAllowlist(ctx, identity, strings.TrimSpace(installationID), allowed); err != nil {
		return nil, err
	}
	return s.store.ListSCMRepositories(ctx, identity, strings.TrimSpace(installationID))
}

// Unlink disconnects an installation and revokes its local allowlist.
func (s *InstallationService) Unlink(ctx context.Context, identity tenant.Identity, installationID string) error {
	return s.store.DeleteSCMInstallation(ctx, identity, strings.TrimSpace(installationID))
}
