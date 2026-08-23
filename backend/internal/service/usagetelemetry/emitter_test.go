package usagetelemetry

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type fakeSummary struct {
	summary domain.SessionUsageSummary
	err     error
}

func (f *fakeSummary) Get(context.Context, domain.SessionID) (domain.SessionUsageSummary, error) {
	return f.summary, f.err
}

type fakeStore struct {
	rec     domain.SessionRecord
	recOK   bool
	project domain.ProjectRecord
	projOK  bool
}

func (f fakeStore) GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error) {
	return f.rec, f.recOK, nil
}
func (f fakeStore) GetProject(context.Context, string) (domain.ProjectRecord, bool, error) {
	return f.project, f.projOK, nil
}

type fakeSCM struct{ repo ports.SCMRepo }

func (f fakeSCM) ParseRepository(remote string) (ports.SCMRepo, bool) {
	if remote == "" {
		return ports.SCMRepo{}, false
	}
	return f.repo, true
}

type fakeSink struct{ events []ports.TelemetryEvent }

func (f *fakeSink) Emit(_ context.Context, ev ports.TelemetryEvent) { f.events = append(f.events, ev) }
func (f *fakeSink) Close(context.Context) error                     { return nil }

func opusSummary(incomplete bool) domain.SessionUsageSummary {
	totals := domain.UsageMetricTotals{InputTokens: i64(100), CachedInputTokens: i64(10), OutputTokens: i64(50)}
	return domain.SessionUsageSummary{
		SessionID:  "ao-1",
		Incomplete: incomplete,
		Totals:     totals,
		Harnesses: []domain.HarnessUsageSummary{{
			Harness: domain.HarnessClaudeCode,
			Models:  []domain.ModelUsageSummary{{ModelID: "claude-opus-4-8", Totals: totals}},
		}},
	}
}

func newEmitter(summary domain.SessionUsageSummary) (*Emitter, *fakeSummary, *fakeSink) {
	sum := &fakeSummary{summary: summary}
	sink := &fakeSink{}
	store := fakeStore{
		rec:     domain.SessionRecord{ID: "ao-1", ProjectID: "ao", Harness: domain.HarnessClaudeCode},
		recOK:   true,
		project: domain.ProjectRecord{RepoOriginURL: "https://github.com/aoagents/agent-orchestrator.git"},
		projOK:  true,
	}
	scm := fakeSCM{repo: ports.SCMRepo{Provider: "github", Owner: "aoagents"}}
	e := NewEmitter(sum, store, scm, sink, func() time.Time { return time.Unix(1700000000, 0).UTC() })
	return e, sum, sink
}

func TestEmitSessionUsageEmitsClassifiedEvent(t *testing.T) {
	e, _, sink := newEmitter(opusSummary(false))
	e.EmitSessionUsage(context.Background(), "ao-1")
	if len(sink.events) != 1 {
		t.Fatalf("emitted %d events, want 1", len(sink.events))
	}
	ev := sink.events[0]
	if ev.Name != "ao.session.token_usage" {
		t.Fatalf("event name = %q", ev.Name)
	}
	p := ev.Payload
	if p["github_org"] != "aoagents" {
		t.Fatalf("github_org = %v", p["github_org"])
	}
	if p["model"] != "claude-opus-4-8" || p["harness"] != string(domain.HarnessClaudeCode) {
		t.Fatalf("model/harness = %v / %v", p["model"], p["harness"])
	}
	if p["total_tokens"] != int64(150) { // input(100)+output(50); cached is a subset of input
		t.Fatalf("total_tokens = %v, want 150", p["total_tokens"])
	}
	if p["incomplete"] != false {
		t.Fatalf("incomplete = %v, want false", p["incomplete"])
	}
	wantCost := modelCost("claude-opus-4-8", opusSummary(false).Harnesses[0].Models[0].Totals)
	if wantCost <= 0 {
		t.Fatalf("fixture cost should be > 0, got %v", wantCost)
	}
	if p["est_cost_usd"] != wantCost {
		t.Fatalf("est_cost_usd = %v, want unrounded %v", p["est_cost_usd"], wantCost)
	}
	if p["est_cost_microusd"] != int64(math.Round(wantCost*1_000_000)) {
		t.Fatalf("est_cost_microusd = %v", p["est_cost_microusd"])
	}
	if ev.SessionID == nil || *ev.SessionID != "ao-1" {
		t.Fatalf("session id = %v", ev.SessionID)
	}
}

