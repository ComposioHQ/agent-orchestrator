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
	"github.com/jackc/pgx/v5"
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
	var runtimeBypassesRLS bool
	if err := pool.QueryRow(
		ctx,
		`SELECT rolsuper OR rolbypassrls
		FROM pg_roles
		WHERE rolname = current_user`,
	).Scan(&runtimeBypassesRLS); err != nil {
		t.Fatal(err)
	}
	runtimeRoleErr := store.ValidateRuntimeRole(ctx)
	if runtimeBypassesRLS && runtimeRoleErr == nil {
		t.Fatal("ValidateRuntimeRole accepted a role that bypasses RLS")
	}
	if !runtimeBypassesRLS && runtimeRoleErr != nil {
		t.Fatalf("ValidateRuntimeRole rejected a restricted role: %v", runtimeRoleErr)
	}
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
	if session.RuntimeState != "requested" {
		t.Fatalf("new session runtime state = %q, want requested", session.RuntimeState)
	}
	events, hasMore, err := store.ListClientEvents(ctx, first, firstOrg, session.ID, 0, 10)
	if err != nil {
		t.Fatalf("list initial session events: %v", err)
	}
	if hasMore || len(events) != 1 || events[0].Sequence != 1 ||
		events[0].Type != "chat.user_message" {
		t.Fatalf("initial session events = %#v, hasMore = %v", events, hasMore)
	}
	if !jsonEqual(events[0].Payload, []byte(`{"text":"Build the API"}`)) {
		t.Fatalf("initial message payload = %s", events[0].Payload)
	}
	if _, err := store.GetSession(ctx, second, firstOrg, session.ID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cross-tenant session read error = %v", err)
	}
	if _, _, err := store.ListClientEvents(ctx, second, firstOrg, session.ID, 0, 10); !errors.Is(err, ErrForbidden) {
		t.Fatalf("cross-tenant event replay error = %v", err)
	}

	emptySessionInput := sessionInput
	emptySessionInput.DisplayName = "Empty session"
	emptySessionInput.Prompt = ""
	emptySession, err := store.CreateSession(
		ctx,
		first,
		firstOrg,
		"empty-session-key",
		emptySessionInput,
	)
	if err != nil {
		t.Fatalf("create empty session: %v", err)
	}
	message, err := store.SendMessage(
		ctx,
		first,
		firstOrg,
		emptySession.ID,
		"message-key",
		"Start now",
	)
	if err != nil {
		t.Fatalf("send message: %v", err)
	}
	replayedMessage, err := store.SendMessage(
		ctx,
		first,
		firstOrg,
		emptySession.ID,
		"message-key",
		"Start now",
	)
	if err != nil {
		t.Fatalf("replay message: %v", err)
	}
	if replayedMessage.Sequence != message.Sequence || message.Sequence != 1 {
		t.Fatalf("replayed message = %#v, original = %#v", replayedMessage, message)
	}
	if _, err := store.SendMessage(
		ctx,
		first,
		firstOrg,
		emptySession.ID,
		"message-key",
		"Different",
	); !errors.Is(err, ErrIdempotencyMismatch) {
		t.Fatalf("mismatched message replay error = %v", err)
	}
	if _, err := store.SendMessage(
		ctx,
		first,
		firstOrg,
		emptySession.ID,
		"second-message-key",
		"Still active",
	); !errors.Is(err, ErrConflict) {
		t.Fatalf("second active message error = %v", err)
	}

	concurrentInput := sessionInput
	concurrentInput.DisplayName = "Concurrent session"
	concurrentInput.Prompt = ""
	concurrentSession, err := store.CreateSession(
		ctx,
		first,
		firstOrg,
		"concurrent-session-key",
		concurrentInput,
	)
	if err != nil {
		t.Fatalf("create concurrent session: %v", err)
	}
	const callers = 8
	results := make(chan domain.ClientEvent, callers)
	errs := make(chan error, callers)
	for range callers {
		go func() {
			event, err := store.SendMessage(
				ctx,
				first,
				firstOrg,
				concurrentSession.ID,
				"concurrent-message-key",
				"Run once",
			)
			results <- event
			errs <- err
		}()
	}
	for range callers {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent message replay: %v", err)
		}
		if event := <-results; event.Sequence != 1 {
			t.Fatalf("concurrent event sequence = %d, want 1", event.Sequence)
		}
	}
	concurrentEvents, hasMore, err := store.ListClientEvents(
		ctx,
		first,
		firstOrg,
		concurrentSession.ID,
		0,
		10,
	)
	if err != nil {
		t.Fatalf("list concurrent events: %v", err)
	}
	if hasMore || len(concurrentEvents) != 1 {
		t.Fatalf("concurrent events = %#v, hasMore = %v", concurrentEvents, hasMore)
	}

	visibleWithoutContext, err := countProjectsWithoutRLSContext(ctx, pool)
	if err != nil {
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
	var initialOwnerUserID *string
	if err := store.withTenant(
		ctx,
		workosAdmin,
		adminMemberships[0].OrgID,
		func(tx pgx.Tx) error {
			return tx.QueryRow(
				ctx,
				`SELECT owner_user_id FROM ao_organizations WHERE id = $1`,
				adminMemberships[0].OrgID,
			).Scan(&initialOwnerUserID)
		},
	); err != nil {
		t.Fatal(err)
	}
	if initialOwnerUserID != nil {
		t.Fatalf("admin was assigned as organization owner: %q", *initialOwnerUserID)
	}
	workosOwner, err := store.UpsertWorkOSUser(ctx, domain.Principal{
		Provider:      "workos",
		ExternalID:    "user_owner_" + suffix,
		Email:         "owner-" + suffix + "@example.com",
		DisplayName:   "Owner",
		ExternalOrgID: externalOrgID,
		OrgName:       "Example Inc.",
		OrgRole:       "owner",
	})
	if err != nil {
		t.Fatalf("upsert WorkOS owner: %v", err)
	}
	var ownerUserID *string
	if err := store.withTenant(
		ctx,
		workosOwner,
		adminMemberships[0].OrgID,
		func(tx pgx.Tx) error {
			return tx.QueryRow(
				ctx,
				`SELECT owner_user_id FROM ao_organizations WHERE id = $1`,
				adminMemberships[0].OrgID,
			).Scan(&ownerUserID)
		},
	); err != nil {
		t.Fatal(err)
	}
	if ownerUserID == nil || *ownerUserID != workosOwner.UserID {
		t.Fatalf("WorkOS owner_user_id = %#v, want %q", ownerUserID, workosOwner.UserID)
	}
	if err := store.withTenant(
		ctx,
		workosMember,
		memberMemberships[0].OrgID,
		func(tx pgx.Tx) error {
			_, err := tx.Exec(
				ctx,
				`UPDATE ao_org_memberships
				SET status = 'disabled'
				WHERE org_id = $1 AND user_id = $2`,
				memberMemberships[0].OrgID,
				workosMember.UserID,
			)
			return err
		},
	); err != nil {
		t.Fatalf("disable WorkOS member: %v", err)
	}
	if _, err := store.UpsertWorkOSUser(ctx, workosMember); err != nil {
		t.Fatalf("resync disabled WorkOS member: %v", err)
	}
	disabledMemberships, err := store.ListMemberships(ctx, workosMember)
	if err != nil {
		t.Fatal(err)
	}
	if len(disabledMemberships) != 0 {
		t.Fatalf("disabled WorkOS membership was reactivated: %#v", disabledMemberships)
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

func countProjectsWithoutRLSContext(ctx context.Context, pool *pgxpool.Pool) (int, error) {
	var bypassRLS bool
	if err := pool.QueryRow(
		ctx,
		`SELECT rolsuper OR rolbypassrls
		FROM pg_roles
		WHERE rolname = current_user`,
	).Scan(&bypassRLS); err != nil {
		return 0, err
	}
	if !bypassRLS {
		var count int
		err := pool.QueryRow(ctx, `SELECT count(*) FROM ao_projects`).Scan(&count)
		return count, err
	}

	role := "ao_rls_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	quotedRole := pgx.Identifier{role}.Sanitize()
	if _, err := pool.Exec(ctx, `CREATE ROLE `+quotedRole); err != nil {
		return 0, err
	}
	defer pool.Exec(ctx, `DROP ROLE `+quotedRole)
	if _, err := pool.Exec(ctx, `GRANT SELECT ON ao_projects TO `+quotedRole); err != nil {
		return 0, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET LOCAL ROLE `+quotedRole); err != nil {
		return 0, err
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM ao_projects`).Scan(&count); err != nil {
		return 0, err
	}
	return count, nil
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
