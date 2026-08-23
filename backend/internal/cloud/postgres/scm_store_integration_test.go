package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// scmTestTenant is one signed-in user plus their personal organization.
type scmTestTenant struct {
	identity  tenant.Identity
	principal domain.Principal
}

func newSCMIntegrationStore(t *testing.T) *Store {
	t.Helper()
	runtimeURL := os.Getenv("AO_CLOUD_TEST_DATABASE_URL")
	migrationURL := os.Getenv("AO_CLOUD_TEST_MIGRATION_DATABASE_URL")
	runtimeRole := os.Getenv("AO_CLOUD_TEST_RUNTIME_DATABASE_ROLE")
	if runtimeURL == "" || migrationURL == "" || runtimeRole == "" {
		t.Skip("set AO_CLOUD_TEST_DATABASE_URL, AO_CLOUD_TEST_MIGRATION_DATABASE_URL, and AO_CLOUD_TEST_RUNTIME_DATABASE_ROLE")
	}
	ctx := context.Background()
	if err := EnsureRuntimeRole(ctx, migrationURL, runtimeRole, "integration-runtime-password"); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, migrationURL, runtimeRole); err != nil {
		t.Fatal(err)
	}
	store, err := Open(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	return store
}

func signUp(t *testing.T, store *Store, externalID, email string) scmTestTenant {
	t.Helper()
	ctx := context.Background()
	principal, err := store.UpsertGoogleUser(ctx, domain.Principal{
		Provider:    "google",
		ExternalID:  externalID,
		Email:       email,
		DisplayName: externalID,
	})
	if err != nil {
		t.Fatal(err)
	}
	memberships, err := store.ListMemberships(ctx, principal)
	if err != nil {
		t.Fatal(err)
	}
	if len(memberships) == 0 {
		t.Fatalf("%s has no organization", externalID)
	}
	return scmTestTenant{
		identity:  tenant.Identity{OrgID: memberships[0].OrgID, UserID: principal.UserID},
		principal: principal,
	}
}

func linkInstallation(t *testing.T, store *Store, tenant scmTestTenant, externalID int64, login string) domain.SCMInstallation {
	t.Helper()
	installation, err := store.UpsertSCMInstallation(context.Background(), tenant.identity, domain.SCMInstallation{
		ExternalInstallationID: externalID,
		AccountLogin:           login,
		AccountType:            "Organization",
		AppSlug:                "ao-cloud",
		RepositorySelection:    "selected",
		Status:                 domain.InstallationStatusActive,
	})
	if err != nil {
		t.Fatal(err)
	}
	return installation
}

func TestSCMInstallationsAreIsolatedByRowLevelSecurity(t *testing.T) {
	store := newSCMIntegrationStore(t)
	ctx := context.Background()
	alice := signUp(t, store, "scm-alice", "scm-alice@example.com")
	bob := signUp(t, store, "scm-bob", "scm-bob@example.com")

	installation := linkInstallation(t, store, alice, 910001, "alice-org")
	if err := store.SyncSCMRepositories(ctx, alice.identity, installation.ID, []domain.SCMRepository{
		{ExternalRepositoryID: 920001, FullName: "alice-org/widgets", Private: true},
	}, true); err != nil {
		t.Fatal(err)
	}

	// Bob cannot see, read, or destroy Alice's installation even though he
	// knows its primary key.
	installations, err := store.ListSCMInstallations(ctx, bob.identity)
	if err != nil {
		t.Fatal(err)
	}
	for _, visible := range installations {
		if visible.ID == installation.ID {
			t.Fatal("a foreign installation was visible across tenants")
		}
	}
	if _, err := store.SCMInstallationByID(ctx, bob.identity, installation.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant read error = %v", err)
	}
	if _, err := store.ListSCMRepositories(ctx, bob.identity, installation.ID); err != nil {
		t.Fatal(err)
	} else if repositories, _ := store.ListSCMRepositories(ctx, bob.identity, installation.ID); len(repositories) != 0 {
		t.Fatalf("a foreign allowlist was visible: %#v", repositories)
	}
	if err := store.DeleteSCMInstallation(ctx, bob.identity, installation.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant delete error = %v", err)
	}

	// Alice still has hers.
	if _, err := store.SCMInstallationByID(ctx, alice.identity, installation.ID); err != nil {
		t.Fatal(err)
	}

	// Claiming an installation already linked elsewhere must conflict, not
	// silently repoint it.
	if _, err := store.UpsertSCMInstallation(ctx, bob.identity, domain.SCMInstallation{
		ExternalInstallationID: 910001,
		AccountLogin:           "bob-org",
		AccountType:            "Organization",
		RepositorySelection:    "selected",
		Status:                 domain.InstallationStatusActive,
	}); err == nil {
		t.Fatal("an installation was re-linked into another organization")
	}
	refreshed, err := store.SCMInstallationByID(ctx, alice.identity, installation.ID)
	if err != nil || refreshed.AccountLogin != "alice-org" {
		t.Fatalf("installation = %#v, %v", refreshed, err)
	}
}

