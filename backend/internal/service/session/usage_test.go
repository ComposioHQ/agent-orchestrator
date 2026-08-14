package session

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type captureSink struct{ events []ports.TelemetryEvent }

func (c *captureSink) Emit(_ context.Context, ev ports.TelemetryEvent) { c.events = append(c.events, ev) }
func (c *captureSink) Close(context.Context) error                     { return nil }

func newUsageService(sink ports.EventSink) (*Service, *fakeStore) {
	st := newFakeStore()
	st.sessions["ao-1"] = domain.SessionRecord{ID: "ao-1", ProjectID: "proj", Kind: domain.KindWorker, Harness: "claude-code"}
	return &Service{store: st, telemetry: sink, clock: time.Now}, st
}

func TestRecordUsageEmitsTurnAndSummaryWithCost(t *testing.T) {
	sink := &captureSink{}
	svc, _ := newUsageService(sink)

	report := ports.UsageReport{
		Turns: []ports.TokenUsage{{
			Model: "claude-opus-4-8", InputTokens: 1_000_000, OutputTokens: 1_000_000,
		}},
		Summary: &ports.UsageSummary{
			TokenUsage: ports.TokenUsage{Model: "claude-opus-4-8", InputTokens: 1_000_000, OutputTokens: 1_000_000},
			TurnCount:  1, DurationMs: 4200,
		},
	}
	if err := svc.RecordUsage(context.Background(), "ao-1", report); err != nil {
		t.Fatal(err)
	}
	if len(sink.events) != 2 {
		t.Fatalf("emitted %d events, want 2", len(sink.events))
	}

	turn := sink.events[0]
	if turn.Name != "ao.session.turn_usage" {
		t.Fatalf("event[0] name = %q", turn.Name)
	}
	if turn.SessionID == nil || *turn.SessionID != "ao-1" {
		t.Fatalf("turn session id = %v", turn.SessionID)
	}
	if turn.Payload["harness"] != "claude-code" {
		t.Fatalf("harness = %v", turn.Payload["harness"])
	}
	if turn.Payload["total_tokens"].(int64) != 2_000_000 {
		t.Fatalf("total_tokens = %v", turn.Payload["total_tokens"])
	}
	// Opus: 1M input @ $15 + 1M output @ $75 = $90.
	if cost := turn.Payload["cost_usd"].(float64); math.Abs(cost-90.0) > 1e-9 {
		t.Fatalf("cost_usd = %v, want 90", cost)
	}
	if turn.Payload["model_priced"].(bool) != true {
		t.Fatalf("model_priced = %v", turn.Payload["model_priced"])
	}

	sum := sink.events[1]
	if sum.Name != "ao.session.usage" {
		t.Fatalf("event[1] name = %q", sum.Name)
	}
	if sum.Payload["turn_count"].(int64) != 1 || sum.Payload["duration_ms"].(int64) != 4200 {
		t.Fatalf("summary meta = %+v", sum.Payload)
	}
}

func TestRecordUsageUnknownModelZeroCostStillEmits(t *testing.T) {
	sink := &captureSink{}
	svc, _ := newUsageService(sink)
	err := svc.RecordUsage(context.Background(), "ao-1", ports.UsageReport{
		Turns: []ports.TokenUsage{{Model: "gpt-4o", InputTokens: 500, OutputTokens: 500}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(sink.events) != 1 {
		t.Fatalf("events = %d, want 1", len(sink.events))
	}
	ev := sink.events[0]
	if ev.Payload["cost_usd"].(float64) != 0 || ev.Payload["model_priced"].(bool) != false {
		t.Fatalf("unknown model payload = %+v", ev.Payload)
	}
}

func TestRecordUsageUnknownSessionIsNotFound(t *testing.T) {
	sink := &captureSink{}
	svc, _ := newUsageService(sink)
	err := svc.RecordUsage(context.Background(), "ghost-1", ports.UsageReport{
		Turns: []ports.TokenUsage{{Model: "claude-opus-4-8", InputTokens: 1}},
	})
	if err == nil {
		t.Fatal("expected not-found error for unknown session")
	}
	if len(sink.events) != 0 {
		t.Fatalf("events = %d, want 0", len(sink.events))
	}
}

func TestRecordUsageEmptyReportNoop(t *testing.T) {
	sink := &captureSink{}
	svc, _ := newUsageService(sink)
	if err := svc.RecordUsage(context.Background(), "ao-1", ports.UsageReport{}); err != nil {
		t.Fatal(err)
	}
	if len(sink.events) != 0 {
		t.Fatalf("events = %d, want 0", len(sink.events))
	}
}
