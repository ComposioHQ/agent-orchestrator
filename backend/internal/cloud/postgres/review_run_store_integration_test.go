package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/worker"
	"github.com/aoagents/agent-orchestrator/backend/pkg/contract"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func createTestPullRequest(t *testing.T, fixture pullRequestFixture, number int, headSHA string) domain.PullRequest {
	t.Helper()
	pr, err := fixture.store.CreatePullRequestRecord(
		context.Background(), fixture.orgID, fixture.sessionID,
		"github", "acme/api", "octocat", number,
		"https://github.com/acme/api/pull/1", "feat/fix", "main", headSHA, "Fix the thing",
		0, 0, 0,
	)
	if err != nil {
		t.Fatalf("create pull request record: %v", err)
	}
	return pr
}

func TestCreateReviewRunIsFencedByCommit(t *testing.T) {
	t.Parallel()
	fixture := newPullRequestFixture(t, "review-fence")
	pr := createTestPullRequest(t, fixture, 1, "sha-1")
	ctx := context.Background()

	first, created, err := fixture.store.CreateReviewRun(ctx, fixture.orgID, pr.ID, fixture.sessionID, pr.HeadSHA)
	if err != nil {
		t.Fatalf("create review run: %v", err)
	}
	if !created || first.Status != contract.AOReviewRunRunning {
		t.Fatalf("first run = %#v, created = %v", first, created)
	}
	fetched, err := fixture.store.GetPullRequest(ctx, fixture.orgID, pr.ID)
	if err != nil {
		t.Fatalf("get pull request: %v", err)
	}
	if fetched.AOReviewState != contract.AOReviewRunning {
		t.Fatalf("ao_review_state = %v, want running", fetched.AOReviewState)
	}

	second, createdAgain, err := fixture.store.CreateReviewRun(ctx, fixture.orgID, pr.ID, fixture.sessionID, pr.HeadSHA)
	if err != nil {
		t.Fatalf("create review run again: %v", err)
	}
	if createdAgain || second.ID != first.ID {
		t.Fatalf("second run = %#v, created = %v, want the same run returned uncreated", second, createdAgain)
	}
}

func TestCompleteAndDeliverReviewRunRecordsVerdictAndUpdatesPullRequestState(t *testing.T) {
	t.Parallel()
	fixture := newPullRequestFixture(t, "review-deliver")
	pr := createTestPullRequest(t, fixture, 2, "sha-1")
	ctx := context.Background()
	run, _, err := fixture.store.CreateReviewRun(ctx, fixture.orgID, pr.ID, fixture.sessionID, pr.HeadSHA)
	if err != nil {
		t.Fatalf("create review run: %v", err)
	}

	delivered, err := fixture.store.CompleteAndDeliverReviewRun(
		ctx, fixture.orgID, run.ID, fixture.sessionID,
		domain.SubmitReviewResult{Verdict: contract.AOReviewVerdictChangesRequested, Body: "Please fix X."},
		"999",
	)
	if err != nil {
		t.Fatalf("complete and deliver review run: %v", err)
	}
	if delivered.Status != contract.AOReviewRunDelivered || delivered.Verdict != contract.AOReviewVerdictChangesRequested ||
		delivered.Body != "Please fix X." || delivered.ProviderReviewID != "999" ||
		delivered.CompletedAt == nil || delivered.DeliveredAt == nil {
		t.Fatalf("delivered = %#v", delivered)
	}
	fetched, err := fixture.store.GetPullRequest(ctx, fixture.orgID, pr.ID)
	if err != nil {
		t.Fatalf("get pull request: %v", err)
	}
	if fetched.AOReviewState != contract.AOReviewChangesRequested {
		t.Fatalf("ao_review_state = %v, want changes_requested", fetched.AOReviewState)
	}
}

func TestCompleteAndDeliverReviewRunIsFencedByOwningSessionAndStatus(t *testing.T) {
	t.Parallel()
	fixture := newPullRequestFixture(t, "review-fence-session")
	pr := createTestPullRequest(t, fixture, 3, "sha-1")
	ctx := context.Background()
	run, _, err := fixture.store.CreateReviewRun(ctx, fixture.orgID, pr.ID, fixture.sessionID, pr.HeadSHA)
	if err != nil {
		t.Fatalf("create review run: %v", err)
	}

	if _, err := fixture.store.CompleteAndDeliverReviewRun(
		ctx, fixture.orgID, run.ID, uuid.NewString(),
		domain.SubmitReviewResult{Verdict: contract.AOReviewVerdictApproved, Body: "Looks good."},
		"1",
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("error = %v, want ErrNotFound for a session that does not own this run", err)
	}

	if _, err := fixture.store.CompleteAndDeliverReviewRun(
		ctx, fixture.orgID, run.ID, fixture.sessionID,
		domain.SubmitReviewResult{Verdict: contract.AOReviewVerdictApproved, Body: "Looks good."},
		"1",
	); err != nil {
		t.Fatalf("complete and deliver review run: %v", err)
	}
	if _, err := fixture.store.CompleteAndDeliverReviewRun(
		ctx, fixture.orgID, run.ID, fixture.sessionID,
		domain.SubmitReviewResult{Verdict: contract.AOReviewVerdictApproved, Body: "Looks good again."},
		"2",
	); !errors.Is(err, ErrNotFound) {
		t.Fatalf("error = %v, want ErrNotFound for a run that is no longer running", err)
	}
}