func TestSCMAllowlistGatesTheBrokerLookup(t *testing.T) {
	store := newSCMIntegrationStore(t)
	ctx := context.Background()
	alice := signUp(t, store, "scm-allow-alice", "scm-allow-alice@example.com")
	bob := signUp(t, store, "scm-allow-bob", "scm-allow-bob@example.com")
	installation := linkInstallation(t, store, alice, 910002, "alice-allow")

	// Sync without allowing: visible, but not brokerable.
	if err := store.SyncSCMRepositories(ctx, alice.identity, installation.ID, []domain.SCMRepository{
		{ExternalRepositoryID: 920002, FullName: "alice-allow/widgets"},
		{ExternalRepositoryID: 920003, FullName: "alice-allow/docs"},
	}, false); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.AllowedSCMRepository(ctx, alice.identity, "alice-allow/widgets"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a repository resolved before it was allowlisted: %v", err)
	}

	if err := store.SetSCMRepositoryAllowlist(ctx, alice.identity, installation.ID, []int64{920002}); err != nil {
		t.Fatal(err)
	}
	resolved, repository, err := store.AllowedSCMRepository(ctx, alice.identity, "alice-allow/widgets")
	if err != nil {
		t.Fatal(err)
	}
	if resolved.ExternalInstallationID != 910002 || repository.ExternalRepositoryID != 920002 {
		t.Fatalf("resolved = %#v %#v", resolved, repository)
	}
	// The unnamed repository stayed denied.
	if _, _, err := store.AllowedSCMRepository(ctx, alice.identity, "alice-allow/docs"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("an unlisted repository resolved: %v", err)
	}
	// Another tenant cannot resolve it at all.
	if _, _, err := store.AllowedSCMRepository(ctx, bob.identity, "alice-allow/widgets"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a foreign tenant resolved an allowlisted repository: %v", err)
	}

	// Replacing the allowlist revokes the previous entry.
	if err := store.SetSCMRepositoryAllowlist(ctx, alice.identity, installation.ID, []int64{920003}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.AllowedSCMRepository(ctx, alice.identity, "alice-allow/widgets"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("allowlist replacement did not revoke: %v", err)
	}

	// A suspended installation cannot resolve anything.
	if _, err := store.SetSCMInstallationStatus(ctx, 910002, domain.InstallationStatusSuspended); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.AllowedSCMRepository(ctx, alice.identity, "alice-allow/docs"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a suspended installation resolved a repository: %v", err)
	}
}

func TestSCMSyncPreservesAllowlistAndDropsVanishedRepositories(t *testing.T) {
	store := newSCMIntegrationStore(t)
	ctx := context.Background()
	alice := signUp(t, store, "scm-sync-alice", "scm-sync-alice@example.com")
	installation := linkInstallation(t, store, alice, 910003, "alice-sync")

	if err := store.SyncSCMRepositories(ctx, alice.identity, installation.ID, []domain.SCMRepository{
		{ExternalRepositoryID: 920010, FullName: "alice-sync/keep"},
		{ExternalRepositoryID: 920011, FullName: "alice-sync/drop"},
	}, true); err != nil {
		t.Fatal(err)
	}
	// A later refresh must not clear the existing decision, and must not
	// allowlist a newly visible repository.
	if err := store.SyncSCMRepositories(ctx, alice.identity, installation.ID, []domain.SCMRepository{
		{ExternalRepositoryID: 920010, FullName: "alice-sync/keep"},
		{ExternalRepositoryID: 920012, FullName: "alice-sync/new"},
	}, false); err != nil {
		t.Fatal(err)
	}
	repositories, err := store.ListSCMRepositories(ctx, alice.identity, installation.ID)
	if err != nil {
		t.Fatal(err)
	}
	allowed := map[string]bool{}
	for _, repository := range repositories {
		allowed[repository.FullName] = repository.Allowed
	}
	if len(repositories) != 2 {
		t.Fatalf("repositories = %#v", repositories)
	}
	if !allowed["alice-sync/keep"] {
		t.Fatal("a refresh cleared an existing allowlist entry")
	}
	if allowed["alice-sync/new"] {
		t.Fatal("a refresh allowlisted a newly visible repository")
	}
	if _, present := allowed["alice-sync/drop"]; present {
		t.Fatal("a repository that left the installation was retained")
	}
}

func TestSCMWebhookDeliveriesAreDeduplicated(t *testing.T) {
	store := newSCMIntegrationStore(t)
	ctx := context.Background()
	deliveryID := "delivery-" + time.Now().UTC().Format("20060102150405.000000000")

	first, err := store.RecordSCMWebhookDelivery(ctx, deliveryID, "pull_request")
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.RecordSCMWebhookDelivery(ctx, deliveryID, "pull_request")
	if err != nil {
		t.Fatal(err)
	}
	if !first || second {
		t.Fatalf("dedup returned first=%v second=%v", first, second)
	}
	if _, err := store.PruneSCMWebhookDeliveries(ctx, time.Nanosecond); err != nil {
		t.Fatal(err)
	}
}

func TestSCMWebhookDeliveriesAreDurablyRetried(t *testing.T) {
	store := newSCMIntegrationStore(t)
	ctx := context.Background()
	deliveryID := "retry-delivery-" + time.Now().UTC().Format("20060102150405.000000000")
	body := []byte(`{"installation":{"id":910099}}`)

	first, err := store.RecordSCMWebhookDelivery(ctx, deliveryID, "installation")
	if err != nil {
		t.Fatal(err)
	}
	if !first {
		t.Fatal("first delivery was not claimed")
	}
	if err := store.PrepareSCMWebhookDelivery(ctx, deliveryID, body); err != nil {
		t.Fatal(err)
	}
	if err := store.FinishSCMWebhookDelivery(ctx, deliveryID, "retry", "processing_failed", 910099); err != nil {
		t.Fatal(err)
	}

	deliveries, err := store.ClaimSCMWebhookRetries(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(deliveries) != 1 {
		t.Fatalf("claimed deliveries = %#v", deliveries)
	}
	if deliveries[0].DeliveryID != deliveryID || deliveries[0].Event != "installation" || !bytes.Equal(deliveries[0].Body, body) {
		t.Fatalf("claimed delivery = %#v", deliveries[0])
	}
	if err := store.FinishSCMWebhookDelivery(ctx, deliveryID, "processed", "", 910099); err != nil {
		t.Fatal(err)
	}
	deliveries, err = store.ClaimSCMWebhookRetries(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(deliveries) != 0 {
		t.Fatalf("processed delivery was reclaimed: %#v", deliveries)
	}
}

func TestSCMWebhookRepositoryChangesCannotWidenAccess(t *testing.T) {
	store := newSCMIntegrationStore(t)
	ctx := context.Background()
	alice := signUp(t, store, "scm-hook-alice", "scm-hook-alice@example.com")
	installation := linkInstallation(t, store, alice, 910005, "alice-hook")
	if err := store.SyncSCMRepositories(ctx, alice.identity, installation.ID, []domain.SCMRepository{
		{ExternalRepositoryID: 920020, FullName: "alice-hook/widgets"},
	}, true); err != nil {
		t.Fatal(err)
	}

	// A webhook-added repository must land denied.
	if _, err := store.AddSCMWebhookRepository(ctx, 910005, 920021, "Alice-Hook/New", true); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.AllowedSCMRepository(ctx, alice.identity, "alice-hook/new"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a webhook-added repository was brokerable: %v", err)
	}
	// Re-delivering the same add must not flip the existing allowlist entry.
	if _, err := store.AddSCMWebhookRepository(ctx, 910005, 920020, "alice-hook/widgets", false); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.AllowedSCMRepository(ctx, alice.identity, "alice-hook/widgets"); err != nil {
		t.Fatalf("a webhook redelivery revoked an allowlisted repository: %v", err)
	}

	// Removal revokes.
	if _, err := store.RemoveSCMWebhookRepository(ctx, 910005, 920020); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.AllowedSCMRepository(ctx, alice.identity, "alice-hook/widgets"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a removed repository was still brokerable: %v", err)
	}
}

func TestSCMInstallStateIsSingleUseAndTenantBound(t *testing.T) {
	store := newSCMIntegrationStore(t)
	ctx := context.Background()
	alice := signUp(t, store, "scm-state-alice", "scm-state-alice@example.com")

	digest := sha256.Sum256([]byte("state-" + alice.identity.UserID))
	if err := store.CreateSCMInstallState(ctx, alice.identity, digest[:], time.Now().UTC().Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	link, err := store.ConsumeSCMInstallState(ctx, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	if link.OrgID != alice.identity.OrgID || link.UserID != alice.identity.UserID {
		t.Fatalf("link = %#v", link)
	}
	if _, err := store.ConsumeSCMInstallState(ctx, digest[:]); !errors.Is(err, ErrNotFound) {
		t.Fatalf("a state token was consumable twice: %v", err)
	}

	// An expired state is never redeemable.
	expired := sha256.Sum256([]byte("expired-" + alice.identity.UserID))
	if err := store.CreateSCMInstallState(ctx, alice.identity, expired[:], time.Now().UTC().Add(-time.Second)); err == nil {
		t.Fatal("a state expiring in the past was accepted")
	}
}

func TestSCMTokenGrantLedgerIsTenantScoped(t *testing.T) {
	store := newSCMIntegrationStore(t)
	ctx := context.Background()
	alice := signUp(t, store, "scm-grant-alice", "scm-grant-alice@example.com")
	bob := signUp(t, store, "scm-grant-bob", "scm-grant-bob@example.com")
	installation := linkInstallation(t, store, alice, 910006, "alice-grant")
	if err := store.SyncSCMRepositories(ctx, alice.identity, installation.ID, []domain.SCMRepository{
		{ExternalRepositoryID: 920030, FullName: "alice-grant/widgets"},
	}, true); err != nil {
		t.Fatal(err)
	}
	_, repository, err := store.AllowedSCMRepository(ctx, alice.identity, "alice-grant/widgets")
	if err != nil {
		t.Fatal(err)
	}

	grant := domain.SCMTokenGrant{
		OrgID:          alice.identity.OrgID,
		InstallationID: installation.ID,
		RepositoryID:   repository.ID,
		Purpose:        domain.TokenPurposeClone,
		ExpiresAt:      time.Now().UTC().Add(time.Hour),
	}
	if err := store.RecordSCMTokenGrant(ctx, alice.identity, grant); err != nil {
		t.Fatal(err)
	}
	// Another tenant cannot write a grant against a foreign installation.
	if err := store.RecordSCMTokenGrant(ctx, bob.identity, grant); err == nil {
		t.Fatal("a grant was written against a foreign installation")
	}
}
