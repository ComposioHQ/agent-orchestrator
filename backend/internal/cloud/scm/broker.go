package scm

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

var permissionsByPurpose = map[string]map[string]string{
	domain.TokenPurposeClone: {"contents": "read", "metadata": "read"},
	domain.TokenPurposePush:  {"contents": "write", "metadata": "read", "pull_requests": "write"},
}

type BrokerStore interface {
	AllowedSCMRepository(context.Context, tenant.Identity, string) (domain.SCMInstallation, domain.SCMRepository, error)
	RecordSCMTokenGrant(context.Context, tenant.Identity, domain.SCMTokenGrant) error
}

type InstallationTokenMinter interface {
	MintInstallationToken(context.Context, int64, int64, map[string]string) ([]byte, time.Time, error)
}

type Broker struct {
	store  BrokerStore
	minter InstallationTokenMinter
}

func NewBroker(store BrokerStore, minter InstallationTokenMinter) (*Broker, error) {
	if store == nil || minter == nil {
		return nil, errors.New("cloud scm: broker requires store and token minter")
	}
	return &Broker{store: store, minter: minter}, nil
}

// WithCloneCredential is the bootstrap-only delivery seam. A fresh read-only
// token exists only for the callback and is overwritten before return.
func (b *Broker) WithCloneCredential(ctx context.Context, identity tenant.Identity, repository, sandboxID string, use func(*Credential) error) error {
	return b.withCredential(ctx, identity, repository, sandboxID, domain.TokenPurposeClone, use)
}

// WithPushCredential mints and audits a fresh uncached write token for exactly
// one operation. pull_requests:write is always requested alongside contents.
func (b *Broker) WithPushCredential(ctx context.Context, identity tenant.Identity, repository, sandboxID string, use func(*Credential) error) error {
	return b.withCredential(ctx, identity, repository, sandboxID, domain.TokenPurposePush, use)
}

func (b *Broker) withCredential(ctx context.Context, identity tenant.Identity, repository, sandboxID, purpose string, use func(*Credential) error) error {
	if !identity.Valid() {
		return tenant.ErrNoTenant
	}
	if use == nil {
		return errors.New("cloud scm: credential callback is required")
	}
	normalized, err := NormalizeRepository(repository)
	if err != nil {
		return err
	}
	installation, allowed, err := b.store.AllowedSCMRepository(ctx, identity, normalized)
	if err != nil {
		return err
	}
	if !allowed.Allowed {
		return ErrRepositoryNotAllowed
	}
	if installation.Status != domain.InstallationStatusActive {
		return ErrInstallationInactive
	}
	permissions := permissionsByPurpose[purpose]
	token, expiresAt, err := b.minter.MintInstallationToken(ctx, installation.ExternalInstallationID, allowed.ExternalRepositoryID, clonePermissions(permissions))
	if err != nil {
		return err
	}
	credential := Credential{Username: CloneUsername, Token: token, ExpiresAt: expiresAt.UTC(), Repository: allowed.FullName}
	defer credential.Zero()
	if err := b.store.RecordSCMTokenGrant(ctx, identity, domain.SCMTokenGrant{
		OrgID: installation.OrgID, InstallationID: installation.ID, RepositoryID: allowed.ID,
		SandboxID: strings.TrimSpace(sandboxID), Purpose: purpose,
		RequestedByUserID: identity.UserID, ExpiresAt: expiresAt.UTC(),
	}); err != nil {
		return err
	}
	return use(&credential)
}

func clonePermissions(source map[string]string) map[string]string {
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

func NormalizeRepository(reference string) (string, error) {
	value := strings.TrimSpace(reference)
	if index := strings.Index(value, "://"); index >= 0 {
		value = value[index+3:]
		if slash := strings.IndexByte(value, '/'); slash >= 0 {
			value = value[slash+1:]
		}
	} else if strings.HasPrefix(value, "git@") {
		if colon := strings.IndexByte(value, ':'); colon >= 0 {
			value = value[colon+1:]
		}
	}
	value = strings.TrimSuffix(strings.Trim(value, "/"), ".git")
	parts := strings.Split(strings.ToLower(value), "/")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" || strings.ContainsAny(value, "@ :\\?#\t") {
		return "", ErrInvalidRepository
	}
	return parts[0] + "/" + parts[1], nil
}
