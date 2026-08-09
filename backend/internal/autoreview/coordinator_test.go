package autoreview

import (
	"context"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
)

type fakeStore struct {
	session domain.SessionRecord
	project domain.ProjectRecord
	prs     []domain.PullRequest
	runs    []domain.ReviewRun
}

func (f *fakeStore) GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error) {
	return f.session, true, nil
}
func (f *fakeStore) ListAllSessions(context.Context) ([]domain.SessionRecord, error) {
	return []domain.SessionRecord{f.session}, nil
}
func (f *fakeStore) GetProject(context.Context, string) (domain.ProjectRecord, bool, error) {
	return f.project, true, nil
}
func (f *fakeStore) ListPRsBySession(context.Context, domain.SessionID) ([]domain.PullRequest, error) {
	return f.prs, nil
}
func (f *fakeStore) ListReviewRunsBySession(context.Context, domain.SessionID) ([]domain.ReviewRun, error) {
	return f.runs, nil
}

type fakeTrigger struct {
	calls   int
	harness domain.ReviewerHarness
}

func (f *fakeTrigger) TriggerAuto(_ context.Context, _ domain.SessionID, harness domain.ReviewerHarness) (reviewcore.TriggerResult, error) {
	f.calls++
	f.harness = harness
	return reviewcore.TriggerResult{Created: true}, nil
}

func TestEvaluateSessionEligibility(t *testing.T) {
	now := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		mutate func(*fakeStore)
		want   bool
	}{
		{name: "eligible", want: true},
		{name: "disabled", mutate: func(f *fakeStore) { f.session.AutoReviewEnabled = false }},
		{name: "non-worker", mutate: func(f *fakeStore) { f.session.Kind = domain.KindOrchestrator }},
		{name: "active", mutate: func(f *fakeStore) { f.session.Activity.State = domain.ActivityActive }},
		{name: "idle less than threshold", mutate: func(f *fakeStore) { f.session.Activity.LastActivityAt = now.Add(-59 * time.Second) }},
		{name: "waiting input", mutate: func(f *fakeStore) { f.session.Activity.State = domain.ActivityWaitingInput }},
		{name: "blocked", mutate: func(f *fakeStore) { f.session.Activity.State = domain.ActivityBlocked }},
		{name: "terminated", mutate: func(f *fakeStore) { f.session.IsTerminated = true }},
		{name: "draft", mutate: func(f *fakeStore) { f.prs[0].Draft = true }},
		{name: "closed", mutate: func(f *fakeStore) { f.prs[0].Closed = true }},
		{name: "merged", mutate: func(f *fakeStore) { f.prs[0].Merged = true }},
		{name: "missing head", mutate: func(f *fakeStore) { f.prs[0].HeadSHA = "" }},
		{name: "no PR", mutate: func(f *fakeStore) { f.prs = nil }},
		{name: "missing reviewer harness", mutate: func(f *fakeStore) { f.session.Harness = domain.AgentHarness("fake") }},
		{name: "running current head", mutate: func(f *fakeStore) {
			f.runs = []domain.ReviewRun{{PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunRunning, CreatedAt: now}}
		}},
		{name: "approved current head", mutate: func(f *fakeStore) {
			f.runs = []domain.ReviewRun{{PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunComplete, Verdict: domain.VerdictApproved, CreatedAt: now}}
		}},
		{name: "changes requested current head", mutate: func(f *fakeStore) {
			f.runs = []domain.ReviewRun{{PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunComplete, Verdict: domain.VerdictChangesRequested, TriggerSource: domain.ReviewTriggerAuto, CreatedAt: now}}
		}},
		{name: "new head after changes requested", want: true, mutate: func(f *fakeStore) {
			f.runs = []domain.ReviewRun{{PRURL: "pr1", TargetSHA: "old", Status: domain.ReviewRunComplete, Verdict: domain.VerdictChangesRequested, TriggerSource: domain.ReviewTriggerAuto, CreatedAt: now}}
		}},
		{name: "failed current head retries", want: true, mutate: func(f *fakeStore) {
			f.runs = []domain.ReviewRun{{PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunFailed, CreatedAt: now}}
		}},
		{name: "cancelled current head waits for new commit", mutate: func(f *fakeStore) {
			f.runs = []domain.ReviewRun{{PRURL: "pr1", TargetSHA: "sha1", Status: domain.ReviewRunCancelled, CreatedAt: now}}
		}},
		{name: "new head after cancelled review", want: true, mutate: func(f *fakeStore) {
			f.runs = []domain.ReviewRun{{PRURL: "pr1", TargetSHA: "old", Status: domain.ReviewRunCancelled, CreatedAt: now}}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeStore{
				session: domain.SessionRecord{ID: "s1", ProjectID: "p1", Kind: domain.KindWorker, Harness: domain.AgentHarness("codex"), AutoReviewEnabled: true, Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: now.Add(-time.Minute)}},
				project: domain.ProjectRecord{ID: "p1"},
				prs:     []domain.PullRequest{{URL: "pr1", Number: 1, HeadSHA: "sha1"}},
			}
			if tt.mutate != nil {
				tt.mutate(store)
			}
			trigger := &fakeTrigger{}
			result, err := New(store, trigger, Config{Clock: func() time.Time { return now }}).EvaluateSession(context.Background(), "s1")
			if err != nil {
				t.Fatal(err)
			}
			if result.Triggered != tt.want || (trigger.calls == 1) != tt.want {
				t.Fatalf("triggered=%v calls=%d, want %v (reason=%s)", result.Triggered, trigger.calls, tt.want, result.Reason)
			}
			if tt.want && trigger.harness != domain.ReviewerCodex {
				t.Fatalf("harness=%q, want codex", trigger.harness)
			}
		})
	}
}

func TestEvaluateSessionReviewerHarnessPrecedence(t *testing.T) {
	now := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name     string
		session  domain.ReviewerHarness
		project  domain.ReviewerHarness
		worker   domain.AgentHarness
		expected domain.ReviewerHarness
	}{
		{name: "session wins", session: domain.ReviewerOpenCode, project: domain.ReviewerClaudeCode, worker: domain.AgentHarness("codex"), expected: domain.ReviewerOpenCode},
		{name: "project fallback", project: domain.ReviewerOpenCode, worker: domain.AgentHarness("codex"), expected: domain.ReviewerOpenCode},
		{name: "worker fallback", worker: domain.AgentHarness("codex"), expected: domain.ReviewerCodex},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store := &fakeStore{
				session: domain.SessionRecord{ID: "s1", ProjectID: "p1", Kind: domain.KindWorker, Harness: tt.worker, ReviewerHarness: tt.session, AutoReviewEnabled: true, Activity: domain.Activity{State: domain.ActivityIdle, LastActivityAt: now.Add(-time.Minute)}},
				project: domain.ProjectRecord{ID: "p1"},
				prs:     []domain.PullRequest{{URL: "pr1", Number: 1, HeadSHA: "sha1"}},
			}
			if tt.project != "" {
				store.project.Config.Reviewers = []domain.ReviewerConfig{{Harness: tt.project}}
			}
			trigger := &fakeTrigger{}
			result, err := New(store, trigger, Config{Clock: func() time.Time { return now }}).EvaluateSession(context.Background(), "s1")
			if err != nil || !result.Triggered {
				t.Fatalf("result=%+v err=%v", result, err)
			}
			if trigger.harness != tt.expected {
				t.Fatalf("harness=%q, want %q", trigger.harness, tt.expected)
			}
		})
	}
}
