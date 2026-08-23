package scm

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// CloneUsername is the fixed username GitHub expects alongside an installation
// access token.
const CloneUsername = "x-access-token"

// Credential is one short-lived, repository-scoped Git credential handed to a
// sandbox at bootstrap.
//
// Token is a byte slice rather than a string so the compute plane can zero it
// after the clone: Go strings are immutable and a leaked copy would survive
// until the garbage collector happened to reclaim it. The contract with the
// compute plane is that the token is written 0600, used once, then deleted and
// zeroed — it is never persisted in the sandbox and never placed on argv.
type Credential struct {
	Username   string
	Token      []byte
	ExpiresAt  time.Time
	Repository string
}

// Zero overwrites the token in place. Call it as soon as the credential has
// been handed to git.
func (c *Credential) Zero() {
	for index := range c.Token {
		c.Token[index] = 0
	}
	c.Token = nil
}

// Expired reports whether the credential can still be used. The compute plane
// checks this before reusing a bootstrap credential and asks for a fresh one
// rather than retrying with a dead token.
func (c Credential) Expired(now time.Time) bool {
	return !now.UTC().Before(c.ExpiresAt)
}

// CredentialIssuer is the contract the compute plane consumes at sandbox
// bootstrap and, for a later push, over the authenticated runtime listener.
//
// Nothing here returns a credential that outlives the operation it was minted
// for: a clone credential cannot push, and a push credential is obtained on
// demand rather than kept for the session's lifetime.
type CredentialIssuer interface {
	// IssueCloneCredential mints a read-only credential for the initial
	// checkout. repoURL may be a clone URL or an owner/name pair.
	IssueCloneCredential(ctx context.Context, identity tenant.Identity, repoURL, sandboxID string) (Credential, error)
	// IssuePushCredential mints a write credential for one push. It is called
	// on demand, never at bootstrap, so a compromised sandbox that never
	// legitimately pushes has no write capability at all.
	IssuePushCredential(ctx context.Context, identity tenant.Identity, repoURL, sandboxID string) (Credential, error)
}

// Broker implements CredentialIssuer.
var _ CredentialIssuer = (*Broker)(nil)

// IssueCloneCredential mints a read-only, repository-scoped checkout
// credential for one sandbox.
func (b *Broker) IssueCloneCredential(
	ctx context.Context,
	identity tenant.Identity,
	repoURL, sandboxID string,
) (Credential, error) {
	return b.issue(ctx, identity, repoURL, sandboxID, domain.TokenPurposeClone)
}

// IssuePushCredential mints a write-scoped credential for one push.
func (b *Broker) IssuePushCredential(
	ctx context.Context,
	identity tenant.Identity,
	repoURL, sandboxID string,
) (Credential, error) {
	return b.issue(ctx, identity, repoURL, sandboxID, domain.TokenPurposePush)
}

func (b *Broker) issue(
	ctx context.Context,
	identity tenant.Identity,
	repoURL, sandboxID, purpose string,
) (Credential, error) {
	if !identity.Valid() {
		return Credential{}, tenant.ErrNoTenant
	}
	token, err := b.BrokerToken(ctx, BrokerRequest{
		OrgID:      identity.OrgID,
		UserID:     identity.UserID,
		Repository: repoURL,
		Purpose:    purpose,
		SandboxID:  sandboxID,
	})
	if err != nil {
		return Credential{}, err
	}
	return Credential{
		Username:   CloneUsername,
		Token:      []byte(token.Token.Reveal()),
		ExpiresAt:  token.ExpiresAt,
		Repository: token.Repository,
	}, nil
}
