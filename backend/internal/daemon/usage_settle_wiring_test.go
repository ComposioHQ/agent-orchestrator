package daemon

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	usagepipeline "github.com/aoagents/agent-orchestrator/backend/internal/observe/usage"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	usagesvc "github.com/aoagents/agent-orchestrator/backend/internal/service/usage"
	usagetelemetry "github.com/aoagents/agent-orchestrator/backend/internal/service/usagetelemetry"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

type recordingSink struct{ events []ports.TelemetryEvent }

func (r *recordingSink) Emit(_ context.Context, ev ports.TelemetryEvent) {
	r.events = append(r.events, ev)
}
func (r *recordingSink) Close(context.Context) error { return nil }

// TestIngestorOnSettleStoreEmitsExactlyOneUsageEvent is the regression guard for
// the wiring bug where the usage ingestor was constructed on the raw SQLite store
// instead of the wrapped usageSettleStore. The ingestor is what calls
// CompleteUsageBindingIfSettled on the normal ingestion path; on the raw store
// that transition never reaches the emitter, so a session's usage is ingested
// and the binding completes but no ao.session.token_usage event is ever sent.
//
// It drives the real Ingestor over a real SQLite store through the same wrapper
// daemon.Run builds, ingests a transcript to EOF, finalizes the binding, and
// asserts exactly one event with the measured token total. Point the ingestor at
// the raw store instead of collectorStore and this fails with zero events.
func TestIngestorOnSettleStoreEmitsExactlyOneUsageEvent(t *testing.T) {
	ctx := context.Background()
	dataDir := t.TempDir()
	store, err := sqlitetest.Open(dataDir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	now := time.Unix(1700000000, 0).UTC()
	clock := func() time.Time { return now }

	if err := store.UpsertProject(ctx, domain.ProjectRecord{ID: "proj", Path: "/repo/proj"}); err != nil {
		t.Fatalf("upsert project: %v", err)
	}
	session, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "proj",
		Kind:      domain.KindWorker,
		Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	binding, err := store.UpsertUsageBinding(ctx, domain.UsageBindingRecord{
		SessionID:      session.ID,
		Harness:        domain.HarnessClaudeCode,
		NativeRootID:   "claude-root",
		InitialModelID: "claude-opus-4-8",
		State:          domain.UsageBindingActive,
		UpdatedAt:      now,
	})
	if err != nil {
		t.Fatalf("upsert binding: %v", err)
	}

	// A single Claude main assistant record: 100 input + 20 output = 120 tokens.
	path := filepath.Join(t.TempDir(), "claude-root.jsonl")
	line := `{"type":"assistant","uuid":"m1","message":{"id":"msg-1","model":"claude-opus-4-8",` +
		`"stop_reason":"end_turn","usage":{"input_tokens":100,"cache_creation_input_tokens":0,` +
		`"cache_read_input_tokens":0,"output_tokens":20}}}` + "\n"
	if err := os.WriteFile(path, []byte(line), 0o600); err != nil {
		t.Fatalf("write transcript: %v", err)
	}
	identity, err := usagesvc.SourceIdentity(ctx, path)
	if err != nil {
		t.Fatalf("source identity: %v", err)
	}
	source, err := store.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceClaudeMain,
		NativeSessionID: "claude-root",
		ArtifactPath:    path,
		FileIdentity:    identity,
		State:           domain.UsageSourcePending,
		UpdatedAt:       now,
	})
	if err != nil {
		t.Fatalf("insert source: %v", err)
	}

	sink := &recordingSink{}
	emitter := usagetelemetry.NewEmitter(usagesvc.NewSummaryReader(store), store, nil, sink, clock)
	// Build the stack through the SAME helper daemon.Run uses, so this test guards
	// the real wiring: if buildUsageCollection points the ingestor at the raw store
	// instead of the wrapped settle store, the settle below emits nothing.
	uc := buildUsageCollection(store, usagesvc.SourceRoots{}, emitter, usagepipeline.IngestorConfig{
		Clock:            clock,
		FinalizationWait: 10 * time.Millisecond,
	}, slog.Default())
	// The collector normally teaches the wrapper each binding's session id via the
	// records it reads/writes. Mirror that here so the ingestor's settle can
	// resolve the session (a binding first seen after a restart is skipped).
	if _, err := uc.settle.ListUsageBindingsForSession(ctx, session.ID); err != nil {
		t.Fatalf("prime binding map: %v", err)
	}
	ingestor := uc.ingestor

	ingestSource := func() {
		t.Helper()
		for pass := 0; pass < 16; pass++ {
			result, err := ingestor.Ingest(ctx, source.ID)
			if err != nil && result.RetryAt == nil {
				t.Fatalf("ingest source: %v", err)
			}
			if !result.More {
				return
			}
		}
		t.Fatal("usage source did not reach EOF")
	}

	// Ingest the transcript, then finalize and let the ingestor settle the binding.
	ingestSource()
	assertSessionTokens(t, store, session.ID, 120)
	if _, err := store.UpdateUsageBindingState(ctx, binding.ID, domain.UsageBindingFinalizing, "", now); err != nil {
		t.Fatalf("finalize binding: %v", err)
	}
	// First pass observes the finalizing binding and schedules a quiet period;
	// after it elapses the next pass calls CompleteUsageBindingIfSettled.
	ingestSource()
	now = now.Add(time.Second)
	ingestSource()

	bindings, err := store.ListUsageBindingsForSession(ctx, session.ID)
	if err != nil || len(bindings) != 1 || bindings[0].State != domain.UsageBindingComplete {
		t.Fatalf("binding not settled: %+v err=%v", bindings, err)
	}

	var usageEvents []ports.TelemetryEvent
	for _, ev := range sink.events {
		if ev.Name == "ao.session.token_usage" {
			usageEvents = append(usageEvents, ev)
		}
	}
	if len(usageEvents) != 1 {
		t.Fatalf("ao.session.token_usage events = %d, want exactly 1 (settle must flow through the wrapped store); all events=%+v", len(usageEvents), sink.events)
	}
	if got := usageEvents[0].Payload["total_tokens"]; got != int64(120) {
		t.Fatalf("total_tokens = %#v, want 120", got)
	}
}

func assertSessionTokens(t *testing.T, store interface {
	ListUsageModelAggregates(context.Context, domain.SessionID) ([]domain.UsageModelAggregate, error)
}, sessionID domain.SessionID, want int64) {
	t.Helper()
	aggregates, err := store.ListUsageModelAggregates(context.Background(), sessionID)
	if err != nil {
		t.Fatalf("list aggregates: %v", err)
	}
	var got int64
	for _, a := range aggregates {
		if a.Tokens.InputTokens != nil {
			got += *a.Tokens.InputTokens
		}
		if a.Tokens.OutputTokens != nil {
			got += *a.Tokens.OutputTokens
		}
	}
	if got != want {
		t.Fatalf("session tokens = %d, want %d; aggregates=%+v", got, want, aggregates)
	}
}
