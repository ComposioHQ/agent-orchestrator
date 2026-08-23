package scm

import (
	"context"
	"encoding/json"
	"log/slog"
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

// String, GoString, LogValue, and MarshalJSON make accidental diagnostic or
// transport exposure safe. Bootstrap code must deliberately read Token; no
// generic formatter or serializer can reveal it.
func (Credential) String() string { return "[redacted scm credential]" }

// GoString returns a redacted representation for Go-syntax formatting.
func (Credential) GoString() string { return "scm.Credential{[redacted]}" }

// LogValue returns a redacted structured-logging value.
func (Credential) LogValue() slog.Value {
	return slog.StringValue("[redacted scm credential]")
}

// MarshalJSON serializes only non-secret metadata and a redaction marker.
func (c Credential) MarshalJSON() ([]byte, error) {
	return json.Marshal(struct {
		Username   string    `json:"username"`
		Token      string    `json:"token"`
		ExpiresAt  time.Time `json:"expiresAt"`
		Repository string    `json:"repository"`
	}{c.Username, "[redacted]", c.ExpiresAt, c.Repository})
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

// CredentialIssuer is the narrow contract the compute plane consumes only
// during sandbox bootstrap. It intentionally has no general token or push
// method: the clone credential cannot become a session-long secret channel.
type CredentialIssuer interface {
	// IssueCloneCredential mints a read-only credential for the initial
	// checkout. repoURL may be a clone URL or an owner/name pair.
	IssueCloneCredential(ctx context.Context, identity tenant.Identity, repoURL, sandboxID string) (Credential, error)
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
