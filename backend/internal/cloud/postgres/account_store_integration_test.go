package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/auth"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

func TestAccountFoundationAgainstPostgres(t *testing.T) {
	runtimeURL := os.Getenv("AO_CLOUD_TEST_DATABASE_URL")
	migrationURL := os.Getenv("AO_CLOUD_TEST_MIGRATION_DATABASE_URL")
	runtimeRole := os.Getenv("AO_CLOUD_TEST_RUNTIME_DATABASE_ROLE")
	if runtimeURL == "" || migrationURL == "" || runtimeRole == "" {
		t.Skip("set AO_CLOUD_TEST_DATABASE_URL, AO_CLOUD_TEST_MIGRATION_DATABASE_URL, and AO_CLOUD_TEST_RUNTIME_DATABASE_ROLE")
	}
	ctx := context.Background()
	if err := Migrate(ctx, migrationURL, runtimeRole); err != nil {
		t.Fatal(err)
	}
	store, err := Open(ctx, runtimeURL)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	alice, err := store.UpsertGoogleUser(ctx, domain.Principal{
		Provider:    "google",
		ExternalID:  "google-alice",
		Email:       "Alice@Example.com",
		DisplayName: "Alice",
	})
	if err != nil {
		t.Fatal(err)
	}
	aliceMemberships, err := store.ListMemberships(ctx, alice)
	if err != nil {
		t.Fatal(err)
	}
	if len(aliceMemberships) != 1 || aliceMemberships[0].Role != "owner" {
		t.Fatalf("Alice memberships = %#v", aliceMemberships)
	}

	bob, err := store.UpsertGoogleUser(ctx, domain.Principal{
		Provider:    "google",
		ExternalID:  "google-bob",
		Email:       "bob@example.com",
		DisplayName: "Bob",
	})
	if err != nil {
		t.Fatal(err)
	}
	bobMemberships, err := store.ListMemberships(ctx, bob)
	if err != nil {
		t.Fatal(err)
	}
	if len(bobMemberships) != 1 || bobMemberships[0].OrgID == aliceMemberships[0].OrgID {
		t.Fatalf("Bob memberships = %#v", bobMemberships)
	}

	tx, err := store.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('ao.user_id', $1, true)`, bob.UserID); err != nil {
		t.Fatal(err)
	}
	var visible int
	if err := tx.QueryRow(
		ctx,
		`SELECT count(*) FROM ao_organizations WHERE id = $1`,
		aliceMemberships[0].OrgID,
	).Scan(&visible); err != nil {
		t.Fatal(err)
	}
	if visible != 0 {
		t.Fatalf("Bob can see %d Alice organizations", visible)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}

	refreshToken, refreshHash, err := auth.NewRefreshToken()
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CreateRefreshSession(ctx, alice.UserID, refreshHash, time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	_, replacementHash, err := auth.NewRefreshToken()
	if err != nil {
		t.Fatal(err)
	}
	rotated, err := store.RotateRefreshSession(
		ctx,
		auth.HashToken(refreshToken),
		replacementHash,
		time.Now().Add(time.Hour),
	)
	if err != nil || rotated.UserID != alice.UserID {
		t.Fatalf("rotated principal = %#v, error = %v", rotated, err)
	}
	if _, err := store.RotateRefreshSession(
		ctx,
		auth.HashToken(refreshToken),
		replacementHash,
		time.Now().Add(time.Hour),
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("refresh replay error = %v", err)
	}

	if privileged, err := Open(ctx, migrationURL); err == nil {
		privileged.Close()
		t.Fatal("privileged migration role was accepted as the runtime role")
	}
}