func TestCompleteAndDeliverReviewRunSkipsAStalePullRequest(t *testing.T) {
	t.Parallel()
	fixture := newPullRequestFixture(t, "review-stale")
	pr := createTestPullRequest(t, fixture, 4, "sha-1")
	ctx := context.Background()
	run, _, err := fixture.store.CreateReviewRun(ctx, fixture.orgID, pr.ID, fixture.sessionID, pr.HeadSHA)
	if err != nil {
		t.Fatalf("create review run: %v", err)
	}

	// The pull request moves on to a new commit while this review is still
	// in flight — the delivered verdict is for a commit that is no longer
	// the PR's head, so it must not overwrite the newer ao_review_state.
	if _, err := fixture.store.UpdatePullRequestObservation(ctx, fixture.orgID, pr.ID, domain.PullRequestObservation{
		State: contract.PRStateOpen, HeadSHA: "sha-2",
		CIState: contract.CIUnknown, ReviewState: contract.ReviewNone, Mergeability: contract.MergeUnknown,
	}); err != nil {
		t.Fatalf("update pull request observation: %v", err)
	}

	if _, err := fixture.store.CompleteAndDeliverReviewRun(
		ctx, fixture.orgID, run.ID, fixture.sessionID,
		domain.SubmitReviewResult{Verdict: contract.AOReviewVerdictApproved, Body: "Looks good."},
		"1",
	); err != nil {
		t.Fatalf("complete and deliver review run: %v", err)
	}
	fetched, err := fixture.store.GetPullRequest(ctx, fixture.orgID, pr.ID)
	if err != nil {
		t.Fatalf("get pull request: %v", err)
	}
	if fetched.AOReviewState != contract.AOReviewRunning {
		t.Fatalf("ao_review_state = %v, want it left at running (the newer state) rather than overwritten", fetched.AOReviewState)
	}
}

func TestFailReviewRunResetsPullRequestToNeedsReview(t *testing.T) {
	t.Parallel()
	fixture := newPullRequestFixture(t, "review-fail")
	pr := createTestPullRequest(t, fixture, 5, "sha-1")
	ctx := context.Background()
	run, _, err := fixture.store.CreateReviewRun(ctx, fixture.orgID, pr.ID, fixture.sessionID, pr.HeadSHA)
	if err != nil {
		t.Fatalf("create review run: %v", err)
	}

	failed, err := fixture.store.FailReviewRun(ctx, fixture.orgID, run.ID, fixture.sessionID, "GitHub rejected the review")
	if err != nil {
		t.Fatalf("fail review run: %v", err)
	}
	if failed.Status != contract.AOReviewRunFailed || failed.LastError != "GitHub rejected the review" ||
		failed.CompletedAt == nil {
		t.Fatalf("failed = %#v", failed)
	}
	fetched, err := fixture.store.GetPullRequest(ctx, fixture.orgID, pr.ID)
	if err != nil {
		t.Fatalf("get pull request: %v", err)
	}
	if fetched.AOReviewState != contract.AOReviewNeedsReview {
		t.Fatalf("ao_review_state = %v, want needs_review", fetched.AOReviewState)
	}
}

func TestReviewRunPullRequestJoinsPullRequestIdentity(t *testing.T) {
	t.Parallel()
	fixture := newPullRequestFixture(t, "review-join")
	pr := createTestPullRequest(t, fixture, 6, "sha-1")
	ctx := context.Background()
	run, _, err := fixture.store.CreateReviewRun(ctx, fixture.orgID, pr.ID, fixture.sessionID, pr.HeadSHA)
	if err != nil {
		t.Fatalf("create review run: %v", err)
	}

	joined, err := fixture.store.ReviewRunPullRequest(ctx, fixture.orgID, run.ID)
	if err != nil {
		t.Fatalf("review run pull request: %v", err)
	}
	if joined.ID != run.ID || joined.PullRequestProvider != "github" ||
		joined.PullRequestRepository != "acme/api" || joined.PullRequestNumber != 6 {
		t.Fatalf("joined = %#v", joined)
	}
}

