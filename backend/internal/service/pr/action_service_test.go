package pr

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeActionStore struct {
	pr           domain.PullRequest
	ok           bool
	recordErr    error
	recordCalls  int
	recordedSHA  string
	recordedTime time.Time
}

func (f *fakeActionStore) GetPR(context.Context, string) (domain.PullRequest, bool, error) {
	return f.pr, f.ok, nil
}

func (f *fakeActionStore) RecordPRMerge(_ context.Context, _ string, mergeCommitSHA string, mergedAt time.Time) (domain.PullRequest, error) {
	f.recordCalls++
	f.recordedSHA = mergeCommitSHA
	f.recordedTime = mergedAt
	if f.recordErr != nil {
		return domain.PullRequest{}, f.recordErr
	}
	f.pr.Merged = true
	f.pr.Draft = false
	f.pr.Closed = false
	f.pr.MergeCommitSHA = mergeCommitSHA
	f.pr.StateChangedAt = mergedAt
	return f.pr, nil
}

type fakeActionLifecycle struct {
	observations []ports.SCMObservation
	sessionIDs   []domain.SessionID
	err          error
}

func (f *fakeActionLifecycle) ApplySCMObservation(_ context.Context, id domain.SessionID, obs ports.SCMObservation) error {
	f.sessionIDs = append(f.sessionIDs, id)
	f.observations = append(f.observations, obs)
	return f.err
}

type fakeSCMAction struct {
	observation ports.SCMObservation
	review      ports.SCMReviewObservation
	mergeErr    error
	request     ports.SCMMergeRequest
	mergeCalls  int
}

func (f *fakeSCMAction) FetchPullRequests(context.Context, []ports.SCMPRRef) ([]ports.SCMObservation, error) {
	return []ports.SCMObservation{f.observation}, nil
}

func (f *fakeSCMAction) FetchReviewThreads(context.Context, ports.SCMPRRef) (ports.SCMReviewObservation, error) {
	return f.review, nil
}

func (f *fakeSCMAction) MergePullRequest(_ context.Context, request ports.SCMMergeRequest) (ports.SCMMergeResult, error) {
	f.mergeCalls++
	f.request = request
	return ports.SCMMergeResult{MergeCommitSHA: "merge-sha"}, f.mergeErr
}

func mergeableActionFixture() (domain.PullRequest, *fakeSCMAction) {
	pr := domain.PullRequest{
		URL:          "https://github.com/acme/widgets/pull/42",
		SessionID:    "session-1",
		Number:       42,
		Provider:     "github",
		Host:         "github.com",
		Repo:         "acme/widgets",
		HeadSHA:      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Mergeability: domain.MergeMergeable,
	}
	scm := &fakeSCMAction{observation: ports.SCMObservation{
		Fetched:      true,
		PR:           ports.SCMPRObservation{URL: pr.URL, Number: pr.Number, HeadSHA: pr.HeadSHA},
		CI:           ports.SCMCIObservation{Summary: string(domain.CIPassing), HeadSHA: pr.HeadSHA},
		Mergeability: ports.SCMMergeabilityObservation{State: string(domain.MergeMergeable), Mergeable: true},
	}}
	return pr, scm
}

func TestActionServiceMerge_GuardsAndSquashMergesExactHead(t *testing.T) {
	pr, scm := mergeableActionFixture()
	store := &fakeActionStore{pr: pr, ok: true}
	lifecycle := &fakeActionLifecycle{}
	mergedAt := time.Date(2026, 8, 15, 2, 0, 0, 0, time.UTC)
	svc := NewActionService(ActionDeps{Store: store, Reader: scm, Merger: scm, Lifecycle: lifecycle, Clock: func() time.Time { return mergedAt }})
	result, err := svc.Merge(context.Background(), MergeRequest{PRID: "42", PRURL: pr.URL, ExpectedHeadSHA: pr.HeadSHA})
	if err != nil {
		t.Fatal(err)
	}
	if result.PRNumber != 42 || result.Method != "squash" || result.MergeCommitSHA != "merge-sha" {
		t.Fatalf("result = %#v", result)
	}
	if scm.mergeCalls != 1 || scm.request.ExpectedHeadSHA != pr.HeadSHA || scm.request.Method != ports.SCMMergeSquash {
		t.Fatalf("request = %#v, calls = %d", scm.request, scm.mergeCalls)
	}
	if store.recordCalls != 1 || store.recordedSHA != "merge-sha" || !store.recordedTime.Equal(mergedAt) {
		t.Fatalf("merge projection = calls %d sha %q time %s", store.recordCalls, store.recordedSHA, store.recordedTime)
	}
	if len(lifecycle.observations) != 1 || lifecycle.sessionIDs[0] != pr.SessionID {
		t.Fatalf("lifecycle projection = sessions %#v observations %#v", lifecycle.sessionIDs, lifecycle.observations)
	}
	projected := lifecycle.observations[0]
	if !projected.PR.Merged || projected.PR.Closed || projected.PR.Draft || projected.PR.MergeCommitSHA != "merge-sha" || !projected.ObservedAt.Equal(mergedAt) {
		t.Fatalf("projected merged observation = %+v", projected)
	}
}

