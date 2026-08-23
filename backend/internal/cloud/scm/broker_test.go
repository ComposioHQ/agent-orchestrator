package scm

import (
	"context"
	"errors"
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
}

func (m *minterStub) MintInstallationToken(_ context.Context, _, _ int64, permissions map[string]string) ([]byte, time.Time, error) {
	m.calls++
	m.permissions = append(m.permissions, permissions)
	token := []byte{byte(m.calls), 2, 3, 4}
	m.tokens = append(m.tokens, token)
	return token, time.Now().Add(time.Hour), nil
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