func TestEmitSessionUsageIsIdempotentForSameTotal(t *testing.T) {
	e, _, sink := newEmitter(opusSummary(false))
	// Multi-binding settles and pipeline retries re-signal the same session; the
	// same total must not double-count.
	e.EmitSessionUsage(context.Background(), "ao-1")
	e.EmitSessionUsage(context.Background(), "ao-1")
	e.EmitSessionUsage(context.Background(), "ao-1")
	if len(sink.events) != 1 {
		t.Fatalf("idempotent emit produced %d events, want 1", len(sink.events))
	}
}

func TestEmitSessionUsageReemitsOnHigherTotal(t *testing.T) {
	e, sum, sink := newEmitter(opusSummary(false))
	e.EmitSessionUsage(context.Background(), "ao-1")
	// A reactivated session that ran more legitimately re-emits with the new total.
	bigger := opusSummary(false)
	bigger.Totals.OutputTokens = i64(500)
	sum.summary = bigger
	e.EmitSessionUsage(context.Background(), "ao-1")
	if len(sink.events) != 2 {
		t.Fatalf("higher total should re-emit: got %d events, want 2", len(sink.events))
	}
}

func TestEmitSessionUsagePendingIngestionDoesNotEmit(t *testing.T) {
	// At exit before ingestion the summary reads zero; emitting would be useless
	// and (with the old design) permanently dropped. Now it simply no-ops until
	// the settle signal fires with real data.
	e, _, sink := newEmitter(domain.SessionUsageSummary{SessionID: "ao-1"})
	e.EmitSessionUsage(context.Background(), "ao-1")
	if len(sink.events) != 0 {
		t.Fatalf("pending ingestion emitted %d events, want 0", len(sink.events))
	}
}

func TestEmitSessionUsageGithubOrgOmittedForNonGitHubRemote(t *testing.T) {
	sum := &fakeSummary{summary: opusSummary(false)}
	sink := &fakeSink{}
	store := fakeStore{
		rec:     domain.SessionRecord{ID: "ao-1", ProjectID: "ao"},
		recOK:   true,
		project: domain.ProjectRecord{RepoOriginURL: ""},
		projOK:  true,
	}
	e := NewEmitter(sum, store, fakeSCM{}, sink, func() time.Time { return time.Unix(1700000000, 0).UTC() })
	e.EmitSessionUsage(context.Background(), "ao-1")
	if _, ok := sink.events[0].Payload["github_org"]; ok {
		t.Fatalf("github_org should be absent for a non-GitHub remote")
	}
}

func b(state domain.UsageBindingState) domain.UsageBindingRecord {
	return domain.UsageBindingRecord{State: state}
}

func TestAllBindingsSettled(t *testing.T) {
	t.Parallel()
	if AllBindingsSettled(nil) {
		t.Fatal("no bindings should not count as settled")
	}
	if !AllBindingsSettled([]domain.UsageBindingRecord{b(domain.UsageBindingComplete), b(domain.UsageBindingPartial)}) {
		t.Fatal("all complete/partial should be settled")
	}
	if AllBindingsSettled([]domain.UsageBindingRecord{b(domain.UsageBindingComplete), b(domain.UsageBindingFinalizing)}) {
		t.Fatal("a still-finalizing binding means the session is not settled")
	}
	if AllBindingsSettled([]domain.UsageBindingRecord{b(domain.UsageBindingActive)}) {
		t.Fatal("an active binding is not settled")
	}
}
