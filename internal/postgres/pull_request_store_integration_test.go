package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/pkg/contract"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type pullRequestFixture struct {
	store     *Store
	principal domain.Principal
	orgID     string
	sessionID string
}

// newPullRequestFixture creates an isolated organization, project, and
// session that a pull request record can legally reference.
func newPullRequestFixture(t *testing.T, label string) pullRequestFixture {
	t.Helper()
	unique := strings.ToLower(uuid.NewString()[:8])
	email := label + "-" + unique + "@example.com"
	slug := label + "-" + unique
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

	now := time.Now()
	principal, orgID := registerTestUser(t, store, email, slug, now)
	project, err := store.CreateProject(ctx, principal, orgID, slug+"-project-key", domain.CreateProject{
		DisplayName:   "Pull request fixture",
		RepositoryURL: "https://github.com/example/repo.git",
		DefaultBranch: "main",
	})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	session, err := store.CreateSession(ctx, principal, orgID, slug+"-session-key", 100, domain.CreateSession{
		ProjectID:   project.ID,
		Kind:        "worker",
		Harness:     "claude-code",
		DisplayName: "Pull request fixture session",
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
	return pullRequestFixture{store: store, principal: principal, orgID: orgID, sessionID: session.ID}
}

func TestCreatePullRequestRecordPersistsWithDefaults(t *testing.T) {
	t.Parallel()
	fixture := newPullRequestFixture(t, "pr-create")
	ctx := context.Background()

	created, err := fixture.store.CreatePullRequestRecord(
		ctx, fixture.orgID, fixture.sessionID,
		"github", "acme/api", "octocat", 42,
		"https://github.com/acme/api/pull/42", "feat/fix", "main", "deadbeef", "Fix the thing",
		12, 3, 2,
	)
	if err != nil {
		t.Fatalf("create pull request record: %v", err)
	}
	if created.ID == "" || created.OrgID != fixture.orgID || created.SessionID != fixture.sessionID {
		t.Fatalf("created record = %#v", created)
	}
	if created.Provider != "github" || created.Repository != "acme/api" || created.Author != "octocat" || created.Number != 42 {
		t.Fatalf("created record identity = %#v", created)
	}
	if created.Additions != 12 || created.Deletions != 3 || created.ChangedFiles != 2 {
		t.Fatalf("created record diff stats = %#v", created)
	}
	if created.State != contract.PRStateOpen || created.Draft {
		t.Fatalf("created record state = %v, draft = %v, want open/non-draft", created.State, created.Draft)
	}
	if created.ClaimedBySessionID == nil || *created.ClaimedBySessionID != fixture.sessionID || created.ClaimedAt == nil {
		t.Fatalf("created record claim = %#v, want owner session claim", created)
	}
	if created.CIState != contract.CIUnknown || created.ReviewState != contract.ReviewNone ||
		created.Mergeability != contract.MergeUnknown || created.AOReviewState != contract.AOReviewNeedsReview {
		t.Fatalf("created record defaults = %#v", created)
	}

	fetched, err := fixture.store.GetPullRequest(ctx, fixture.orgID, created.ID)
	if err != nil {
		t.Fatalf("get pull request: %v", err)
	}
	if fetched.ID != created.ID || fetched.URL != created.URL || fetched.HeadSHA != created.HeadSHA ||
		fetched.SourceBranch != created.SourceBranch || fetched.TargetBranch != created.TargetBranch ||
		fetched.Title != created.Title || fetched.State != created.State {
		t.Fatalf("fetched = %#v, want %#v", fetched, created)
	}
}

func TestListPullRequestsBySessionReturnsMostRecentFirst(t *testing.T) {
	t.Parallel()
	fixture := newPullRequestFixture(t, "pr-list")
	ctx := context.Background()

	first, err := fixture.store.CreatePullRequestRecord(
		ctx, fixture.orgID, fixture.sessionID,
		"github", "acme/api", "octocat", 1,
		"https://github.com/acme/api/pull/1", "feat/first", "main", "sha1", "First",
		0, 0, 0,
	)
	if err != nil {
		t.Fatalf("create first pull request: %v", err)
	}
	second, err := fixture.store.CreatePullRequestRecord(
		ctx, fixture.orgID, fixture.sessionID,
		"github", "acme/api", "octocat", 2,
		"https://github.com/acme/api/pull/2", "feat/second", "main", "sha2", "Second",
		0, 0, 0,
	)
	if err != nil {
		t.Fatalf("create second pull request: %v", err)
	}

	list, err := fixture.store.ListPullRequestsBySession(ctx, fixture.principal, fixture.orgID, fixture.sessionID)
	if err != nil {
		t.Fatalf("list pull requests: %v", err)
	}
	if len(list) != 2 || list[0].ID != second.ID || list[1].ID != first.ID {
		t.Fatalf("list = %#v, want [second, first]", list)
	}
}

func TestClaimPullRequestRecordUpsertsTheWorkerOwnedProjection(t *testing.T) {
	t.Parallel()
	fixture := newPullRequestFixture(t, "pr-claim")
	ctx := context.Background()

	created, err := fixture.store.CreatePullRequestRecord(
		ctx, fixture.orgID, fixture.sessionID,
		"github", "acme/api", "octocat", 7,
		"https://github.com/acme/api/pull/7", "feat/old", "main", "oldsha", "Old title",
		0, 0, 0,
	)
	if err != nil {
		t.Fatalf("create pull request record: %v", err)
	}
	claimed, err := fixture.store.ClaimPullRequestRecord(ctx, fixture.orgID, fixture.sessionID, domain.PullRequest{
		Provider: "github", Repository: "acme/api", Author: "octocat", Number: 7,
		URL: "https://github.com/acme/api/pull/7", Title: "Updated title", State: contract.PRStateOpen,
		HeadSHA: "newsha", SourceBranch: "feat/new", TargetBranch: "main",
		Additions: 4, Deletions: 1, ChangedFiles: 2,
	})
	if err != nil {
		t.Fatalf("claim pull request record: %v", err)
	}
	if claimed.ID != created.ID || claimed.Title != "Updated title" || claimed.SourceBranch != "feat/new" ||
		claimed.HeadSHA != "newsha" || claimed.ClaimedBySessionID == nil ||
		*claimed.ClaimedBySessionID != fixture.sessionID || claimed.ClaimedAt == nil {
		t.Fatalf("claimed record = %#v", claimed)
	}
	list, err := fixture.store.ListPullRequestsBySession(ctx, fixture.principal, fixture.orgID, fixture.sessionID)
	if err != nil {
		t.Fatalf("list pull requests: %v", err)
	}
	if len(list) != 1 || list[0].ID != created.ID {
		t.Fatalf("list = %#v", list)
	}
}

func TestPullRequestRecordIsIsolatedByOrganization(t *testing.T) {
	t.Parallel()
	owner := newPullRequestFixture(t, "pr-owner")
	other := newPullRequestFixture(t, "pr-other")
	ctx := context.Background()

	created, err := owner.store.CreatePullRequestRecord(
		ctx, owner.orgID, owner.sessionID,
		"github", "acme/api", "octocat", 9,
		"https://github.com/acme/api/pull/9", "feat/fix", "main", "deadbeef", "Fix the thing",
		0, 0, 0,
	)
	if err != nil {
		t.Fatalf("create pull request record: %v", err)
	}

	if _, err := other.store.GetPullRequest(ctx, other.orgID, created.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("cross-tenant get error = %v, want ErrNotFound", err)
	}
	list, err := other.store.ListPullRequestsBySession(ctx, other.principal, other.orgID, owner.sessionID)
	if err != nil {
		t.Fatalf("list pull requests: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("cross-tenant list = %#v, want empty", list)
	}
}

func TestCreatePullRequestRecordRejectsDuplicateNumber(t *testing.T) {
	t.Parallel()
	fixture := newPullRequestFixture(t, "pr-dup")
	ctx := context.Background()

	if _, err := fixture.store.CreatePullRequestRecord(
		ctx, fixture.orgID, fixture.sessionID,
		"github", "acme/api", "octocat", 5,
		"https://github.com/acme/api/pull/5", "feat/fix", "main", "deadbeef", "Fix the thing",
		0, 0, 0,
	); err != nil {
		t.Fatalf("create pull request record: %v", err)
	}
	_, err := fixture.store.CreatePullRequestRecord(
		ctx, fixture.orgID, fixture.sessionID,
		"github", "acme/api", "octocat", 5,
		"https://github.com/acme/api/pull/5", "feat/fix-again", "main", "beadfeed", "Fix the thing again",
		0, 0, 0,
	)
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate create error = %v, want ErrConflict", err)
	}
}

func TestOpenPullRequestRefsListsAcrossOrganizations(t *testing.T) {
	t.Parallel()
	first := newPullRequestFixture(t, "pr-open-refs-a")
	second := newPullRequestFixture(t, "pr-open-refs-b")
	ctx := context.Background()

	openPR, err := first.store.CreatePullRequestRecord(
		ctx, first.orgID, first.sessionID,
		"github", "acme/api", "octocat", 1,
		"https://github.com/acme/api/pull/1", "feat/open", "main", "sha-open", "Open PR",
		0, 0, 0,
	)
	if err != nil {
		t.Fatalf("create open pull request: %v", err)
	}
	closedPR, err := second.store.CreatePullRequestRecord(
		ctx, second.orgID, second.sessionID,
		"github", "acme/other", "octocat", 2,
		"https://github.com/acme/other/pull/2", "feat/closed", "main", "sha-closed", "Closed PR",
		0, 0, 0,
	)
	if err != nil {
		t.Fatalf("create pull request to close: %v", err)
	}
	if _, err := second.store.UpdatePullRequestObservation(ctx, second.orgID, closedPR.ID, domain.PullRequestObservation{
		State: contract.PRStateClosed, HeadSHA: closedPR.HeadSHA,
		CIState: contract.CIUnknown, ReviewState: contract.ReviewNone, Mergeability: contract.MergeUnknown,
	}); err != nil {
		t.Fatalf("close pull request: %v", err)
	}

	refs, err := first.store.OpenPullRequestRefs(ctx)
	if err != nil {
		t.Fatalf("open pull request refs: %v", err)
	}
	var sawOpen, sawClosed bool
	for _, ref := range refs {
		switch ref.ID {
		case openPR.ID:
			sawOpen = true
			if ref.OrgID != first.orgID || ref.Repository != "acme/api" || ref.Number != 1 {
				t.Fatalf("open ref = %#v", ref)
			}
		case closedPR.ID:
			sawClosed = true
		}
	}
	if !sawOpen {
		t.Fatalf("refs = %#v, want the still-open PR from a different fixture", refs)
	}
	if sawClosed {
		t.Fatalf("refs = %#v, want the closed PR excluded", refs)
	}
}

func TestUpdatePullRequestObservationAppliesFreshState(t *testing.T) {
	t.Parallel()
	fixture := newPullRequestFixture(t, "pr-observe")
	ctx := context.Background()

	created, err := fixture.store.CreatePullRequestRecord(
		ctx, fixture.orgID, fixture.sessionID,
		"github", "acme/api", "octocat", 3,
		"https://github.com/acme/api/pull/3", "feat/observe", "main", "sha-1", "Observe me",
		0, 0, 0,
	)
	if err != nil {
		t.Fatalf("create pull request record: %v", err)
	}

	updated, err := fixture.store.UpdatePullRequestObservation(ctx, fixture.orgID, created.ID, domain.PullRequestObservation{
		State: contract.PRStateDraft, Draft: true, HeadSHA: "sha-2",
		Additions: 40, Deletions: 5, ChangedFiles: 3,
		CIState: contract.CIFailing, ReviewState: contract.ReviewChangesRequest, Mergeability: contract.MergeConflicting,
	})
	if err != nil {
		t.Fatalf("update pull request observation: %v", err)
	}
	if updated.State != contract.PRStateDraft || !updated.Draft || updated.HeadSHA != "sha-2" ||
		updated.Additions != 40 || updated.Deletions != 5 || updated.ChangedFiles != 3 ||
		updated.CIState != contract.CIFailing || updated.ReviewState != contract.ReviewChangesRequest ||
		updated.Mergeability != contract.MergeConflicting {
		t.Fatalf("updated = %#v", updated)
	}
	if updated.ObservedAt.IsZero() {
		t.Fatal("updated.ObservedAt is zero, want it stamped on observation")
	}

	// The draft PR row is excluded from OpenPullRequestRefs's raw state
	// filter only for closed/merged PRs — draft is still "open" at the DB
	// level, so it must still show up as a refresh candidate.
	refs, err := fixture.store.OpenPullRequestRefs(ctx)
	if err != nil {
		t.Fatalf("open pull request refs: %v", err)
	}
	var found bool
	for _, ref := range refs {
		found = found || ref.ID == created.ID
	}
	if !found {
		t.Fatalf("refs = %#v, want the draft PR still listed as open", refs)
	}
}

// seedGitHubRepositoryGrant inserts the minimal GitHub installation,
// repository, and active grant a background job needs to resolve an
// installation for a repository without any session in the picture.
func seedGitHubRepositoryGrant(
	t *testing.T, store *Store, principal domain.Principal, orgID string,
	installationID, repositoryID int64, fullName string,
) {
	t.Helper()
	ctx := context.Background()
	_, name, _ := strings.Cut(fullName, "/")
	if _, err := store.pool.Exec(ctx,
		`INSERT INTO ao_github_repositories (
			github_repository_id, github_owner_account_id, name, full_name,
			html_url, clone_url, visibility
		) VALUES ($1, $2, $3, $4, $5, $6, 'public')`,
		repositoryID, installationID+2_000_000, name, fullName,
		"https://github.com/"+fullName, "https://github.com/"+fullName+".git",
	); err != nil {
		t.Fatalf("seed github repository: %v", err)
	}
	var installationRowID string
	if err := store.withOrg(ctx, orgID, func(tx pgx.Tx) error {
		if err := tx.QueryRow(ctx,
			`INSERT INTO ao_github_installations (
				org_id, github_installation_id, github_account_id, account_login,
				account_type, repository_selection, installed_by_user_id
			) VALUES ($1, $2, $3, 'acme', 'Organization', 'all', $4)
			RETURNING id`,
			orgID, installationID, installationID+1_000_000, principal.UserID,
		).Scan(&installationRowID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`INSERT INTO ao_github_repository_grants (
				org_id, installation_id, github_repository_id, repository_selection
			) VALUES ($1, $2, $3, 'all')`,
			orgID, installationRowID, repositoryID,
		)
		return err
	}); err != nil {
		t.Fatalf("seed github installation and grant: %v", err)
	}
}

func TestGitHubInstallationForRepositoryResolvesTheActiveGrant(t *testing.T) {
	t.Parallel()
	fixture := newPullRequestFixture(t, "pr-install-resolve")
	seedGitHubRepositoryGrant(t, fixture.store, fixture.principal, fixture.orgID, 501, 9001, "acme/api")

	installationID, repositoryID, err := fixture.store.GitHubInstallationForRepository(
		context.Background(), fixture.orgID, "acme/api",
	)
	if err != nil {
		t.Fatalf("github installation for repository: %v", err)
	}
	if installationID != 501 || repositoryID != 9001 {
		t.Fatalf("installationID = %d, repositoryID = %d", installationID, repositoryID)
	}
}

func TestGitHubInstallationForRepositoryFailsClosedWithNoGrant(t *testing.T) {
	t.Parallel()
	fixture := newPullRequestFixture(t, "pr-install-missing")

	if _, _, err := fixture.store.GitHubInstallationForRepository(
		context.Background(), fixture.orgID, "acme/never-granted",
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("error = %v, want ErrNotFound", err)
	}
}

func TestPRFactsBySessionDrivesPRLifecycleSessionStatus(t *testing.T) {
	t.Parallel()
	fixture := newPullRequestFixture(t, "pr-facts-status")
	ctx := context.Background()

	created := createTestPullRequest(t, fixture, 21, "sha-1")
	if _, err := fixture.store.UpdatePullRequestObservation(ctx, fixture.orgID, created.ID, domain.PullRequestObservation{
		State: contract.PRStateOpen, HeadSHA: "sha-1",
		CIState: contract.CIFailing, ReviewState: contract.ReviewNone, Mergeability: contract.MergeUnknown,
	}); err != nil {
		t.Fatalf("update pull request observation: %v", err)
	}

	facts, err := fixture.store.PRFactsBySession(ctx, fixture.orgID, []string{fixture.sessionID})
	if err != nil {
		t.Fatalf("pr facts by session: %v", err)
	}
	sessionFacts := facts[fixture.sessionID]
	if len(sessionFacts) != 1 || sessionFacts[0].URL != created.URL || sessionFacts[0].CI != contract.CIFailing {
		t.Fatalf("facts = %#v", sessionFacts)
	}

	// This is the exact call listSessions/getSession make: it must resolve
	// to a PR-lifecycle status (ci_failed), not just an activity status —
	// this is what makes the board actually reflect PR state, matching the
	// local desktop app's status derivation.
	session := domain.Session{ActivityState: "idle", UpdatedAt: time.Now()}
	if status := session.Status(time.Now(), sessionFacts); status != contract.StatusCIFailed {
		t.Fatalf("status = %v, want ci_failed", status)
	}

	// A session with no pull requests must be unaffected — facts[sessionID]
	// for an unknown session is nil, and Status must still fall back to a
	// plain activity status rather than erroring.
	otherFacts := facts["00000000-0000-0000-0000-000000000000"]
	if status := session.Status(time.Now(), otherFacts); status != contract.StatusIdle {
		t.Fatalf("status with no PR facts = %v, want idle", status)
	}
}
