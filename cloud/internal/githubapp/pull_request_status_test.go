package githubapp

import (
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/pkg/contract"
)

func TestAggregateCIStateHasNoOverride(t *testing.T) {
	for name, test := range map[string]struct {
		checks []CheckRun
		want   contract.CIState
	}{
		"no checks": {checks: nil, want: contract.CIUnknown},
		"all passing": {
			checks: []CheckRun{
				{Status: "completed", Conclusion: "success"},
				{Status: "completed", Conclusion: "neutral"},
				{Status: "completed", Conclusion: "skipped"},
			},
			want: contract.CIPassing,
		},
		"still running": {
			checks: []CheckRun{
				{Status: "completed", Conclusion: "success"},
				{Status: "in_progress"},
			},
			want: contract.CIPending,
		},
		"one failure wins over pass and pending": {
			checks: []CheckRun{
				{Status: "completed", Conclusion: "success"},
				{Status: "queued"},
				{Status: "completed", Conclusion: "failure"},
			},
			want: contract.CIFailing,
		},
		"timed out counts as failing": {
			checks: []CheckRun{{Status: "completed", Conclusion: "timed_out"}},
			want:   contract.CIFailing,
		},
		"action required counts as failing": {
			checks: []CheckRun{{Status: "completed", Conclusion: "action_required"}},
			want:   contract.CIFailing,
		},
	} {
		t.Run(name, func(t *testing.T) {
			if got := aggregateCIState(test.checks); got != test.want {
				t.Fatalf("aggregateCIState() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestAggregateReviewStateUsesEachReviewersLatestDecisiveVerdict(t *testing.T) {
	now := time.Now()
	for name, test := range map[string]struct {
		reviews []PullRequestReview
		want    contract.ReviewDecision
	}{
		"no reviews": {reviews: nil, want: contract.ReviewNone},
		"single approval": {
			reviews: []PullRequestReview{
				{ID: 1, User: User{Login: "alice"}, State: "APPROVED", SubmittedAt: now},
			},
			want: contract.ReviewApproved,
		},
		"changes requested wins over an approval from someone else": {
			reviews: []PullRequestReview{
				{ID: 1, User: User{Login: "alice"}, State: "APPROVED", SubmittedAt: now},
				{ID: 2, User: User{Login: "bob"}, State: "CHANGES_REQUESTED", SubmittedAt: now},
			},
			want: contract.ReviewChangesRequest,
		},
		"a later approval supersedes the same reviewer's earlier changes request": {
			reviews: []PullRequestReview{
				{ID: 1, User: User{Login: "alice"}, State: "CHANGES_REQUESTED", SubmittedAt: now},
				{ID: 2, User: User{Login: "alice"}, State: "APPROVED", SubmittedAt: now.Add(time.Hour)},
			},
			want: contract.ReviewApproved,
		},
		"comments and pending reviews are not decisions": {
			reviews: []PullRequestReview{
				{ID: 1, User: User{Login: "alice"}, State: "COMMENTED", SubmittedAt: now},
				{ID: 2, User: User{Login: "bob"}, State: "PENDING", SubmittedAt: now},
			},
			want: contract.ReviewNone,
		},
		"a dismissed changes-request does not linger": {
			reviews: []PullRequestReview{
				{ID: 1, User: User{Login: "alice"}, State: "CHANGES_REQUESTED", SubmittedAt: now},
				{ID: 2, User: User{Login: "alice"}, State: "DISMISSED", SubmittedAt: now.Add(time.Hour)},
			},
			want: contract.ReviewNone,
		},
	} {
		t.Run(name, func(t *testing.T) {
			if got := aggregateReviewState(test.reviews); got != test.want {
				t.Fatalf("aggregateReviewState() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestMapMergeability(t *testing.T) {
	for state, want := range map[string]contract.Mergeability{
		"dirty":    contract.MergeConflicting,
		"blocked":  contract.MergeBlocked,
		"behind":   contract.MergeBlocked,
		"unstable": contract.MergeUnstable,
		"clean":    contract.MergeMergeable,
		"unknown":  contract.MergeUnknown,
		"draft":    contract.MergeUnknown,
		"":         contract.MergeUnknown,
	} {
		t.Run(state, func(t *testing.T) {
			if got := mapMergeability(PullRequestDetail{MergeableState: state}); got != want {
				t.Fatalf("mapMergeability(%q) = %v, want %v", state, got, want)
			}
		})
	}
}

func TestPullRequestLifecycleState(t *testing.T) {
	for name, test := range map[string]struct {
		detail PullRequestDetail
		want   contract.PRState
	}{
		"merged wins over closed": {
			detail: PullRequestDetail{Merged: true, State: "closed"},
			want:   contract.PRStateMerged,
		},
		"closed": {
			detail: PullRequestDetail{State: "closed"},
			want:   contract.PRStateClosed,
		},
		"open draft": {
			detail: PullRequestDetail{State: "open", Draft: true},
			want:   contract.PRStateDraft,
		},
		"open": {
			detail: PullRequestDetail{State: "open"},
			want:   contract.PRStateOpen,
		},
	} {
		t.Run(name, func(t *testing.T) {
			if got := pullRequestLifecycleState(test.detail); got != test.want {
				t.Fatalf("pullRequestLifecycleState() = %v, want %v", got, test.want)
			}
		})
	}
}
