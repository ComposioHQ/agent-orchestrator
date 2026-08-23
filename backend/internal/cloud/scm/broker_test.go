package scm

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

type brokerStoreStub struct {
	installation domain.SCMInstallation
	repository   domain.SCMRepository
	grants       []domain.SCMTokenGrant
	grantErr     error
}

func (s *brokerStoreStub) AllowedSCMRepository(context.Context, tenant.Identity, string) (domain.SCMInstallation, domain.SCMRepository, error) {
	return s.installation, s.repository, nil
}
func (s *brokerStoreStub) RecordSCMTokenGrant(_ context.Context, _ tenant.Identity, grant domain.SCMTokenGrant) error {
	if s.grantErr != nil {
		return s.grantErr
	}
	s.grants = append(s.grants, grant)
	return nil
}

type minterStub struct {
	calls       int
	permissions []map[string]string
	tokens      [][]byte
	token       []byte
	expiresAt   time.Time
}

func (m *minterStub) MintInstallationToken(_ context.Context, _, _ int64, permissions map[string]string) ([]byte, time.Time, error) {
	m.calls++
	m.permissions = append(m.permissions, permissions)
	token := append([]byte(nil), m.token...)
	if m.token == nil {
		token = []byte{byte(m.calls), 2, 3, 4}
	}
	expiresAt := m.expiresAt
	if expiresAt.IsZero() {
		expiresAt = time.Now().Add(time.Hour)
	}
	m.tokens = append(m.tokens, token)
	return token, expiresAt, nil
}

func newBrokerTest(t *testing.T) (*Broker, *brokerStoreStub, *minterStub) {
	t.Helper()
	store := &brokerStoreStub{
		installation: domain.SCMInstallation{ID: "installation", OrgID: "org", ExternalInstallationID: 11, Status: domain.InstallationStatusActive},
		repository:   domain.SCMRepository{ID: "repository", ExternalRepositoryID: 22, FullName: "acme/widgets", Allowed: true},
	}
	minter := &minterStub{}
	broker, err := NewBroker(store, minter)
	if err != nil {
		t.Fatal(err)
	}
	return broker, store, minter
}

func TestBrokerCredentialsAreFreshAuditedAndZeroed(t *testing.T) {
	broker, store, minter := newBrokerTest(t)
	identity := tenant.Identity{OrgID: "org", UserID: "user"}
	var cloneBytes, pushBytes []byte
	if err := broker.WithCloneCredential(context.Background(), identity, "https://github.com/acme/widgets.git", "sandbox", func(credential *Credential) error {
		cloneBytes = credential.Token
		if credential.Repository != "https://github.com/acme/widgets.git" {
			t.Fatalf("clone target = %q", credential.Repository)
		}
		if credential.Token[0] != 1 {
			t.Fatalf("clone token = %v", credential.Token)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := broker.WithPushCredential(context.Background(), identity, "acme/widgets", "sandbox", func(credential *Credential) error {
		pushBytes = credential.Token
		if credential.Token[0] != 2 {
			t.Fatalf("push token = %v", credential.Token)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if minter.calls != 2 || len(store.grants) != 2 || store.grants[0].Purpose != domain.TokenPurposeClone || store.grants[1].Purpose != domain.TokenPurposePush {
		t.Fatalf("calls = %d, grants = %#v", minter.calls, store.grants)
	}
	if minter.permissions[0]["contents"] != "read" || minter.permissions[0]["pull_requests"] != "" {
		t.Fatalf("clone permissions = %#v", minter.permissions[0])
	}
	if minter.permissions[1]["contents"] != "write" || minter.permissions[1]["pull_requests"] != "write" {
		t.Fatalf("push permissions = %#v", minter.permissions[1])
	}
	for _, value := range append(cloneBytes, pushBytes...) {
		if value != 0 {
			t.Fatalf("credential bytes survived callback: %v %v", cloneBytes, pushBytes)
		}
	}
}

func TestBrokerRejectsInvalidSandboxBeforeMintOrAudit(t *testing.T) {
	for _, sandboxID := range []string{"", strings.Repeat("s", maxSandboxIDRunes+1), "sandbox\ncontrol", " sandbox"} {
		broker, store, minter := newBrokerTest(t)
		err := broker.WithCloneCredential(context.Background(), tenant.Identity{OrgID: "org", UserID: "user"}, "acme/widgets", sandboxID, func(*Credential) error { return nil })
		if err == nil || minter.calls != 0 || len(store.grants) != 0 {
			t.Fatalf("sandbox=%q error=%v calls=%d grants=%d", sandboxID, err, minter.calls, len(store.grants))
		}
	}
}

func TestBrokerRejectsUnusableMintedToken(t *testing.T) {
	cases := []struct {
		name      string
		token     []byte
		expiresAt time.Time
	}{
		{name: "empty token", token: []byte{}, expiresAt: time.Now().Add(time.Hour)},
		{name: "expired token", token: []byte("expired"), expiresAt: time.Now().Add(-time.Second)},
		{name: "zero expiry", token: []byte("zero"), expiresAt: time.Unix(1, 0)},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			broker, store, minter := newBrokerTest(t)
			minter.token = testCase.token
			minter.expiresAt = testCase.expiresAt
			used := false
			err := broker.WithCloneCredential(context.Background(), tenant.Identity{OrgID: "org", UserID: "user"}, "acme/widgets", "sandbox", func(*Credential) error { used = true; return nil })
			if err == nil || used || len(store.grants) != 0 {
				t.Fatalf("error=%v used=%v grants=%d", err, used, len(store.grants))
			}
			for _, value := range minter.tokens[0] {
				if value != 0 {
					t.Fatalf("rejected token not zeroed: %v", minter.tokens[0])
				}
			}
		})
	}
}

func TestNormalizeRepositoryAllowsOnlyCanonicalGitHubTargets(t *testing.T) {
	valid := []string{
		"Acme/Widgets",
		"https://github.com/Acme/Widgets.git",
		"git@github.com:Acme/Widgets.git",
		"ssh://git@github.com/Acme/Widgets.git",
	}
	for _, input := range valid {
		if normalized, err := NormalizeRepository(input); err != nil || normalized != "acme/widgets" {
			t.Fatalf("input=%q normalized=%q error=%v", input, normalized, err)
		}
	}
	invalid := []string{
		"https://evil.example/acme/widgets.git",
		"git@evil.example:acme/widgets.git",
		"https://github.com.evil.example/acme/widgets.git",
		"http://github.com/acme/widgets.git",
		"https://github.com/acme/widgets.git?token=leak",
		"ssh://root@github.com/acme/widgets.git",
	}
	for _, input := range invalid {
		if normalized, err := NormalizeRepository(input); err == nil {
			t.Fatalf("input=%q unexpectedly normalized to %q", input, normalized)
		}
	}
}

func TestBrokerDoesNotDeliverUnauditedCredential(t *testing.T) {
	broker, store, minter := newBrokerTest(t)
	store.grantErr = errors.New("audit unavailable")
	used := false
	err := broker.WithPushCredential(context.Background(), tenant.Identity{OrgID: "org", UserID: "user"}, "acme/widgets", "sandbox", func(*Credential) error {
		used = true
		return nil
	})
	if err == nil || used || minter.calls != 1 {
		t.Fatalf("error = %v, used = %v, calls = %d", err, used, minter.calls)
	}
	for _, value := range minter.tokens[0] {
		if value != 0 {
			t.Fatalf("unaudited token was not zeroed: %v", minter.tokens[0])
		}
	}
}
