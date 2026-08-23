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
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
)

// defaultInstallStateTTL bounds how long an install redirect stays valid. The
// window only has to cover a human clicking through GitHub's install screen.
const defaultInstallStateTTL = 15 * time.Minute

// LinkStore is the persistence the install/link flow needs.
type LinkStore interface {
	CreateSCMInstallState(ctx context.Context, tenant postgres.Tenant, stateHash []byte, expiresAt time.Time) error
	ConsumeSCMInstallState(ctx context.Context, stateHash []byte) (domain.SCMInstallationLink, error)
	UpsertSCMInstallation(ctx context.Context, tenant postgres.Tenant, installation domain.SCMInstallation) (domain.SCMInstallation, error)
	SCMInstallationByID(ctx context.Context, tenant postgres.Tenant, installationID string) (domain.SCMInstallation, error)
	ListSCMInstallations(ctx context.Context, tenant postgres.Tenant) ([]domain.SCMInstallation, error)
	DeleteSCMInstallation(ctx context.Context, tenant postgres.Tenant, installationID string) error
	SyncSCMRepositories(ctx context.Context, tenant postgres.Tenant, installationID string, repositories []domain.SCMRepository, allowNew bool) error
	ListSCMRepositories(ctx context.Context, tenant postgres.Tenant, installationID string) ([]domain.SCMRepository, error)
	SetSCMRepositoryAllowlist(ctx context.Context, tenant postgres.Tenant, installationID string, allowedExternalIDs []int64) error
}

// LinkService owns the GitHub App installation and allowlist lifecycle.
type LinkService struct {
	app      *AppClient
	store    LinkStore
	stateTTL time.Duration
	now      func() time.Time
}

// NewLinkService builds the install/link service.
func NewLinkService(app *AppClient, store LinkStore) (*LinkService, error) {
	if app == nil {
		return nil, ErrNotConfigured
	}
	if store == nil {
		return nil, errors.New("cloud scm: link service requires a store")
	}
	return &LinkService{app: app, store: store, stateTTL: defaultInstallStateTTL, now: time.Now}, nil
}

// InstallRedirect is where the browser must go to install the app, plus how
// long the accompanying state stays valid.
type InstallRedirect struct {
	InstallURL string
	ExpiresAt  time.Time
}

// StartInstall issues a single-use state bound to the requesting admin and
// returns the GitHub install URL. RLS rejects the state insert when the caller
// cannot manage the organization, so authorization is enforced in the database
// rather than only in the handler.
func (s *LinkService) StartInstall(ctx context.Context, tenant postgres.Tenant) (InstallRedirect, string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return InstallRedirect{}, "", err
	}
	state := base64.RawURLEncoding.EncodeToString(raw)
	digest := sha256.Sum256([]byte(state))
	expiresAt := s.now().UTC().Add(s.stateTTL)
	if err := s.store.CreateSCMInstallState(ctx, tenant, digest[:], expiresAt); err != nil {
		return InstallRedirect{}, "", err
	}
	return InstallRedirect{InstallURL: s.app.InstallURL(state), ExpiresAt: expiresAt}, state, nil
}

// CallbackParams are the query values GitHub sends to the app's setup URL.
type CallbackParams struct {
	State                  string
	ExternalInstallationID int64
	SetupAction            string
	// Code is the user-authorization code GitHub includes when the app
	// requests user authorization during installation.
	Code string
}

