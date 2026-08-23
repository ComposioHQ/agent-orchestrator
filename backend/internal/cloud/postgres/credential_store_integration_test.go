package postgres

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/credentials"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

func TestCredentialMigrationsAreCiphertextOnlyScopedAndBounded(t *testing.T) {
	schemaBytes, err := migrationFS.ReadFile("migrations/00040_harness_credentials.sql")
	if err != nil {
		t.Fatal(err)
	}
	securityBytes, err := migrationFS.ReadFile("migrations/00041_harness_credential_security.sql")
	if err != nil {
		t.Fatal(err)
	}
	schema, security := string(schemaBytes), string(securityBytes)
	for _, required := range []string{
		"provider = 'claude-code'", "FORCE ROW LEVEL SECURITY", "ciphertext BYTEA", "encrypted_data_key BYTEA",
		"plaintext_bytes BIGINT", "octet_length(idempotency_key)", "UNIQUE (org_id, sandbox_id, idempotency_key)",
		"credential.load_acknowledged", "credential.delivery_failed",
	} {
		if !strings.Contains(schema, required) {
			t.Fatalf("credential schema missing %q", required)
		}
	}
	for _, forbidden := range []string{"plaintext BYTEA", "secret BYTEA", "provider IN ('claude'", "provider = 'claude'"} {
		if strings.Contains(schema, forbidden) {
			t.Fatalf("credential schema contains forbidden plaintext/noncanonical construct %q", forbidden)
		}
	}
	for _, required := range []string{
		"CREATE ROLE ao_cloud_credentials NOLOGIN NOBYPASSRLS", "SECURITY DEFINER", "SET search_path = pg_catalog, public",
		"runtime.workspace_id = candidate_workspace_id", "runtime.org_id = candidate_org_id",
		"runtime.session_id = candidate_session_id", "btrim(runtime.sandbox_id) <> ''",
		"workspace.id = runtime.workspace_id AND workspace.org_id = runtime.org_id",
		"credential.owner_user_id = resolved_owner_id", "candidate_role <> 'worker'",
		"credential aggregate limit exceeded", "credential delivery limit exceeded",
		"ON CONFLICT DO NOTHING", "REVOKE ALL ON FUNCTION ao_claim_harness_credential_delivery",
	} {
		if !strings.Contains(security, required) {
			t.Fatalf("credential security migration missing %q", required)
		}
	}
	if strings.Contains(security, "candidate_sandbox_id") {
		t.Fatal("claim function trusts a caller-supplied sandbox id")
	}
}