func TestListReviewRunsBySessionGroupsMostRecentFirstPerPullRequest(t *testing.T) {
	t.Parallel()
	fixture := newPullRequestFixture(t, "review-list-session")
	prA := createTestPullRequest(t, fixture, 10, "sha-a1")
	prB := createTestPullRequest(t, fixture, 11, "sha-b1")
	ctx := context.Background()

	runA1, _, err := fixture.store.CreateReviewRun(ctx, fixture.orgID, prA.ID, fixture.sessionID, "sha-a1")
	if err != nil {
		t.Fatalf("create review run a1: %v", err)
	}
	if _, err := fixture.store.FailReviewRun(ctx, fixture.orgID, runA1.ID, fixture.sessionID, "boom"); err != nil {
		t.Fatalf("fail review run a1: %v", err)
	}
	if _, err := fixture.store.UpdatePullRequestObservation(ctx, fixture.orgID, prA.ID, domain.PullRequestObservation{
		State: contract.PRStateOpen, HeadSHA: "sha-a2",
		CIState: contract.CIUnknown, ReviewState: contract.ReviewNone, Mergeability: contract.MergeUnknown,
	}); err != nil {
		t.Fatalf("advance pr a head sha: %v", err)
	}
	runA2, _, err := fixture.store.CreateReviewRun(ctx, fixture.orgID, prA.ID, fixture.sessionID, "sha-a2")
	if err != nil {
		t.Fatalf("create review run a2: %v", err)
	}
	runB1, _, err := fixture.store.CreateReviewRun(ctx, fixture.orgID, prB.ID, fixture.sessionID, "sha-b1")
	if err != nil {
		t.Fatalf("create review run b1: %v", err)
	}

	runs, err := fixture.store.ListReviewRunsBySession(ctx, fixture.principal, fixture.orgID, fixture.sessionID)
	if err != nil {
		t.Fatalf("list review runs by session: %v", err)
	}
	if len(runs) != 3 {
		t.Fatalf("runs = %#v, want 3", runs)
	}
	// Within pull request A, the most recently created run (a2) sorts before
	// the older one (a1) even though a1 was created first.
	var sawA2BeforeA1, sawB1 bool
	seenA1 := false
	for _, run := range runs {
		switch run.ID {
		case runA2.ID:
			sawA2BeforeA1 = !seenA1
			if run.PullRequestNumber != 10 || run.PullRequestURL != prA.URL {
				t.Fatalf("run a2 identity = %#v", run)
			}
		case runA1.ID:
			seenA1 = true
		case runB1.ID:
			sawB1 = true
			if run.PullRequestNumber != 11 || run.PullRequestURL != prB.URL {
				t.Fatalf("run b1 identity = %#v", run)
			}
		}
	}
	if !sawA2BeforeA1 || !sawB1 {
		t.Fatalf("runs = %#v, want a2 before a1 and b1 present", runs)
	}
}

// asSandboxFixture adapts a pullRequestFixture to the sandboxFixture shape
// registerTestWorker needs — both fixtures share the same store/org/session
// identity, just different helper-struct shapes for their own tests.
func asSandboxFixture(fixture pullRequestFixture) sandboxFixture {
	return sandboxFixture{store: fixture.store, principal: fixture.principal, orgID: fixture.orgID, sessionID: fixture.sessionID}
}