// CompleteInstall verifies a returning install redirect and links the
// installation to the organization that started it.
//
// Three independent checks must pass: the state must be an unconsumed,
// unexpired token this control plane issued; the installation must exist as
// far as the app's own credentials are concerned; and, when user
// authorization is configured, the completing user must actually be able to
// see the installation. Without the third check, knowing an installation id
// would be enough to attach someone else's repositories to your organization.
func (s *LinkService) CompleteInstall(ctx context.Context, params CallbackParams) (domain.SCMInstallation, error) {
	state := strings.TrimSpace(params.State)
	if state == "" {
		return domain.SCMInstallation{}, ErrInvalidState
	}
	digest := sha256.Sum256([]byte(state))
	link, err := s.store.ConsumeSCMInstallState(ctx, digest[:])
	if err != nil {
		if errors.Is(err, postgres.ErrNotFound) {
			return domain.SCMInstallation{}, ErrInvalidState
		}
		return domain.SCMInstallation{}, err
	}
	if params.ExternalInstallationID <= 0 {
		return domain.SCMInstallation{}, ErrInstallationNotFound
	}
	account, err := s.app.Installation(ctx, params.ExternalInstallationID)
	if err != nil {
		return domain.SCMInstallation{}, err
	}
	if err := s.app.VerifyUserInstallation(ctx, params.Code, params.ExternalInstallationID); err != nil {
		return domain.SCMInstallation{}, err
	}

	tenant := postgres.Tenant{OrgID: link.OrgID, UserID: link.UserID}
	status := domain.InstallationStatusActive
	if account.Suspended {
		status = domain.InstallationStatusSuspended
	}
	installation, err := s.store.UpsertSCMInstallation(ctx, tenant, domain.SCMInstallation{
		ExternalInstallationID: account.ExternalID,
		AccountLogin:           account.AccountLogin,
		AccountType:            account.AccountType,
		AppSlug:                account.AppSlug,
		RepositorySelection:    account.RepositorySelection,
		Status:                 status,
	})
	if err != nil {
		if postgres.IsConflict(err) {
			return domain.SCMInstallation{}, ErrInstallationClaimed
		}
		return domain.SCMInstallation{}, err
	}
	// Picking specific repositories during installation is itself an explicit
	// allowlist decision, so those land allowed. An "all repositories"
	// installation does not: an admin must still choose what AO may touch.
	allowNew := account.RepositorySelection == "selected"
	if err := s.syncRepositories(ctx, tenant, installation, allowNew); err != nil {
		return domain.SCMInstallation{}, err
	}
	return installation, nil
}

// SyncInstallation refreshes the repositories an installation can see. It
// never widens the allowlist.
func (s *LinkService) SyncInstallation(
	ctx context.Context,
	tenant postgres.Tenant,
	installationID string,
) ([]domain.SCMRepository, error) {
	installation, err := s.store.SCMInstallationByID(ctx, tenant, installationID)
	if err != nil {
		return nil, err
	}
	if err := s.syncRepositories(ctx, tenant, installation, false); err != nil {
		return nil, err
	}
	return s.store.ListSCMRepositories(ctx, tenant, installationID)
}

func (s *LinkService) syncRepositories(
	ctx context.Context,
	tenant postgres.Tenant,
	installation domain.SCMInstallation,
	allowNew bool,
) error {
	refs, err := s.app.ListInstallationRepositories(ctx, installation.ExternalInstallationID)
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
	return s.store.SyncSCMRepositories(ctx, tenant, installation.ID, repositories, allowNew)
}

// SetAllowlist replaces which repositories a tenant's cloud projects may clone
// or push. Names are resolved against the installation's known repositories,
// so an admin cannot allowlist something the installation cannot see.
func (s *LinkService) SetAllowlist(
	ctx context.Context,
	tenant postgres.Tenant,
	installationID string,
	repositoryFullNames []string,
) ([]domain.SCMRepository, error) {
	known, err := s.store.ListSCMRepositories(ctx, tenant, installationID)
	if err != nil {
		return nil, err
	}
	byName := make(map[string]int64, len(known))
	for _, repository := range known {
		byName[repository.FullName] = repository.ExternalRepositoryID
	}
	allowed := make([]int64, 0, len(repositoryFullNames))
	for _, name := range repositoryFullNames {
		normalized, normErr := NormalizeRepository(name)
		if normErr != nil {
			return nil, normErr
		}
		externalID, ok := byName[normalized]
		if !ok {
			return nil, ErrRepositoryNotAllowed
		}
		allowed = append(allowed, externalID)
	}
	if err := s.store.SetSCMRepositoryAllowlist(ctx, tenant, installationID, allowed); err != nil {
		return nil, err
	}
	return s.store.ListSCMRepositories(ctx, tenant, installationID)
}

// ListInstallations returns the tenant's linked installations.
func (s *LinkService) ListInstallations(ctx context.Context, tenant postgres.Tenant) ([]domain.SCMInstallation, error) {
	return s.store.ListSCMInstallations(ctx, tenant)
}

// ListRepositories returns everything one installation can see, allowlisted or
// not, so an admin can decide.
func (s *LinkService) ListRepositories(
	ctx context.Context,
	tenant postgres.Tenant,
	installationID string,
) ([]domain.SCMRepository, error) {
	if _, err := s.store.SCMInstallationByID(ctx, tenant, installationID); err != nil {
		return nil, err
	}
	return s.store.ListSCMRepositories(ctx, tenant, installationID)
}

// Unlink removes an installation from the organization. The GitHub-side
// uninstall remains the user's action; unlinking only revokes AO's ability to
// broker credentials for it.
func (s *LinkService) Unlink(ctx context.Context, tenant postgres.Tenant, installationID string) error {
	return s.store.DeleteSCMInstallation(ctx, tenant, installationID)
}
