package scm

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
)

func TestBrokerMintsRepositoryScopedToken(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryBrokerStore()
	store.allow("org-1", "acme/widgets", 55, 900)
	broker := newTestBroker(t, fake, store)

	token, err := broker.BrokerToken(context.Background(), BrokerRequest{
		OrgID:       "org-1",
		UserID:      "user-1",
		Repository:  "Acme/Widgets",
		Purpose:     domain.TokenPurposeClone,
		WorkspaceID: "workspace-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if token.Repository != "acme/widgets" || token.ExternalInstallationID != 55 {
		t.Fatalf("token = %#v", token)
	}
	if !strings.HasPrefix(token.Token.Reveal(), "ghs_installation_token_") {
		t.Fatal("broker did not return the minted credential")
	}
	if token.BotLogin != "ao-cloud[bot]" {
		t.Fatalf("bot login = %q", token.BotLogin)
	}

	minted := fake.minted()
	if len(minted) != 1 {
		t.Fatalf("minted %d tokens", len(minted))
	}
	if len(minted[0].RepositoryIDs) != 1 || minted[0].RepositoryIDs[0] != 900 {
		t.Fatalf("token was not narrowed to one repository: %#v", minted[0].RepositoryIDs)
	}
	if minted[0].InstallationID != "55" {
		t.Fatalf("token minted against installation %q", minted[0].InstallationID)
	}
	// Clone credentials must not be able to push.
	if minted[0].Permissions["contents"] != "read" {
		t.Fatalf("clone permissions = %#v", minted[0].Permissions)
	}
	if _, ok := minted[0].Permissions["pull_requests"]; ok {
		t.Fatalf("clone credential requested pull-request access: %#v", minted[0].Permissions)
	}
	if !strings.HasPrefix(minted[0].Authorization, "Bearer ") {
		t.Fatalf("app assertion was not presented: %q", minted[0].Authorization)
	}

	if store.grantCount() != 1 {
		t.Fatal("brokered credential was not recorded in the audit ledger")
	}
	grant := store.grants[0]
	if grant.Purpose != domain.TokenPurposeClone || grant.WorkspaceID != "workspace-1" ||
		grant.RequestedByUserID != "user-1" || grant.ExpiresAt.IsZero() {
		t.Fatalf("grant = %#v", grant)
	}
}

func TestBrokerPushCredentialCarriesWriteScope(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryBrokerStore()
	store.allow("org-1", "acme/widgets", 55, 900)
	broker := newTestBroker(t, fake, store)

	if _, err := broker.BrokerToken(context.Background(), BrokerRequest{
		OrgID: "org-1", UserID: "user-1", Repository: "acme/widgets", Purpose: domain.TokenPurposePush,
	}); err != nil {
		t.Fatal(err)
	}
	permissions := fake.minted()[0].Permissions
	if permissions["contents"] != "write" || permissions["pull_requests"] != "write" {
		t.Fatalf("push permissions = %#v", permissions)
	}
}

func TestBrokerRefusesRepositoryOutsideAllowlist(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryBrokerStore()
	store.allow("org-1", "acme/widgets", 55, 900)
	broker := newTestBroker(t, fake, store)

	cases := []struct {
		name       string
		request    BrokerRequest
		wantErr    error
		wantMinted bool
	}{
		{
			name:    "repository not allowlisted",
			request: BrokerRequest{OrgID: "org-1", UserID: "user-1", Repository: "acme/secrets", Purpose: "clone"},
			wantErr: ErrRepositoryNotAllowed,
		},
		{
			name:    "another tenant cannot reach the allowlist",
			request: BrokerRequest{OrgID: "org-2", UserID: "user-2", Repository: "acme/widgets", Purpose: "clone"},
			wantErr: ErrRepositoryNotAllowed,
		},
		{
			name:    "unparseable repository",
			request: BrokerRequest{OrgID: "org-1", UserID: "user-1", Repository: "not-a-repo", Purpose: "clone"},
			wantErr: ErrInvalidRepository,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := broker.BrokerToken(context.Background(), testCase.request)
			if !errors.Is(err, testCase.wantErr) {
				t.Fatalf("error = %v, want %v", err, testCase.wantErr)
			}
		})
	}
	if len(fake.minted()) != 0 {
		t.Fatal("a credential was minted for a denied request")
	}
	if store.grantCount() != 0 {
		t.Fatal("a denied request wrote an audit grant")
	}
}

func TestBrokerRejectsUnknownPurpose(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryBrokerStore()
	store.allow("org-1", "acme/widgets", 55, 900)
	broker := newTestBroker(t, fake, store)

	if _, err := broker.BrokerToken(context.Background(), BrokerRequest{
		OrgID: "org-1", UserID: "user-1", Repository: "acme/widgets", Purpose: "admin",
	}); err == nil {
		t.Fatal("an unknown purpose was accepted")
	}
	if len(fake.minted()) != 0 {
		t.Fatal("a credential was minted for an unknown purpose")
	}
}

