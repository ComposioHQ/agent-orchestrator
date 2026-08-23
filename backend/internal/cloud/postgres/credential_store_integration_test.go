package postgres

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/credentials"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

func TestCredentialStoreRLSBootstrapAuditAndRevocationAgainstPostgres(t *testing.T) {
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
	defer store.Close()

	createPrincipal := func(externalID, email string) (domain.Principal, domain.Membership) {
		t.Helper()
		principal, err := store.UpsertGoogleUser(ctx, domain.Principal{ExternalID: externalID, Email: email, DisplayName: externalID})
		if err != nil {
			t.Fatal(err)
		}
		memberships, err := store.ListMemberships(ctx, principal)
		if err != nil || len(memberships) != 1 {
			t.Fatalf("memberships = %#v, err = %v", memberships, err)
		}
		return principal, memberships[0]
	}
	alice, aliceMembership := createPrincipal("credential-alice", "credential-alice@example.com")
	bob, bobMembership := createPrincipal("credential-bob", "credential-bob@example.com")
	aliceCtx := tenant.WithIdentity(ctx, tenant.Identity{OrgID: aliceMembership.OrgID, UserID: alice.UserID, Role: "owner"})
	bobCtx := tenant.WithIdentity(ctx, tenant.Identity{OrgID: bobMembership.OrgID, UserID: bob.UserID, Role: "owner"})

	workspaceTx, err := store.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = workspaceTx.Rollback(ctx) }()
	if _, err := workspaceTx.Exec(ctx,
		`SELECT set_config('ao.user_id', $1, true), set_config('ao.org_id', $2, true)`,
		alice.UserID, aliceMembership.OrgID,
	); err != nil {
		t.Fatal(err)
	}
	var workspaceID string
	if err := workspaceTx.QueryRow(ctx,
		`INSERT INTO ao_cloud_workspaces (org_id, owner_user_id, repository_url)
		 VALUES ($1, $2, 'https://github.com/example/credential-test.git') RETURNING id`,
		aliceMembership.OrgID, alice.UserID,
	).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	if err := workspaceTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	material := credentials.EncryptedMaterial{
		Ciphertext: make([]byte, 32), EncryptedDataKey: []byte("wrapped-key"),
		Nonce: make([]byte, 12), KeyID: "test-kms-key",
	}
	created, err := store.Put(aliceCtx, credentials.ProviderClaudeCode, credentials.TypeOAuthToken, material)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Get(bobCtx, credentials.ProviderClaudeCode); !errors.Is(err, credentials.ErrNotFound) {
		t.Fatalf("Bob read Alice credential: %v", err)
	}
	held, err := store.GetForWorkspace(ctx, aliceMembership.OrgID, workspaceID, credentials.ProviderClaudeCode, "sandbox-1")
	if err != nil || held.OwnerUserID != alice.UserID {
		t.Fatalf("bootstrap credential = %#v, err = %v", held, err)
	}
	if _, err := store.GetForWorkspace(ctx, bobMembership.OrgID, workspaceID, credentials.ProviderClaudeCode, "sandbox-foreign"); !errors.Is(err, credentials.ErrNotFound) {
		t.Fatalf("cross-org bootstrap = %v", err)
	}

	auditTx, _, err := beginCredentialTx(aliceCtx, store.pool, true)
	if err != nil {
		t.Fatal(err)
	}
	var createdEvents, decryptEvents int
	if err := auditTx.QueryRow(ctx,
		`SELECT count(*) FILTER (WHERE event = 'credential.created'),
		        count(*) FILTER (WHERE event = 'credential.decrypted')
		 FROM ao_harness_credential_audit WHERE credential_id = $1`, created.ID,
	).Scan(&createdEvents, &decryptEvents); err != nil {
		t.Fatal(err)
	}
	if err := auditTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if createdEvents != 1 || decryptEvents != 1 {
		t.Fatalf("audit counts = created %d, decrypted %d", createdEvents, decryptEvents)
	}
	if err := store.Delete(aliceCtx, credentials.ProviderClaudeCode); err != nil {
		t.Fatal(err)
	}
	if _, err := store.GetForWorkspace(ctx, aliceMembership.OrgID, workspaceID, credentials.ProviderClaudeCode, "sandbox-after-revoke"); !errors.Is(err, credentials.ErrNotFound) {
		t.Fatalf("bootstrap after revocation = %v", err)
	}
}
