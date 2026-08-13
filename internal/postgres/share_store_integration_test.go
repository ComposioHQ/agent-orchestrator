package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type shareFixture struct {
	store      *Store
	owner      domain.Principal
	ownerOrgID string
	projectID  string
	sessionID  string
	other      domain.Principal
	otherOrgID string
}

// newShareFixture creates two entirely separate users in two separate orgs
// — owner has a project (with a session) to share, other is a stranger to
// that org who can only ever reach it through a share.
func newShareFixture(t *testing.T, label string) shareFixture {
	t.Helper()
	databaseURL := os.Getenv("AO_CLOUD_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("AO_CLOUD_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	if err := Migrate(ctx, databaseURL); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	store, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)

	unique := strings.ToLower(uuid.NewString()[:8])
	now := time.Now()
	owner, ownerOrgID := registerTestUser(t, store, label+"-owner-"+unique+"@example.com", label+"-owner-"+unique, now)
	other, otherOrgID := registerTestUser(t, store, label+"-other-"+unique+"@example.com", label+"-other-"+unique, now)

	project, err := store.CreateProject(ctx, owner, ownerOrgID, label+"-project-key-"+unique, domain.CreateProject{
		DisplayName:   "Share fixture project",
		RepositoryURL: "https://github.com/example/repo.git",
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	session, err := store.CreateSession(ctx, owner, ownerOrgID, label+"-session-key-"+unique, 100, domain.CreateSession{
		ProjectID:   project.ID,
		Kind:        "worker",
		Harness:     "claude-code",
		DisplayName: "Share fixture session",
		Provider:    "nodeops",
		ResourceProfile: json.RawMessage(
			`{"provider":"nodeops","nodeOps":{"defaultShape":"s-4vcpu-8gb","defaultRootFs":"devbox:1"}}`,
		),
		BootstrapContext: json.RawMessage(`{"provider":"nodeops"}`),
		Release:          "test-release",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}

	return shareFixture{
		store:      store,
		owner:      owner,
		ownerOrgID: ownerOrgID,
		projectID:  project.ID,
		sessionID:  session.ID,
		other:      other,
		otherOrgID: otherOrgID,
	}
}

func TestRedeemProjectShareLinkGrantsCrossOrgAccess(t *testing.T) {
	t.Parallel()
	f := newShareFixture(t, "redeem")
	ctx := context.Background()

	link, token, err := f.store.CreateProjectShareLink(ctx, f.owner, f.ownerOrgID, f.projectID, domain.CreateShareLink{
		Role:        "editor",
		AccessScope: "anyone",
		Interaction: "interact",
	})
	if err != nil {
		t.Fatalf("create share link: %v", err)
	}
	if link.ID == "" || token == "" {
		t.Fatalf("expected a link id and a raw token, got link=%#v token=%q", link, token)
	}

	shared, err := f.store.RedeemProjectShareLink(ctx, f.other, f.ownerOrgID, token)
	if err != nil {
		t.Fatalf("redeem share link: %v", err)
	}
	if shared.Project.ID != f.projectID {
		t.Fatalf("redeemed project = %s, want %s", shared.Project.ID, f.projectID)
	}
	if shared.Grant.Role != "editor" {
		t.Fatalf("redeemed role = %q, want editor", shared.Grant.Role)
	}

	// The redeemer is not a member of the owner's org, but ListSharedProjects
	// must still surface the grant — this is the whole point of migration
	// 00021's widened RLS policy.
	mine, err := f.store.ListSharedProjects(ctx, f.other)
	if err != nil {
		t.Fatalf("list shared projects: %v", err)
	}
	if len(mine) != 1 || mine[0].Project.ID != f.projectID {
		t.Fatalf("shared projects for redeemer = %#v", mine)
	}

	// And a plain org-membership listing must NOT show it — sharing does not
	// make the redeemer an org member.
	memberships, err := f.store.ListMemberships(ctx, f.other)
	if err != nil {
		t.Fatalf("list memberships: %v", err)
	}
	for _, membership := range memberships {
		if membership.OrgID == f.ownerOrgID {
			t.Fatalf("redeemer unexpectedly became a member of the owner's org: %#v", membership)
		}
	}
}

func TestRedeemProjectShareLinkRejectsSelfRedemption(t *testing.T) {
	t.Parallel()
	f := newShareFixture(t, "self-redeem")
	ctx := context.Background()

	_, token, err := f.store.CreateProjectShareLink(ctx, f.owner, f.ownerOrgID, f.projectID, domain.CreateShareLink{
		Role: "viewer",
	})
	if err != nil {
		t.Fatalf("create share link: %v", err)
	}
	if _, err := f.store.RedeemProjectShareLink(ctx, f.owner, f.ownerOrgID, token); !errors.Is(err, ErrForbidden) {
		t.Fatalf("self-redeem error = %v, want ErrForbidden", err)
	}
}

func TestRedeemProjectShareLinkEnforcesRestrictedRecipients(t *testing.T) {
	t.Parallel()
	f := newShareFixture(t, "restricted")
	ctx := context.Background()

	_, token, err := f.store.CreateProjectShareLink(ctx, f.owner, f.ownerOrgID, f.projectID, domain.CreateShareLink{
		Role:        "viewer",
		AccessScope: "restricted",
		Recipients:  []string{"someone-else@example.com"},
	})
	if err != nil {
		t.Fatalf("create share link: %v", err)
	}
	if _, err := f.store.RedeemProjectShareLink(ctx, f.other, f.ownerOrgID, token); !errors.Is(err, ErrForbidden) {
		t.Fatalf("restricted redeem error = %v, want ErrForbidden", err)
	}
}

func TestRevokedShareLinkCannotBeRedeemed(t *testing.T) {
	t.Parallel()
	f := newShareFixture(t, "revoke-link")
	ctx := context.Background()

	link, token, err := f.store.CreateProjectShareLink(ctx, f.owner, f.ownerOrgID, f.projectID, domain.CreateShareLink{
		Role: "viewer",
	})
	if err != nil {
		t.Fatalf("create share link: %v", err)
	}
	if err := f.store.RevokeProjectShareLink(ctx, f.owner, f.ownerOrgID, f.projectID, link.ID); err != nil {
		t.Fatalf("revoke share link: %v", err)
	}
	if _, err := f.store.RedeemProjectShareLink(ctx, f.other, f.ownerOrgID, token); !errors.Is(err, ErrNotFound) {
		t.Fatalf("redeem after revoke error = %v, want ErrNotFound", err)
	}
}

func TestSessionAccessViaShareGrantRespectsViewerRole(t *testing.T) {
	t.Parallel()
	f := newShareFixture(t, "session-access")
	ctx := context.Background()

	_, token, err := f.store.CreateProjectShareLink(ctx, f.owner, f.ownerOrgID, f.projectID, domain.CreateShareLink{
		SessionID: f.sessionID,
		Role:      "viewer",
	})
	if err != nil {
		t.Fatalf("create share link: %v", err)
	}
	if _, err := f.store.RedeemProjectShareLink(ctx, f.other, f.ownerOrgID, token); err != nil {
		t.Fatalf("redeem share link: %v", err)
	}

	session, err := f.store.GetSession(ctx, f.other, f.ownerOrgID, f.sessionID)
	if err != nil {
		t.Fatalf("get session as shared viewer: %v", err)
	}
	if session.ID != f.sessionID {
		t.Fatalf("session id = %s, want %s", session.ID, f.sessionID)
	}

	if _, err := f.store.SendMessage(ctx, f.other, f.ownerOrgID, f.sessionID, uuid.NewString(), "hello"); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer send message error = %v, want ErrForbidden", err)
	}

	// A stranger with no grant at all must be rejected outright.
	third, _ := registerTestUser(t, f.store, "stranger-"+strings.ToLower(uuid.NewString()[:8])+"@example.com", "stranger-"+strings.ToLower(uuid.NewString()[:8]), time.Now())
	if _, err := f.store.GetSession(ctx, third, f.ownerOrgID, f.sessionID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("ungranted stranger get session error = %v, want ErrForbidden", err)
	}
}

func TestSessionAccessViaShareGrantAllowsEditorToSendMessages(t *testing.T) {
	t.Parallel()
	f := newShareFixture(t, "session-editor")
	ctx := context.Background()

	_, token, err := f.store.CreateProjectShareLink(ctx, f.owner, f.ownerOrgID, f.projectID, domain.CreateShareLink{
		SessionID: f.sessionID,
		Role:      "editor",
	})
	if err != nil {
		t.Fatalf("create share link: %v", err)
	}
	if _, err := f.store.RedeemProjectShareLink(ctx, f.other, f.ownerOrgID, token); err != nil {
		t.Fatalf("redeem share link: %v", err)
	}

	if _, err := f.store.SendMessage(ctx, f.other, f.ownerOrgID, f.sessionID, uuid.NewString(), "hello"); err != nil {
		t.Fatalf("editor send message: %v", err)
	}
}

func TestRevokeProjectShareGrantCutsOffExistingAccess(t *testing.T) {
	t.Parallel()
	f := newShareFixture(t, "revoke-grant")
	ctx := context.Background()

	_, token, err := f.store.CreateProjectShareLink(ctx, f.owner, f.ownerOrgID, f.projectID, domain.CreateShareLink{
		SessionID: f.sessionID,
		Role:      "viewer",
	})
	if err != nil {
		t.Fatalf("create share link: %v", err)
	}
	shared, err := f.store.RedeemProjectShareLink(ctx, f.other, f.ownerOrgID, token)
	if err != nil {
		t.Fatalf("redeem share link: %v", err)
	}

	if err := f.store.RevokeProjectShareGrant(ctx, f.owner, f.ownerOrgID, f.projectID, shared.Grant.ID); err != nil {
		t.Fatalf("revoke share grant: %v", err)
	}
	if _, err := f.store.GetSession(ctx, f.other, f.ownerOrgID, f.sessionID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("get session after grant revoked error = %v, want ErrForbidden", err)
	}
}

func TestRedeemingALinkAgainRefreshesRatherThanDuplicatesTheGrant(t *testing.T) {
	t.Parallel()
	f := newShareFixture(t, "re-redeem")
	ctx := context.Background()

	_, token, err := f.store.CreateProjectShareLink(ctx, f.owner, f.ownerOrgID, f.projectID, domain.CreateShareLink{
		SessionID: f.sessionID,
		Role:      "viewer",
	})
	if err != nil {
		t.Fatalf("create share link: %v", err)
	}
	if _, err := f.store.RedeemProjectShareLink(ctx, f.other, f.ownerOrgID, token); err != nil {
		t.Fatalf("redeem share link (first): %v", err)
	}
	if _, err := f.store.RedeemProjectShareLink(ctx, f.other, f.ownerOrgID, token); err != nil {
		t.Fatalf("redeem share link (second): %v", err)
	}
	mine, err := f.store.ListSharedProjects(ctx, f.other)
	if err != nil {
		t.Fatalf("list shared projects: %v", err)
	}
	if len(mine) != 1 {
		t.Fatalf("expected exactly one grant after redeeming twice, got %d: %#v", len(mine), mine)
	}
}

func TestTerminalTicketScopesAndPolicyCapForSharedSessions(t *testing.T) {
	t.Parallel()
	f := newShareFixture(t, "terminal-share")
	ctx := context.Background()

	if err := f.store.withOrg(ctx, f.ownerOrgID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`UPDATE ao_sessions SET mode = 'trusted', denied_commands = '{}' WHERE id = $1`,
			f.sessionID,
		)
		return err
	}); err != nil {
		t.Fatalf("set session trusted: %v", err)
	}
	registerTestWorker(t, sandboxFixture{
		store: f.store, principal: f.owner, orgID: f.ownerOrgID,
		projectID: f.projectID, sessionID: f.sessionID,
	})

	// A viewer grant caps the session down to read-only, so an agent-kind
	// ticket must be refused outright — no scope split matters if no ticket
	// issues at all.
	_, viewerToken, err := f.store.CreateProjectShareLink(ctx, f.owner, f.ownerOrgID, f.projectID, domain.CreateShareLink{
		SessionID: f.sessionID, Role: "viewer", ModeCap: "read-only",
	})
	if err != nil {
		t.Fatalf("create viewer share link: %v", err)
	}
	if _, err := f.store.RedeemProjectShareLink(ctx, f.other, f.ownerOrgID, viewerToken); err != nil {
		t.Fatalf("redeem viewer share link: %v", err)
	}
	if _, _, err := f.store.IssueTerminalTicket(ctx, f.other, f.ownerOrgID, f.sessionID, "agent", time.Minute); !errors.Is(err, ErrForbidden) {
		t.Fatalf("viewer agent terminal ticket error = %v, want ErrForbidden", err)
	}

	// An editor grant with no cap leaves the session's own trusted mode
	// alone, so a ticket issues — but scoped to read-only, since role
	// alone (not mode) gates terminal:operate.
	editor, _ := registerTestUser(t, f.store, "editor-"+strings.ToLower(uuid.NewString()[:8])+"@example.com", "editor-"+strings.ToLower(uuid.NewString()[:8]), time.Now())
	_, editorToken, err := f.store.CreateProjectShareLink(ctx, f.owner, f.ownerOrgID, f.projectID, domain.CreateShareLink{
		SessionID: f.sessionID, Role: "editor",
	})
	if err != nil {
		t.Fatalf("create editor share link: %v", err)
	}
	if _, err := f.store.RedeemProjectShareLink(ctx, editor, f.ownerOrgID, editorToken); err != nil {
		t.Fatalf("redeem editor share link: %v", err)
	}
	_, scopes, err := f.store.IssueTerminalTicket(ctx, editor, f.ownerOrgID, f.sessionID, "agent", time.Minute)
	if err != nil {
		t.Fatalf("editor terminal ticket: %v", err)
	}
	if !slices.Contains(scopes, "terminal:operate") {
		t.Fatalf("editor scopes = %v, want terminal:operate present", scopes)
	}

	// The owner (a member) is unaffected by either grant's cap.
	_, memberScopes, err := f.store.IssueTerminalTicket(ctx, f.owner, f.ownerOrgID, f.sessionID, "agent", time.Minute)
	if err != nil {
		t.Fatalf("member terminal ticket: %v", err)
	}
	if !slices.Contains(memberScopes, "terminal:operate") {
		t.Fatalf("member scopes = %v, want terminal:operate present", memberScopes)
	}
}