func TestBrokerRefusesSuspendedInstallation(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryBrokerStore()
	store.allow("org-1", "acme/widgets", 55, 900)
	store.setInstallationStatus(55, domain.InstallationStatusSuspended)
	broker := newTestBroker(t, fake, store)

	_, err := broker.BrokerToken(context.Background(), BrokerRequest{
		OrgID: "org-1", UserID: "user-1", Repository: "acme/widgets", Purpose: "clone",
	})
	if !errors.Is(err, ErrInstallationInactive) {
		t.Fatalf("error = %v", err)
	}
	if len(fake.minted()) != 0 {
		t.Fatal("a suspended installation still minted a credential")
	}
}

func TestBrokerReusesLiveTokenAndReMintsNearExpiry(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryBrokerStore()
	store.allow("org-1", "acme/widgets", 55, 900)
	broker := newTestBroker(t, fake, store)

	now := time.Now().UTC()
	broker.now = func() time.Time { return now }

	request := BrokerRequest{OrgID: "org-1", UserID: "user-1", Repository: "acme/widgets", Purpose: "clone"}
	first, err := broker.BrokerToken(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	second, err := broker.BrokerToken(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if first.Token.Reveal() != second.Token.Reveal() || len(fake.minted()) != 1 {
		t.Fatal("a live credential was re-minted instead of reused")
	}

	// Inside the refresh margin the cached credential must be abandoned even
	// though it has not technically expired yet.
	now = first.ExpiresAt.Add(-tokenRefreshMargin + time.Second)
	third, err := broker.BrokerToken(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if third.Token.Reveal() == first.Token.Reveal() || len(fake.minted()) != 2 {
		t.Fatal("a credential inside the refresh margin was reused")
	}

	// A different purpose is a different credential, never a cache hit.
	if _, err := broker.BrokerToken(context.Background(), BrokerRequest{
		OrgID: "org-1", UserID: "user-1", Repository: "acme/widgets", Purpose: "push",
	}); err != nil {
		t.Fatal(err)
	}
	if len(fake.minted()) != 3 {
		t.Fatal("a push credential was served from the clone cache")
	}
}

func TestBrokerInvalidateForcesReMint(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryBrokerStore()
	store.allow("org-1", "acme/widgets", 55, 900)
	broker := newTestBroker(t, fake, store)

	request := BrokerRequest{OrgID: "org-1", UserID: "user-1", Repository: "acme/widgets", Purpose: "clone"}
	first, err := broker.BrokerToken(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	broker.Invalidate(first.ExternalInstallationID, first.ExternalRepositoryID, first.Purpose)
	second, err := broker.BrokerToken(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if first.Token.Reveal() == second.Token.Reveal() {
		t.Fatal("invalidated credential was served again")
	}
}

func TestBrokerFailsWhenGrantCannotBeAudited(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryBrokerStore()
	store.allow("org-1", "acme/widgets", 55, 900)
	store.grantErr = errors.New("ledger unavailable")
	broker := newTestBroker(t, fake, store)

	if _, err := broker.BrokerToken(context.Background(), BrokerRequest{
		OrgID: "org-1", UserID: "user-1", Repository: "acme/widgets", Purpose: "clone",
	}); err == nil {
		t.Fatal("an unauditable credential was returned")
	}
}

func TestBrokerScopesLookupToRequestedTenant(t *testing.T) {
	fake := newFakeGitHub(t)
	store := newMemoryBrokerStore()
	store.allow("org-1", "acme/widgets", 55, 900)
	broker := newTestBroker(t, fake, store)

	if _, err := broker.BrokerToken(context.Background(), BrokerRequest{
		OrgID: "org-1", UserID: "user-9", Repository: "acme/widgets", Purpose: "clone",
	}); err != nil {
		t.Fatal(err)
	}
	if len(store.tenants) != 1 || (store.tenants[0] != postgres.SCMTenant{OrgID: "org-1", UserID: "user-9"}) {
		t.Fatalf("allowlist lookup ran under %#v", store.tenants)
	}
}

func TestNormalizeRepository(t *testing.T) {
	cases := []struct {
		input string
		want  string
		valid bool
	}{
		{input: "Acme/Widgets", want: "acme/widgets", valid: true},
		{input: " acme/widgets ", want: "acme/widgets", valid: true},
		{input: "https://github.com/Acme/Widgets.git", want: "acme/widgets", valid: true},
		{input: "https://github.com/acme/widgets", want: "acme/widgets", valid: true},
		{input: "git@github.com:Acme/Widgets.git", want: "acme/widgets", valid: true},
		{input: "acme/widgets/extra"},
		{input: "acme"},
		{input: ""},
		{input: "acme/"},
		{input: "/widgets"},
		{input: "acme/wid gets"},
	}
	for _, testCase := range cases {
		got, err := NormalizeRepository(testCase.input)
		if testCase.valid {
			if err != nil || got != testCase.want {
				t.Fatalf("NormalizeRepository(%q) = %q, %v", testCase.input, got, err)
			}
			continue
		}
		if err == nil {
			t.Fatalf("NormalizeRepository(%q) = %q, want an error", testCase.input, got)
		}
	}
}
