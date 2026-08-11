package postgres

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestFoundingSchemaAndTenantIsolation(t *testing.T) {
	databaseURL := os.Getenv("AO_CLOUD_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("AO_CLOUD_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	if err := Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var tableCount int
	if err := pool.QueryRow(
		ctx,
		`SELECT count(*) FROM information_schema.tables
		WHERE table_schema = 'public' AND table_name LIKE 'ao_%'`,
	).Scan(&tableCount); err != nil {
		t.Fatal(err)
	}
	if tableCount != 28 {
		t.Fatalf("found %d AO tables, want 28", tableCount)
	}
	var forcedRLSTableCount int
	if err := pool.QueryRow(
		ctx,
		`SELECT count(*)
		FROM pg_class
		WHERE relnamespace = 'public'::regnamespace
		  AND relname LIKE 'ao_%'
		  AND relrowsecurity
		  AND relforcerowsecurity`,
	).Scan(&forcedRLSTableCount); err != nil {
		t.Fatal(err)
	}
	if forcedRLSTableCount != 24 {
		t.Fatalf("found %d forced-RLS AO tables, want 24", forcedRLSTableCount)
	}

	store, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Now().UTC()
	suffix := strings.ReplaceAll(uuid.NewString(), "-", "")
	first, firstOrg := registerTestUser(
		t,
		store,
		"first-"+suffix+"@example.com",
		"first-"+suffix,
		now,
	)
	second, _ := registerTestUser(
		t,
		store,
		"second-"+suffix+"@example.com",
		"second-"+suffix,
		now,
	)

	projectInput := domain.CreateProject{
		DisplayName:   "API",
		RepositoryURL: "https://github.com/example/api",
		DefaultBranch: "main",
		Config:        json.RawMessage(`{"language":"go"}`),
	}
	project, err := store.CreateProject(
		ctx,
		first,
		firstOrg,
		"project-key",
		projectInput,
	)
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	replayedProject, err := store.CreateProject(
		ctx,
		first,
		firstOrg,
		"project-key",
		projectInput,
	)
	if err != nil {
		t.Fatalf("replay project: %v", err)
	}
	if replayedProject.ID != project.ID {
		t.Fatalf("idempotent create returned %q, want %q", replayedProject.ID, project.ID)
	}
	changedInput := projectInput
	changedInput.DisplayName = "Different"
	if _, err := store.CreateProject(
		ctx,
		first,
		firstOrg,
		"project-key",
		changedInput,
	); !errors.Is(err, ErrIdempotencyMismatch) {
		t.Fatalf("idempotency mismatch error = %v", err)
	}

	if _, _, err := store.ListProjects(
		ctx,
		second,
		firstOrg,
		nil,
		50,
	); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cross-tenant project list error = %v", err)
	}

	sessionInput := domain.CreateSession{
		ProjectID:   project.ID,
		Kind:        "worker",
		Harness:     "claude-code",
		DisplayName: "Implement API",
		Prompt:      "Build the API",
	}
	session, err := store.CreateSession(
		ctx,
		first,
		firstOrg,
		"session-key",
		sessionInput,
	)
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	replayedSession, err := store.CreateSession(
		ctx,
		first,
		firstOrg,
		"session-key",
		sessionInput,
	)
	if err != nil {
		t.Fatalf("replay session: %v", err)
	}
	if replayedSession.ID != session.ID {
		t.Fatalf("idempotent session returned %q, want %q", replayedSession.ID, session.ID)
	}
	if _, err := store.GetSession(ctx, second, firstOrg, session.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cross-tenant session read error = %v", err)
	}

	var visibleWithoutContext int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM ao_projects`).Scan(&visibleWithoutContext); err != nil {
		t.Fatal(err)
	}
	if visibleWithoutContext != 0 {
		t.Fatalf("RLS exposed %d projects without tenant context", visibleWithoutContext)
	}

	workos := domain.Principal{
		Provider:    "workos",
		ExternalID:  "user_workos_" + suffix,
		Email:       "workos-" + suffix + "@example.com",
		DisplayName: "WorkOS User",
	}
	resolved, err := store.UpsertWorkOSUser(ctx, workos)
	if err != nil {
		t.Fatalf("upsert WorkOS user: %v", err)
	}
	replayed, err := store.UpsertWorkOSUser(ctx, workos)
	if err != nil {
		t.Fatalf("replay WorkOS user: %v", err)
	}
	if replayed.UserID != resolved.UserID {
		t.Fatalf("WorkOS user changed from %q to %q", resolved.UserID, replayed.UserID)
	}
	memberships, err := store.ListMemberships(ctx, resolved)
	if err != nil {
		t.Fatalf("list WorkOS memberships: %v", err)
	}
	if len(memberships) != 1 || memberships[0].Role != "owner" {
		t.Fatalf("WorkOS memberships = %#v", memberships)
	}

	externalOrgID := "org_" + suffix
	workosAdmin, err := store.UpsertWorkOSUser(ctx, domain.Principal{
		Provider:      "workos",
		ExternalID:    "user_admin_" + suffix,
		Email:         "admin-" + suffix + "@example.com",
		DisplayName:   "Admin",
		ExternalOrgID: externalOrgID,
		OrgName:       "Example Inc.",
		OrgRole:       "admin",
	})
	if err != nil {
		t.Fatalf("upsert WorkOS admin: %v", err)
	}
	workosMember, err := store.UpsertWorkOSUser(ctx, domain.Principal{
		Provider:      "workos",
		ExternalID:    "user_member_" + suffix,
		Email:         "member-" + suffix + "@example.com",
		DisplayName:   "Member",
		ExternalOrgID: externalOrgID,
		OrgName:       "Example Inc.",
		OrgRole:       "member",
	})
	if err != nil {
		t.Fatalf("upsert WorkOS member: %v", err)
	}
	adminMemberships, err := store.ListMemberships(ctx, workosAdmin)
	if err != nil {
		t.Fatal(err)
	}
	memberMemberships, err := store.ListMemberships(ctx, workosMember)
	if err != nil {
		t.Fatal(err)
	}
	if len(adminMemberships) != 1 ||
		len(memberMemberships) != 1 ||
		adminMemberships[0].OrgID != memberMemberships[0].OrgID ||
		adminMemberships[0].Role != "admin" ||
		memberMemberships[0].Role != "member" {
		t.Fatalf(
			"external organization memberships = %#v, %#v",
			adminMemberships,
			memberMemberships,
		)
	}
	tokenWithoutOrganization := workosAdmin
	tokenWithoutOrganization.ExternalOrgID = ""
	if _, _, err := store.ListProjects(
		ctx,
		tokenWithoutOrganization,
		adminMemberships[0].OrgID,
		nil,
		50,
	); !errors.Is(err, ErrForbidden) {
		t.Fatalf("WorkOS token without selected organization error = %v", err)
	}
}

func registerTestUser(
	t *testing.T,
	store *Store,
	email string,
	slug string,
	now time.Time,
) (domain.Principal, string) {
	t.Helper()
	tokenHash := make([]byte, 32)
	if _, err := rand.Read(tokenHash); err != nil {
		t.Fatal(err)
	}
	principal, orgID, err := store.RegisterLocal(
		context.Background(),
		domain.LocalRegistration{
			Email:        email,
			DisplayName:  email,
			PasswordHash: "test-password-hash",
			OrgSlug:      slug,
			OrgName:      slug,
		},
		tokenHash,
		now.Add(time.Hour),
	)
	if err != nil {
		t.Fatalf("register %s: %v", email, err)
	}
	return principal, orgID
}
