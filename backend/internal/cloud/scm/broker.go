package scm

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
)

// tokenRefreshMargin is how long before a minted token's stated expiry the
// broker stops handing it out. GitHub installation tokens live one hour; five
// minutes of headroom covers a slow clone that started just before expiry.
const tokenRefreshMargin = 5 * time.Minute

// permissionsByPurpose is the least-privilege permission set for each reason
// AO asks for a credential. `clone` deliberately cannot write, so a
// compromised bootstrap cannot push.
var permissionsByPurpose = map[string]map[string]string{
	domain.TokenPurposeClone: {
		"contents": "read",
		"metadata": "read",
	},
	domain.TokenPurposePush: {
		"contents":      "write",
		"metadata":      "read",
		"pull_requests": "write",
	},
	domain.TokenPurposeObserve: {
		"contents":      "read",
		"metadata":      "read",
		"pull_requests": "read",
		"checks":        "read",
	},
}

// BrokerStore is the persistence the broker needs. It is satisfied by
// *postgres.Store; the interface exists so the broker can be unit-tested
// without a database.
type BrokerStore interface {
	AllowedSCMRepository(ctx context.Context, tenant postgres.SCMTenant, fullName string) (domain.SCMInstallation, domain.SCMRepository, error)
	RecordSCMTokenGrant(ctx context.Context, tenant postgres.SCMTenant, grant domain.SCMTokenGrant) error
}

// BrokerRequest asks for one repository-scoped credential.
type BrokerRequest struct {
	// OrgID and UserID establish the RLS scope. UserID is the workspace owner,
	// which the control plane resolves from durable state — a re-broker for a
	// push does not require the user to be online.
	OrgID  string
	UserID string
	// Repository is an owner/name pair. Case is normalized.
	Repository string
	// Purpose selects the permission set and is recorded in the audit ledger.
	Purpose string
	// WorkspaceID and SandboxID are optional and used only for audit
	// attribution, so a leaked credential can be traced to the compute that
	// received it.
	WorkspaceID string
	SandboxID   string
}

// BrokeredToken is a short-lived, repository-scoped credential plus the
// metadata a sandbox bootstrap needs. Token is a Secret so it cannot reach a
// log line or a JSON response by accident.
type BrokeredToken struct {
	Token                  Secret
	ExpiresAt              time.Time
	Repository             string
	ExternalRepositoryID   int64
	InstallationID         string
	ExternalInstallationID int64
	Purpose                string
	// BotLogin is the account GitHub attributes to this credential. The SCM
	// observer compares against it instead of calling /user, which an
	// installation token cannot read.
	BotLogin string
}

// Broker mints repository-scoped installation tokens. It is the only place in
// the control plane that turns the app private key into a usable credential,
// and it refuses to do so for a repository the organization has not
// allowlisted.
type Broker struct {
	app    *AppClient
	store  BrokerStore
	now    func() time.Time
	margin time.Duration

	mu    sync.Mutex
	cache map[string]BrokeredToken
}

// NewBroker builds a token broker.
func NewBroker(app *AppClient, store BrokerStore) (*Broker, error) {
	if app == nil {
		return nil, ErrNotConfigured
	}
	if store == nil {
		return nil, errors.New("cloud scm: broker requires a store")
	}
	return &Broker{
		app:    app,
		store:  store,
		now:    time.Now,
		margin: tokenRefreshMargin,
		cache:  map[string]BrokeredToken{},
	}, nil
}