func TestCredentialStoreAgainstPostgres(t *testing.T) {
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
	grantCredentialTestPrivileges(t, ctx, migrationURL, runtimeRole)
	store, err := Open(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	suffix := fmt.Sprint(time.Now().UnixNano())
	bob, bobOrg := createCredentialTestPrincipal(t, ctx, store, "vault-bob-"+suffix)
	alice, aliceOrg := createCredentialTestPrincipal(t, ctx, store, "vault-alice-"+suffix)
	workspaceID, _ := createCredentialTestRuntime(t, ctx, store, bob.UserID, bobOrg, "session-"+suffix, "sandbox-"+suffix)
	bobCtx := tenant.WithIdentity(ctx, tenant.Identity{OrgID: bobOrg, UserID: bob.UserID, Role: "owner"})
	aliceCtx := tenant.WithIdentity(ctx, tenant.Identity{OrgID: aliceOrg, UserID: alice.UserID, Role: "owner"})

	record := testEncryptedCredential(bobOrg, bob.UserID, 1)
	stored, err := store.PutCredential(bobCtx, credentials.PutCredential{Record: record})
	if err != nil {
		t.Fatal(err)
	}
	if stored.OrgID != bobOrg || stored.OwnerUserID != bob.UserID || stored.Provider != credentials.ProviderClaudeCode {
		t.Fatalf("stored credential = %#v", stored)
	}
	if visible, err := store.ListCredentials(aliceCtx); err != nil || len(visible) != 0 {
		t.Fatalf("cross-org credential visibility = %#v, %v", visible, err)
	}

	verified := credentials.VerifiedCapability{GrantID: "grant-" + suffix, Scope: credentials.CapabilityScope{
		OrgID: bobOrg, WorkspaceID: workspaceID, SessionID: "session-" + suffix,
		Role: credentials.RoleWorker, Operations: []credentials.Operation{credentials.OperationCredentialLoad},
	}}
	lookup, err := credentials.NewDeliveryLookup(verified, credentials.ProviderClaudeCode, "delivery-1")
	if err != nil {
		t.Fatal(err)
	}
	claim, err := store.ClaimDelivery(ctx, lookup, credentials.DefaultDeliveryLimits())
	if err != nil {
		t.Fatal(err)
	}
	if claim.SandboxID != "sandbox-"+suffix || claim.Credential.OrgID != bobOrg || claim.Credential.OwnerUserID != bob.UserID {
		t.Fatalf("claim = %#v", claim)
	}
	if _, err := store.ClaimDelivery(ctx, lookup, credentials.DefaultDeliveryLimits()); !errors.Is(err, credentials.ErrDeliveryInFlight) {
		t.Fatalf("duplicate inflight claim = %v", err)
	}
	ack := credentials.LoadAcknowledgement{IdempotencyKey: "delivery-1", Provider: credentials.ProviderClaudeCode,
		Loaded: true, LoadedAt: time.Now().UTC(), HarnessReceipt: "receipt-1"}
	if err := store.AcknowledgeDelivery(ctx, claim.ID, ack); err != nil {
		t.Fatal(err)
	}
	duplicate, err := store.ClaimDelivery(ctx, lookup, credentials.DefaultDeliveryLimits())
	if err != nil {
		t.Fatal(err)
	}
	if duplicate.State != credentials.DeliveryLoaded || duplicate.Acknowledgement.HarnessReceipt != "receipt-1" {
		t.Fatalf("duplicate = %#v", duplicate)
	}
	if err := store.RecordDeliveryPurge(ctx, claim.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordDeliveryPurge(ctx, claim.ID); err != nil {
		t.Fatalf("idempotent purge: %v", err)
	}
	forgedDuplicate := verified
	forgedDuplicate.GrantID = "different-grant-" + suffix
	if _, err := store.ClaimDelivery(ctx, mustCredentialLookup(t, forgedDuplicate, "delivery-1"), credentials.DefaultDeliveryLimits()); !errors.Is(err, credentials.ErrNotAuthorized) {
		t.Fatalf("idempotency key replay under another grant = %v", err)
	}

	assertRejectedCredentialScope(t, ctx, store, verified, aliceOrg, workspaceID, "session-"+suffix, "cross-org")
	assertRejectedCredentialScope(t, ctx, store, verified, bobOrg, workspaceID, "forged-session", "wrong-session")

	loadingLookup := mustCredentialLookup(t, verified, "loading-1")
	loadingClaim, err := store.ClaimDelivery(ctx, loadingLookup, credentials.DefaultDeliveryLimits())
	if err != nil {
		t.Fatal(err)
	}
	limits := credentials.DefaultDeliveryLimits()
	limits.MaxInflightSandbox = 1
	if _, err := store.ClaimDelivery(ctx, mustCredentialLookup(t, verified, "loading-2"), limits); !errors.Is(err, credentials.ErrLimitExceeded) {
		t.Fatalf("sandbox inflight limit = %v", err)
	}
	if err := store.RecordDeliveryFailure(ctx, loadingClaim.ID, credentials.FailureLoad); err != nil {
		t.Fatal(err)
	}
	aggregateClaim, err := store.ClaimDelivery(ctx, mustCredentialLookup(t, verified, "aggregate-1"), credentials.DefaultDeliveryLimits())
	if err != nil {
		t.Fatal(err)
	}
	limits = credentials.DefaultDeliveryLimits()
	limits.MaxInflightSandbox = 2
	if _, err := store.ClaimDelivery(ctx, mustCredentialLookup(t, verified, "aggregate-2"), limits); !errors.Is(err, credentials.ErrLimitExceeded) {
		t.Fatalf("sandbox aggregate byte limit = %v", err)
	}
	if err := store.RecordDeliveryFailure(ctx, aggregateClaim.ID, credentials.FailureLoad); err != nil {
		t.Fatal(err)
	}

	stored.Material.Ciphertext = append([]byte(nil), stored.Material.Ciphertext...)
	stored.Version++
	stored.PlaintextBytes = 40 << 10
	stored.Material.Ciphertext = make([]byte, 64)
	stored.Material.Ciphertext[0] = 1
	rotated, err := store.PutCredential(bobCtx, credentials.PutCredential{Record: stored, ExpectedVersion: 1})
	if err != nil {
		t.Fatal(err)
	}
	if rotated.Version != 2 {
		t.Fatalf("rotated version = %d", rotated.Version)
	}
	if err := store.RevokeCredential(bobCtx, credentials.ProviderClaudeCode); err != nil {
		t.Fatal(err)
	}
	if err := store.RevokeCredential(bobCtx, credentials.ProviderClaudeCode); err != nil {
		t.Fatalf("idempotent revoke: %v", err)
	}
	if _, err := store.ClaimDelivery(ctx, mustCredentialLookup(t, verified, "after-revoke"), credentials.DefaultDeliveryLimits()); !errors.Is(err, credentials.ErrNotAuthorized) {
		t.Fatalf("claim after revoke = %v", err)
	}

	events := credentialAuditEvents(t, bobCtx, store)
	for _, event := range []string{"credential.created", "credential.rotated", "credential.revoked", "credential.load_acknowledged", "credential.purged"} {
		if strings.Count(strings.Join(events, ","), event) != 1 {
			t.Fatalf("audit events %v do not contain %q exactly once", events, event)
		}
	}
}

func grantCredentialTestPrivileges(t *testing.T, ctx context.Context, databaseURL, runtimeRole string) {
	t.Helper()
	conn, err := pgx.Connect(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close(ctx) }()
	role := pgx.Identifier{runtimeRole}.Sanitize()
	statements := []string{
		"GRANT SELECT ON TABLE public.ao_harness_credentials, public.ao_harness_credential_deliveries, public.ao_harness_credential_audit TO " + role,
		"GRANT EXECUTE ON FUNCTION public.ao_put_harness_credential(uuid,text,text,jsonb,bytea,bytea,bytea,text,bigint,bigint,bigint,bigint,bigint), public.ao_revoke_harness_credential(text), public.ao_claim_harness_credential_delivery(text,uuid,uuid,text,text,text,text,integer,integer,integer,bigint), public.ao_acknowledge_harness_credential_delivery(uuid,text,text,timestamptz,text), public.ao_record_harness_credential_purge(uuid), public.ao_record_harness_credential_failure(uuid,text) TO " + role,
	}
	for _, statement := range statements {
		if _, err := conn.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
}

func createCredentialTestPrincipal(t *testing.T, ctx context.Context, store *Store, externalID string) (domain.Principal, string) {
	t.Helper()
	principal, err := store.UpsertGoogleUser(ctx, domain.Principal{ExternalID: externalID, Email: externalID + "@example.com", DisplayName: externalID})
	if err != nil {
		t.Fatal(err)
	}
	memberships, err := store.ListMemberships(ctx, principal)
	if err != nil || len(memberships) != 1 {
		t.Fatalf("memberships=%#v err=%v", memberships, err)
	}
	return principal, memberships[0].OrgID
}

func createCredentialTestRuntime(t *testing.T, ctx context.Context, store *Store, userID, orgID, sessionID, sandboxID string) (string, string) {
	t.Helper()
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('ao.user_id',$1,true), set_config('ao.org_id',$2,true)`, userID, orgID); err != nil {
		t.Fatal(err)
	}
	var workspaceID string
	if err := tx.QueryRow(ctx, `INSERT INTO ao_cloud_workspaces (org_id,owner_user_id,repository_url) VALUES ($1,$2,'https://example.invalid/repo') RETURNING id`, orgID, userID).Scan(&workspaceID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `SELECT set_config('ao.workspace_id',$1,true)`, workspaceID); err != nil {
		t.Fatal(err)
	}
	var runtimeID string
	if err := tx.QueryRow(ctx, `INSERT INTO ao_cloud_session_runtimes (workspace_id,org_id,session_id,sandbox_id,state) VALUES ($1,$2,$3,$4,'running') RETURNING id`, workspaceID, orgID, sessionID, sandboxID).Scan(&runtimeID); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return workspaceID, runtimeID
}

func testEncryptedCredential(orgID, userID string, version int64) credentials.CredentialRecord {
	return credentials.CredentialRecord{
		ID: uuid.NewString(), OrgID: orgID, OwnerUserID: userID,
		Name: "Claude Code", Provider: credentials.ProviderClaudeCode, Metadata: []byte(`{"source":"test"}`),
		Material:       credentials.EncryptedMaterial{Ciphertext: make([]byte, 64), EncryptedDataKey: []byte("wrapped"), Nonce: make([]byte, 12), KeyID: "kms-key"},
		PlaintextBytes: 40 << 10, Version: version,
	}
}

func mustCredentialLookup(t *testing.T, verified credentials.VerifiedCapability, key string) credentials.DeliveryLookup {
	t.Helper()
	lookup, err := credentials.NewDeliveryLookup(verified, credentials.ProviderClaudeCode, key)
	if err != nil {
		t.Fatal(err)
	}
	return lookup
}

func assertRejectedCredentialScope(t *testing.T, ctx context.Context, store *Store, base credentials.VerifiedCapability, orgID, workspaceID, sessionID, key string) {
	t.Helper()
	base.Scope.OrgID, base.Scope.WorkspaceID, base.Scope.SessionID = orgID, workspaceID, sessionID
	_, err := store.ClaimDelivery(ctx, mustCredentialLookup(t, base, key), credentials.DefaultDeliveryLimits())
	if !errors.Is(err, credentials.ErrNotAuthorized) {
		t.Fatalf("forged scope (%s,%s,%s) = %v", orgID, workspaceID, sessionID, err)
	}
}

func credentialAuditEvents(t *testing.T, ctx context.Context, store *Store) []string {
	t.Helper()
	tx, _, err := beginCredentialTx(ctx, store.pool, true)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx, `SELECT event FROM ao_harness_credential_audit ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var events []string
	for rows.Next() {
		var event string
		if err := rows.Scan(&event); err != nil {
			t.Fatal(err)
		}
		events = append(events, event)
	}
	return events
}