func TestOpenReviewTerminalEnqueuesTerminalOpenThenInput(t *testing.T) {
	t.Parallel()
	fixture := newPullRequestFixture(t, "review-open-terminal")
	workerID, epoch := registerTestWorker(t, asSandboxFixture(fixture))
	pr := createTestPullRequest(t, fixture, 30, "sha-1")
	ctx := context.Background()
	run, _, err := fixture.store.CreateReviewRun(ctx, fixture.orgID, pr.ID, fixture.sessionID, pr.HeadSHA)
	if err != nil {
		t.Fatalf("create review run: %v", err)
	}

	if err := fixture.store.OpenReviewTerminal(
		ctx, fixture.orgID, fixture.sessionID, run.ID, "please review this PR",
	); err != nil {
		t.Fatalf("open review terminal: %v", err)
	}

	openRequest, ok, err := fixture.store.ClaimWorkerRequest(ctx, fixture.orgID, fixture.sessionID, workerID, epoch, time.Minute)
	if err != nil || !ok || openRequest.Kind != "terminal.open" {
		t.Fatalf("open request = %+v, ok = %v, err = %v", openRequest, ok, err)
	}
	var openCommand worker.TerminalCommand
	if err := json.Unmarshal(openRequest.Payload, &openCommand); err != nil || openCommand.TerminalID == "" || openCommand.Kind != "agent" {
		t.Fatalf("open command = %+v, err = %v", openCommand, err)
	}
	if err := fixture.store.CompleteWorkerRequest(
		ctx, fixture.orgID, fixture.sessionID, workerID, openRequest.ID, epoch, openRequest.Attempt, json.RawMessage(`{}`),
	); err != nil {
		t.Fatalf("complete open request: %v", err)
	}

	inputRequest, ok, err := fixture.store.ClaimWorkerRequest(ctx, fixture.orgID, fixture.sessionID, workerID, epoch, time.Minute)
	if err != nil || !ok || inputRequest.Kind != "terminal.input" {
		t.Fatalf("input request = %+v, ok = %v, err = %v", inputRequest, ok, err)
	}
	var inputCommand worker.TerminalCommand
	if err := json.Unmarshal(inputRequest.Payload, &inputCommand); err != nil ||
		inputCommand.TerminalID != openCommand.TerminalID || string(inputCommand.Data) != "please review this PR\r" {
		t.Fatalf("input command = %+v, err = %v", inputCommand, err)
	}

	var storedTerminalID string
	if err := fixture.store.withOrg(ctx, fixture.orgID, func(tx pgx.Tx) error {
		return tx.QueryRow(
			ctx, `SELECT review_terminal_id FROM ao_review_runs WHERE org_id = $1 AND id = $2`,
			fixture.orgID, run.ID,
		).Scan(&storedTerminalID)
	}); err != nil {
		t.Fatalf("read review_terminal_id: %v", err)
	}
	if storedTerminalID != openCommand.TerminalID {
		t.Fatalf("stored review_terminal_id = %q, want %q", storedTerminalID, openCommand.TerminalID)
	}
}

func TestCloseReviewTerminalEnqueuesTerminalClose(t *testing.T) {
	t.Parallel()
	fixture := newPullRequestFixture(t, "review-close-terminal")
	workerID, epoch := registerTestWorker(t, asSandboxFixture(fixture))
	pr := createTestPullRequest(t, fixture, 31, "sha-1")
	ctx := context.Background()
	run, _, err := fixture.store.CreateReviewRun(ctx, fixture.orgID, pr.ID, fixture.sessionID, pr.HeadSHA)
	if err != nil {
		t.Fatalf("create review run: %v", err)
	}
	if err := fixture.store.OpenReviewTerminal(ctx, fixture.orgID, fixture.sessionID, run.ID, "review this"); err != nil {
		t.Fatalf("open review terminal: %v", err)
	}
	// Drain the open+input requests OpenReviewTerminal queued so the close
	// request is the next one claimed.
	for range 2 {
		request, ok, err := fixture.store.ClaimWorkerRequest(ctx, fixture.orgID, fixture.sessionID, workerID, epoch, time.Minute)
		if err != nil || !ok {
			t.Fatalf("drain request: ok = %v, err = %v", ok, err)
		}
		if err := fixture.store.CompleteWorkerRequest(
			ctx, fixture.orgID, fixture.sessionID, workerID, request.ID, epoch, request.Attempt, json.RawMessage(`{}`),
		); err != nil {
			t.Fatalf("complete request: %v", err)
		}
	}

	if err := fixture.store.CloseReviewTerminal(ctx, fixture.orgID, fixture.sessionID, run.ID); err != nil {
		t.Fatalf("close review terminal: %v", err)
	}

	closeRequest, ok, err := fixture.store.ClaimWorkerRequest(ctx, fixture.orgID, fixture.sessionID, workerID, epoch, time.Minute)
	if err != nil || !ok || closeRequest.Kind != "terminal.close" {
		t.Fatalf("close request = %+v, ok = %v, err = %v", closeRequest, ok, err)
	}
}

func TestOpenReviewTerminalFailsClosedWithoutALiveWorker(t *testing.T) {
	t.Parallel()
	fixture := newPullRequestFixture(t, "review-no-worker")
	pr := createTestPullRequest(t, fixture, 32, "sha-1")
	ctx := context.Background()
	run, _, err := fixture.store.CreateReviewRun(ctx, fixture.orgID, pr.ID, fixture.sessionID, pr.HeadSHA)
	if err != nil {
		t.Fatalf("create review run: %v", err)
	}

	if err := fixture.store.OpenReviewTerminal(
		ctx, fixture.orgID, fixture.sessionID, run.ID, "review this",
	); !errors.Is(err, ErrWorkerUnavailable) {
		t.Fatalf("error = %v, want ErrWorkerUnavailable", err)
	}
}