// BrokerToken resolves the allowlist, mints a scoped token, and records the
// grant.
// Errors are deliberately coarse: a caller learns that a repository is not
// available to it, not whether it exists.
func (b *Broker) BrokerToken(ctx context.Context, request BrokerRequest) (BrokeredToken, error) {
	repository, err := NormalizeRepository(request.Repository)
	if err != nil {
		return BrokeredToken{}, err
	}
	purpose := strings.TrimSpace(request.Purpose)
	permissions, ok := permissionsByPurpose[purpose]
	if !ok {
		return BrokeredToken{}, fmt.Errorf("cloud scm: unsupported credential purpose %q", purpose)
	}
	tenant := postgres.SCMTenant{OrgID: request.OrgID, UserID: request.UserID}
	installation, allowed, err := b.store.AllowedSCMRepository(ctx, tenant, repository)
	if err != nil {
		if errors.Is(err, postgres.ErrNotFound) {
			return BrokeredToken{}, ErrRepositoryNotAllowed
		}
		return BrokeredToken{}, err
	}
	if installation.Status != domain.InstallationStatusActive {
		return BrokeredToken{}, ErrInstallationInactive
	}

	// Write credentials are never cached. A push is an on-demand act, so
	// holding a live write token in control-plane memory between pushes buys
	// nothing and widens what a memory disclosure would yield. Read
	// credentials are cached: the observer polls, and re-minting on every poll
	// would burn the app's rate limit.
	cacheable := purpose != domain.TokenPurposePush
	key := cacheKey(installation.ExternalInstallationID, allowed.ExternalRepositoryID, purpose)
	if cacheable {
		if cached, fresh := b.cached(key); fresh {
			return cached, nil
		}
	}

	minted, err := b.app.CreateInstallationToken(ctx, TokenRequest{
		ExternalInstallationID: installation.ExternalInstallationID,
		RepositoryIDs:          []int64{allowed.ExternalRepositoryID},
		Permissions:            permissions,
	})
	if err != nil {
		return BrokeredToken{}, err
	}
	token := BrokeredToken{
		Token:                  minted.Token,
		ExpiresAt:              minted.ExpiresAt,
		Repository:             allowed.FullName,
		ExternalRepositoryID:   allowed.ExternalRepositoryID,
		InstallationID:         installation.ID,
		ExternalInstallationID: installation.ExternalInstallationID,
		Purpose:                purpose,
		BotLogin:               b.app.Credentials().BotLogin(),
	}
	if err := b.store.RecordSCMTokenGrant(ctx, tenant, domain.SCMTokenGrant{
		OrgID:          installation.OrgID,
		InstallationID: installation.ID,
		RepositoryID:   allowed.ID,
		WorkspaceID:    strings.TrimSpace(request.WorkspaceID),
		SandboxID:      strings.TrimSpace(request.SandboxID),
		Purpose:        purpose,
		ExpiresAt:      minted.ExpiresAt,
	}); err != nil {
		// A credential we cannot account for is worse than a failed bootstrap.
		return BrokeredToken{}, fmt.Errorf("cloud scm: record token grant: %w", err)
	}
	if cacheable {
		b.remember(key, token)
	}
	return token, nil
}

// Invalidate drops a cached credential so the next request re-mints. The
// installation token source calls this when GitHub rejects a token.
func (b *Broker) Invalidate(externalInstallationID, externalRepositoryID int64, purpose string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.cache, cacheKey(externalInstallationID, externalRepositoryID, purpose))
}

func (b *Broker) cached(key string) (BrokeredToken, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	token, ok := b.cache[key]
	if !ok {
		return BrokeredToken{}, false
	}
	if !b.now().UTC().Add(b.margin).Before(token.ExpiresAt) {
		delete(b.cache, key)
		return BrokeredToken{}, false
	}
	return token, true
}

func (b *Broker) remember(key string, token BrokeredToken) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.cache[key] = token
}

func cacheKey(externalInstallationID, externalRepositoryID int64, purpose string) string {
	return fmt.Sprintf("%d/%d/%s", externalInstallationID, externalRepositoryID, purpose)
}

// NormalizeRepository lowercases and validates an owner/name reference. It
// also accepts a full GitHub URL so callers can pass a project's clone URL.
func NormalizeRepository(reference string) (string, error) {
	value := strings.TrimSpace(reference)
	if value == "" {
		return "", ErrInvalidRepository
	}
	if index := strings.Index(value, "://"); index >= 0 {
		value = value[index+3:]
		if slash := strings.Index(value, "/"); slash >= 0 {
			value = value[slash+1:]
		} else {
			return "", ErrInvalidRepository
		}
	} else if strings.HasPrefix(value, "git@") {
		if index := strings.Index(value, ":"); index >= 0 {
			value = value[index+1:]
		}
	}
	value = strings.TrimSuffix(strings.Trim(value, "/"), ".git")
	parts := strings.Split(strings.ToLower(value), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return "", ErrInvalidRepository
	}
	for _, part := range parts {
		if strings.ContainsAny(part, "@: \t\\?#") {
			return "", ErrInvalidRepository
		}
	}
	return parts[0] + "/" + parts[1], nil
}
