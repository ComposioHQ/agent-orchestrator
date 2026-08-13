package domain

import (
	"encoding/json"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/pkg/contract"
)

// PullRequest is the durable record of one PR AO Cloud raised or is tracking
// on GitHub's behalf. It persists into the ao_pull_requests table that
// predates this feature (see migration 00001), so its shape follows that
// table's existing columns rather than inventing a parallel one. Status
// fields reuse the public agent-orchestrator repo's contract enums directly
// (contract.CIState, contract.ReviewDecision, contract.Mergeability,
// contract.AOReviewState) so the same status-derivation rules the local
// desktop app already has apply here too.
//
// State follows contract.PRState, including PRStateDraft, even though the
// underlying state column only stores GitHub's raw open/closed/merged value
// (draft-ness is tracked separately in Draft) — a draft-open row is exposed
// here as PRStateDraft to match the public contract's derivation rules.
type PullRequest struct {
	ID                 string
	OrgID              string
	SessionID          string
	Provider           string
	Repository         string
	Author             string
	Number             int
	URL                string
	Title              string
	State              contract.PRState
	Draft              bool
	HeadSHA            string
	SourceBranch       string
	TargetBranch       string
	Additions          int
	Deletions          int
	ChangedFiles       int
	CIState            contract.CIState
	ReviewState        contract.ReviewDecision
	Mergeability       contract.Mergeability
	Checks             json.RawMessage
	ClaimedBySessionID *string
	ClaimedAt          *time.Time
	ReleasedAt         *time.Time
	AOReviewState      contract.AOReviewState
	ObservedAt         time.Time
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

// RaisePullRequest is the input to open a new pull request for a session.
type RaisePullRequest struct {
	Title      string
	Body       string
	HeadBranch string
	BaseBranch string
}

// PullRequestRef is the minimal identity a background status poller needs to
// refresh one open pull request, without loading the rest of its record.
type PullRequestRef struct {
	ID         string
	OrgID      string
	Provider   string
	Repository string
	Number     int
}

// PullRequestObservation is a freshly fetched snapshot of a pull request's
// lifecycle and status, applied over its durable record on refresh. It never
// touches AOReviewState — that summary is owned by AO's own review runs, not
// by observing GitHub.
type PullRequestObservation struct {
	State        contract.PRState
	Draft        bool
	HeadSHA      string
	Additions    int
	Deletions    int
	ChangedFiles int
	CIState      contract.CIState
	ReviewState  contract.ReviewDecision
	Mergeability contract.Mergeability
}

// ReviewRun is one AO-triggered automated review pass against a specific
// commit of a pull request. At most one run exists per (PullRequestID,
// TargetSHA) — see the unique index in migration 00016 — so a review can
// never be triggered twice against the same commit.
type ReviewRun struct {
	ID               string
	OrgID            string
	PullRequestID    string
	ReviewSessionID  string
	TargetSHA        string
	Status           contract.AOReviewRunStatus
	Verdict          contract.AOReviewVerdict
	Body             string
	ProviderReviewID string
	LastError        string
	CreatedAt        time.Time
	CompletedAt      *time.Time
	DeliveredAt      *time.Time
}

// SubmitReviewResult is what a review session reports back once it has
// finished an AO-triggered review pass against a pull request.
type SubmitReviewResult struct {
	Verdict contract.AOReviewVerdict
	Body    string
}

// ReviewRunPullRequest bundles a review run with the identifying fields of
// the pull request it belongs to — everything a verdict submission needs to
// mint a GitHub token and post the review, in one round trip, and everything
// a session's review-state listing needs to group runs by PR without a
// second query.
type ReviewRunPullRequest struct {
	ReviewRun
	PullRequestProvider      string
	PullRequestRepository    string
	PullRequestNumber        int
	PullRequestURL           string
	PullRequestTitle         string
	PullRequestAOReviewState contract.AOReviewState
}