func TestListProjectShareGrantsShowsRecipientIdentity(t *testing.T) {
	t.Parallel()
	f := newShareFixture(t, "list-grants")
	ctx := context.Background()

	_, token, err := f.store.CreateProjectShareLink(ctx, f.owner, f.ownerOrgID, f.projectID, domain.CreateShareLink{
		Role: "editor",
	})
	if err != nil {
		t.Fatalf("create share link: %v", err)
	}
	if _, err := f.store.RedeemProjectShareLink(ctx, f.other, f.ownerOrgID, token); err != nil {
		t.Fatalf("redeem share link: %v", err)
	}
	if _, err := f.store.ListProjectShareGrants(ctx, f.other, f.ownerOrgID, f.projectID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-member list grants error = %v, want ErrForbidden", err)
	}
	grants, err := f.store.ListProjectShareGrants(ctx, f.owner, f.ownerOrgID, f.projectID)
	if err != nil {
		t.Fatalf("owner list grants: %v", err)
	}
	if len(grants) != 1 || grants[0].Grant.UserEmail != f.other.Email {
		t.Fatalf("grants = %#v, want one grant for %s", grants, f.other.Email)
	}
}

func TestListSharedProjectSessionsRequiresAWholeProjectGrant(t *testing.T) {
	t.Parallel()
	f := newShareFixture(t, "shared-sessions")
	ctx := context.Background()

	_, sessionScopedToken, err := f.store.CreateProjectShareLink(ctx, f.owner, f.ownerOrgID, f.projectID, domain.CreateShareLink{
		SessionID: f.sessionID,
		Role:      "viewer",
	})
	if err != nil {
		t.Fatalf("create session-scoped share link: %v", err)
	}
	if _, err := f.store.RedeemProjectShareLink(ctx, f.other, f.ownerOrgID, sessionScopedToken); err != nil {
		t.Fatalf("redeem session-scoped share link: %v", err)
	}
	if _, err := f.store.ListSharedProjectSessions(ctx, f.other, f.ownerOrgID, f.projectID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("session-scoped grant list sessions error = %v, want ErrForbidden", err)
	}

	third, _ := registerTestUser(t, f.store, "wholeproj-"+strings.ToLower(uuid.NewString()[:8])+"@example.com", "wholeproj-"+strings.ToLower(uuid.NewString()[:8]), time.Now())
	_, wholeProjectToken, err := f.store.CreateProjectShareLink(ctx, f.owner, f.ownerOrgID, f.projectID, domain.CreateShareLink{
		Role: "viewer",
	})
	if err != nil {
		t.Fatalf("create whole-project share link: %v", err)
	}
	if _, err := f.store.RedeemProjectShareLink(ctx, third, f.ownerOrgID, wholeProjectToken); err != nil {
		t.Fatalf("redeem whole-project share link: %v", err)
	}
	sessions, err := f.store.ListSharedProjectSessions(ctx, third, f.ownerOrgID, f.projectID)
	if err != nil {
		t.Fatalf("whole-project grant list sessions: %v", err)
	}
	if len(sessions) != 1 || sessions[0].ID != f.sessionID {
		t.Fatalf("shared project sessions = %#v", sessions)
	}
}

func TestListProjectShareLinksIsScopedToTheProjectsOrg(t *testing.T) {
	t.Parallel()
	f := newShareFixture(t, "list-links")
	ctx := context.Background()

	if _, _, err := f.store.CreateProjectShareLink(ctx, f.owner, f.ownerOrgID, f.projectID, domain.CreateShareLink{
		Role: "viewer",
	}); err != nil {
		t.Fatalf("create share link: %v", err)
	}
	if _, err := f.store.ListProjectShareLinks(ctx, f.other, f.ownerOrgID, f.projectID); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-member list links error = %v, want ErrForbidden", err)
	}
	links, err := f.store.ListProjectShareLinks(ctx, f.owner, f.ownerOrgID, f.projectID)
	if err != nil {
		t.Fatalf("owner list links: %v", err)
	}
	if len(links) != 1 {
		t.Fatalf("expected one link, got %d", len(links))
	}
}
