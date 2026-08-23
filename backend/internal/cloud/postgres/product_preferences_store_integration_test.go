package postgres

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/storagetest"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

func TestProductPreferencesAgainstPostgres(t *testing.T) {
	migrationURL := os.Getenv("AO_CLOUD_TEST_MIGRATION_DATABASE_URL")
	runtimeRole := os.Getenv("AO_CLOUD_TEST_RUNTIME_DATABASE_ROLE")
	if migrationURL == "" || runtimeRole == "" {
		t.Skip("set AO_CLOUD_TEST_MIGRATION_DATABASE_URL and AO_CLOUD_TEST_RUNTIME_DATABASE_ROLE")
	}
	ctx := context.Background()
	if err := EnsureRuntimeRole(ctx, migrationURL, runtimeRole, "integration-runtime-password"); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, migrationURL, runtimeRole); err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, migrationURL)
	if err != nil {
		t.Fatal(err)
	}
	store := &Store{pool: pool}
	t.Cleanup(store.Close)

	newTenant := func(label string) tenant.Identity {
		t.Helper()
		suffix := uuid.NewString()
		principal, err := store.UpsertGoogleUser(ctx, clouddomain.Principal{
			ExternalID:  label + "-" + suffix,
			Email:       label + "-" + suffix + "@example.test",
			DisplayName: label,
		})
		if err != nil {
			t.Fatal(err)
		}
		memberships, err := store.ListMemberships(ctx, principal)
		if err != nil || len(memberships) != 1 {
			t.Fatalf("memberships = %#v err=%v", memberships, err)
		}
		return tenant.Identity{OrgID: memberships[0].OrgID, UserID: principal.UserID, Role: memberships[0].Role}
	}

	alice := newTenant("product-alice")
	bob := newTenant("product-bob")
	aliceCtx := tenant.WithIdentity(ctx, alice)
	bobCtx := tenant.WithIdentity(ctx, bob)
	storagetest.RunPreferenceConformance(t, aliceCtx, store)

	now := time.Date(2026, 8, 23, 12, 45, 0, 0, time.UTC)
	if err := store.SetDefaultSessionMode(bobCtx, domain.SessionModeChat, now); err != nil {
		t.Fatal(err)
	}
	if err := store.UpsertAgentInventoryCache(bobCtx, `{"installed":["claude-code"]}`, now); err != nil {
		t.Fatal(err)
	}
	// A forged organization selection with Alice's principal must be rejected by
	// forced RLS, even though every query also predicates on the forged org id.
	forged := tenant.WithIdentity(ctx, tenant.Identity{OrgID: bob.OrgID, UserID: alice.UserID, Role: alice.Role})
	if err := store.SetDefaultSessionMode(forged, domain.SessionModeTUI, now); err == nil {
		t.Fatal("cross-tenant settings write succeeded")
	}
	if err := store.UpsertAgentInventoryCache(forged, `{}`, now); err == nil {
		t.Fatal("cross-tenant inventory write succeeded")
	}
	settings, err := store.GetAppSettings(bobCtx)
	if err != nil || settings.DefaultSessionMode != domain.SessionModeChat {
		t.Fatalf("Bob settings changed across tenant boundary: %+v err=%v", settings, err)
	}
}
