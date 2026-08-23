package scm

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

var testIdentity = tenant.Identity{OrgID: "org-1", OrgSlug: "acme", UserID: "user-1", Role: "owner"}

func TestIssueCloneCredentialIsReadOnlyAndRepositoryScoped(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryBrokerStore()
	store.allow("org-1", "acme/widgets", 55, 900)
	broker := newTestBroker(t, fake, store)

	credential, err := broker.IssueCloneCredential(
		context.Background(), testIdentity, "https://github.com/Acme/Widgets.git", "sandbox-abc",
	)
	if err != nil {
		t.Fatal(err)
	}
	if credential.Username != CloneUsername || credential.Repository != "acme/widgets" {
		t.Fatalf("credential = %#v", credential)
	}
	if !bytes.HasPrefix(credential.Token, []byte("ghs_installation_token_")) {
		t.Fatal("credential does not carry the minted token")
	}
	if credential.ExpiresAt.IsZero() {
		t.Fatal("credential has no expiry")
	}

	minted := fake.minted()
	if len(minted) != 1 || len(minted[0].RepositoryIDs) != 1 || minted[0].RepositoryIDs[0] != 900 {
		t.Fatalf("credential was not narrowed to one repository: %#v", minted)
	}
	// A bootstrap credential must not be able to push.
	if minted[0].Permissions["contents"] != "read" {
		t.Fatalf("clone permissions = %#v", minted[0].Permissions)
	}
	// The sandbox that received it is recorded, so a leak is traceable.
	if store.grants[0].SandboxID != "sandbox-abc" || store.grants[0].Purpose != "clone" {
		t.Fatalf("grant = %#v", store.grants[0])
	}
}

func TestIssuePushCredentialIsSeparateAndWriteScoped(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryBrokerStore()
	store.allow("org-1", "acme/widgets", 55, 900)
	broker := newTestBroker(t, fake, store)

	if _, err := broker.IssueCloneCredential(context.Background(), testIdentity, "acme/widgets", "sandbox-abc"); err != nil {
		t.Fatal(err)
	}
	credential, err := broker.IssuePushCredential(context.Background(), testIdentity, "acme/widgets", "sandbox-abc")
	if err != nil {
		t.Fatal(err)
	}
	minted := fake.minted()
	// A push must be its own mint, never served from the clone credential's
	// cache: that is what keeps the read-only bootstrap credential read-only.
	if len(minted) != 2 {
		t.Fatalf("minted %d credentials", len(minted))
	}
	if minted[1].Permissions["contents"] != "write" || minted[1].Permissions["pull_requests"] != "write" {
		t.Fatalf("push permissions = %#v", minted[1].Permissions)
	}
	if credential.Repository != "acme/widgets" {
		t.Fatalf("credential = %#v", credential)
	}
	if len(store.grants) != 2 || store.grants[1].Purpose != "push" {
		t.Fatalf("grants = %#v", store.grants)
	}
}

func TestIssueCredentialRefusesAnUnscopedIdentity(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryBrokerStore()
	store.allow("org-1", "acme/widgets", 55, 900)
	broker := newTestBroker(t, fake, store)

	for _, identity := range []tenant.Identity{
		{},
		{OrgID: "org-1"},
		{UserID: "user-1"},
	} {
		if _, err := broker.IssueCloneCredential(
			context.Background(), identity, "acme/widgets", "sandbox-abc",
		); !errors.Is(err, tenant.ErrNoTenant) {
			t.Fatalf("identity %#v produced error %v", identity, err)
		}
	}
	if len(fake.minted()) != 0 {
		t.Fatal("a credential was minted without a tenant scope")
	}
}

func TestIssueCredentialRefusesARepositoryOutsideTheAllowlist(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryBrokerStore()
	store.allow("org-1", "acme/widgets", 55, 900)
	broker := newTestBroker(t, fake, store)

	if _, err := broker.IssueCloneCredential(
		context.Background(), testIdentity, "acme/secrets", "sandbox-abc",
	); !errors.Is(err, ErrRepositoryNotAllowed) {
		t.Fatalf("error = %v", err)
	}
	// Another organization cannot reach this organization's allowlist.
	foreign := tenant.Identity{OrgID: "org-2", UserID: "user-2"}
	if _, err := broker.IssueCloneCredential(
		context.Background(), foreign, "acme/widgets", "sandbox-abc",
	); !errors.Is(err, ErrRepositoryNotAllowed) {
		t.Fatalf("error = %v", err)
	}
	if len(fake.minted()) != 0 {
		t.Fatal("a credential was minted for a denied request")
	}
}

func TestCredentialZeroErasesTheToken(t *testing.T) {
	token := []byte("ghs_super_secret_installation_token")
	backing := token
	credential := Credential{Username: CloneUsername, Token: token}

	credential.Zero()

	if credential.Token != nil {
		t.Fatal("Zero left the token slice in place")
	}
	// The compute plane relies on the erase happening in the original backing
	// array, not on a copy: a string would have made that impossible.
	for _, b := range backing {
		if b != 0 {
			t.Fatalf("Zero did not erase the backing array: %q", backing)
		}
	}
}

func TestCredentialExpiry(t *testing.T) {
	expires := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	credential := Credential{ExpiresAt: expires}
	if credential.Expired(expires.Add(-time.Second)) {
		t.Fatal("a live credential reported as expired")
	}
	if !credential.Expired(expires) {
		t.Fatal("a credential at its expiry instant was still considered live")
	}
	if !credential.Expired(expires.Add(time.Second)) {
		t.Fatal("an expired credential reported as live")
	}
}

func TestBrokerSatisfiesTheCredentialIssuerContract(t *testing.T) {
	fake := newFakeGitHub(t)
	broker := newTestBroker(t, fake, newMemoryBrokerStore())
	var issuer CredentialIssuer = broker
	if issuer == nil {
		t.Fatal("Broker no longer satisfies CredentialIssuer")
	}
}

// A write credential must never be served from cache: it is minted on demand
// for one push, so two pushes are two audited mints.
func TestPushCredentialsAreNeverCached(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryBrokerStore()
	store.allow("org-1", "acme/widgets", 55, 900)
	broker := newTestBroker(t, fake, store)

	first, err := broker.IssuePushCredential(context.Background(), testIdentity, "acme/widgets", "sandbox-abc")
	if err != nil {
		t.Fatal(err)
	}
	second, err := broker.IssuePushCredential(context.Background(), testIdentity, "acme/widgets", "sandbox-abc")
	if err != nil {
		t.Fatal(err)
	}
	if len(fake.minted()) != 2 {
		t.Fatalf("minted %d credentials for two pushes", len(fake.minted()))
	}
	if bytes.Equal(first.Token, second.Token) {
		t.Fatal("a push credential was reused across pushes")
	}
	if len(store.grants) != 2 {
		t.Fatalf("two pushes produced %d audit grants", len(store.grants))
	}
}