func TestActionServiceMerge_ProjectionFailureDoesNotMisreportProviderMerge(t *testing.T) {
	pr, scm := mergeableActionFixture()
	store := &fakeActionStore{pr: pr, ok: true, recordErr: errors.New("disk full")}
	var logs bytes.Buffer
	svc := NewActionService(ActionDeps{
		Store: store, Reader: scm, Merger: scm,
		Logger: slog.New(slog.NewTextHandler(&logs, nil)),
	})
	result, err := svc.Merge(context.Background(), MergeRequest{PRID: "42", PRURL: pr.URL, ExpectedHeadSHA: pr.HeadSHA})
	if err != nil || result.MergeCommitSHA != "merge-sha" {
		t.Fatalf("provider merge should remain successful: result=%+v err=%v", result, err)
	}
	if store.recordCalls != 1 || !bytes.Contains(logs.Bytes(), []byte("durable projection failed")) {
		t.Fatalf("projection failure was not attempted/logged: calls=%d logs=%q", store.recordCalls, logs.String())
	}
}

func TestActionServiceMerge_LifecycleFailureDoesNotMisreportProviderMerge(t *testing.T) {
	pr, scm := mergeableActionFixture()
	store := &fakeActionStore{pr: pr, ok: true}
	lifecycle := &fakeActionLifecycle{err: errors.New("lifecycle unavailable")}
	var logs bytes.Buffer
	svc := NewActionService(ActionDeps{
		Store: store, Reader: scm, Merger: scm, Lifecycle: lifecycle,
		Logger: slog.New(slog.NewTextHandler(&logs, nil)),
	})
	result, err := svc.Merge(context.Background(), MergeRequest{PRID: "42", PRURL: pr.URL, ExpectedHeadSHA: pr.HeadSHA})
	if err != nil || result.MergeCommitSHA != "merge-sha" {
		t.Fatalf("provider merge should remain successful: result=%+v err=%v", result, err)
	}
	if store.recordCalls != 1 || len(lifecycle.observations) != 1 || !bytes.Contains(logs.Bytes(), []byte("lifecycle reaction failed")) {
		t.Fatalf("lifecycle failure was not attempted/logged: store calls=%d lifecycle calls=%d logs=%q", store.recordCalls, len(lifecycle.observations), logs.String())
	}
}

func TestActionServiceMerge_FailsClosedForStaleHeadOrReadiness(t *testing.T) {
	pr, scm := mergeableActionFixture()
	svc := NewActionService(ActionDeps{Store: &fakeActionStore{pr: pr, ok: true}, Reader: scm, Merger: scm})
	_, err := svc.Merge(context.Background(), MergeRequest{PRID: "42", PRURL: pr.URL, ExpectedHeadSHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"})
	if !errors.Is(err, ErrPRHeadChanged) || scm.mergeCalls != 0 {
		t.Fatalf("stale head error = %v, calls = %d", err, scm.mergeCalls)
	}

	pr, scm = mergeableActionFixture()
	scm.observation.CI.Summary = string(domain.CIPending)
	svc = NewActionService(ActionDeps{Store: &fakeActionStore{pr: pr, ok: true}, Reader: scm, Merger: scm})
	_, err = svc.Merge(context.Background(), MergeRequest{PRID: "42", PRURL: pr.URL, ExpectedHeadSHA: pr.HeadSHA})
	if !errors.Is(err, ErrPRPreconditions) || scm.mergeCalls != 0 {
		t.Fatalf("pending CI error = %v, calls = %d", err, scm.mergeCalls)
	}
}

func TestScmRepoForPR_NestedNamespace(t *testing.T) {
	tests := []struct {
		name      string
		repo      string
		wantOK    bool
		wantOwner string
		wantName  string
	}{
		{
			name:      "nested GitLab namespace group/subgroup/project",
			repo:      "group/subgroup/project",
			wantOK:    true,
			wantOwner: "group/subgroup",
			wantName:  "project",
		},
		{
			name:      "standard owner/repo",
			repo:      "owner/repo",
			wantOK:    true,
			wantOwner: "owner",
			wantName:  "repo",
		},
		{
			name:   "single segment rejected",
			repo:   "single",
			wantOK: false,
		},
		{
			name:   "empty string rejected",
			repo:   "",
			wantOK: false,
		},
		{
			name:      "deeply nested group/a/b/c/project",
			repo:      "group/a/b/c/project",
			wantOK:    true,
			wantOwner: "group/a/b/c",
			wantName:  "project",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			repo, ok := scmRepoForPR(domain.PullRequest{Repo: tt.repo, Provider: "gitlab", Host: "gitlab.com"})
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tt.wantOK)
			}
			if !tt.wantOK {
				return
			}
			if repo.Owner != tt.wantOwner {
				t.Errorf("Owner = %q, want %q", repo.Owner, tt.wantOwner)
			}
			if repo.Name != tt.wantName {
				t.Errorf("Name = %q, want %q", repo.Name, tt.wantName)
			}
		})
	}
}

func TestActionServiceMerge_MapsProviderConflict(t *testing.T) {
	pr, scm := mergeableActionFixture()
	scm.mergeErr = ports.ErrSCMHeadChanged
	svc := NewActionService(ActionDeps{Store: &fakeActionStore{pr: pr, ok: true}, Reader: scm, Merger: scm})
	_, err := svc.Merge(context.Background(), MergeRequest{PRID: "42", PRURL: pr.URL, ExpectedHeadSHA: pr.HeadSHA})
	if !errors.Is(err, ErrPRHeadChanged) {
		t.Fatalf("error = %v", err)
	}
}
