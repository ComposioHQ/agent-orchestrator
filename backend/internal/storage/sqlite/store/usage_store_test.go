package store_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cdc"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

func TestUsageBindingAndSourceIdempotency(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()

	binding := mustUpsertUsageBinding(t, s, sess, now, domain.UsageBindingRecord{
		NativeRootID:   "root-thread",
		InitialModelID: "gpt-5",
		ProviderHint:   "openai",
		State:          domain.UsageBindingDiscovering,
	})
	again := mustUpsertUsageBinding(t, s, sess, now, domain.UsageBindingRecord{
		NativeRootID:   "root-thread",
		InitialModelID: "gpt-5.1",
		State:          domain.UsageBindingActive,
		UpdatedAt:      now.Add(time.Hour),
	})
	if again.ID != binding.ID {
		t.Fatalf("idempotent binding = %+v, want id %d", again, binding.ID)
	}
	if again.InitialModelID != "gpt-5.1" || again.State != domain.UsageBindingActive {
		t.Fatalf("refreshed binding = %+v", again)
	}
	if again.ProviderHint != "openai" {
		t.Fatalf("provider hint = %q, want retained openai", again.ProviderHint)
	}

	src := mustInsertUsageSource(t, s, now, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: "child-thread",
		ArtifactPath:    "/tmp/codex/rollout.jsonl",
		FileIdentity:    "dev:ino",
		State:           domain.UsageSourcePending,
	})
	srcAgain := mustInsertUsageSource(t, s, now.Add(time.Hour), domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: "child-thread-updated",
		ArtifactPath:    "/tmp/codex/rollout.jsonl",
		FileIdentity:    "dev:ino:updated",
		ParserStateJSON: `{"version":1,"source_kind":"codex_rollout","codex":{}}`,
		State:           domain.UsageSourcePending,
	})
	if srcAgain.ID != src.ID || srcAgain.NativeSessionID != "child-thread-updated" ||
		srcAgain.FileIdentity != "dev:ino" || srcAgain.ParserStateJSON != "{}" {
		t.Fatalf("idempotent source = %+v", srcAgain)
	}

	watchable, err := s.ListWatchableUsageSources(ctx)
	mustNoError(t, err, "watchable sources")
	if len(watchable) != 1 || watchable[0].ID != src.ID {
		t.Fatalf("watchable sources = %+v, want source %d", watchable, src.ID)
	}

	bindings, err := s.ListUsageBindingsForSession(ctx, sess.ID)
	mustNoError(t, err, "bindings")
	sources, err := s.ListUsageSourcesForBinding(ctx, binding.ID)
	mustNoError(t, err, "sources")
	aggregates, err := s.ListUsageModelAggregates(ctx, sess.ID)
	mustNoError(t, err, "aggregates")
	if len(bindings) != 1 || len(sources) != 1 || len(aggregates) != 0 {
		t.Fatalf("rows = bindings:%d sources:%d aggregates:%d, want 1/1/0", len(bindings), len(sources), len(aggregates))
	}
	pending, err := s.HasPendingUsageDiscovery(ctx)
	mustNoError(t, err, "check healthy discovery state")
	if pending {
		t.Fatal("healthy active binding requested discovery retry")
	}
	if _, err := s.UpdateUsageBindingState(
		ctx,
		binding.ID,
		domain.UsageBindingDiscovering,
		domain.UsageErrorSourceDiscoveryPending,
		now.Add(2*time.Hour),
	); err != nil {
		t.Fatalf("mark discovery pending: %v", err)
	}
	pending, err = s.HasPendingUsageDiscovery(ctx)
	mustNoError(t, err, "check pending discovery state")
	if !pending {
		t.Fatal("discovering binding did not request targeted retry")
	}
}

func TestListLatestRetiredCodexReplacementClaimsByPath(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	target := seedUsageSource(t, s, sess, now)
	if _, err := s.MarkUsageSourceState(
		ctx,
		target.ID,
		domain.UsageSourceComplete,
		domain.UsageErrorArtifactReplaced,
		nil,
		now,
	); err != nil {
		t.Fatalf("retire target source: %v", err)
	}
	watchable, err := s.ListWatchableUsageSources(ctx)
	mustNoError(t, err, "list watchable sources")
	for _, source := range watchable {
		if source.ID == target.ID {
			t.Fatalf("retired replacement claim remained watchable: %+v", source)
		}
	}
	mustInsertUsageSource(t, s, now, domain.UsageSourceRecord{
		BindingID:       target.BindingID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: "unrelated-thread",
		ArtifactPath:    "/tmp/codex/unrelated.jsonl",
		FileIdentity:    "dev:unrelated",
		State:           domain.UsageSourceComplete,
		LastErrorCode:   domain.UsageErrorArtifactReplaced,
	})

	assertClaims := func(wantIDs ...int64) {
		t.Helper()
		got, err := s.ListLatestRetiredCodexReplacementClaimsByPath(ctx, target.ArtifactPath)
		mustNoError(t, err, "list replacement claims")
		if len(got) != len(wantIDs) {
			t.Fatalf("replacement claims = %+v, want ids %v", got, wantIDs)
		}
		for i, wantID := range wantIDs {
			if got[i].ID != wantID || got[i].State != domain.UsageSourceComplete ||
				got[i].LastErrorCode != domain.UsageErrorArtifactReplaced {
				t.Fatalf("replacement claim[%d] = %+v, want retired source %d", i, got[i], wantID)
			}
		}
	}

	assertClaims(target.ID)
	sess.IsTerminated = true
	mustNoError(t, s.UpdateSession(ctx, sess), "terminate session")
	assertClaims()
	if _, err := s.UpdateUsageBindingState(
		ctx,
		target.BindingID,
		domain.UsageBindingFinalizing,
		"",
		now.Add(time.Second),
	); err != nil {
		t.Fatalf("finalize binding: %v", err)
	}
	assertClaims(target.ID)
	mustInsertUsageSource(t, s, now.Add(2*time.Second), domain.UsageSourceRecord{
		BindingID:       target.BindingID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: target.NativeSessionID,
		ArtifactPath:    target.ArtifactPath,
		FileIdentity:    "dev:new",
		Generation:      target.Generation + 1,
		State:           domain.UsageSourcePending,
	})
	assertClaims()
}

func TestUsageBindingUpsertDoesNotRegressSettledLifecycle(t *testing.T) {
	s := newTestStore(t)
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	binding := mustUpsertUsageBinding(t, s, sess, now, domain.UsageBindingRecord{
		NativeRootID:  "root-thread",
		State:         domain.UsageBindingFinalizing,
		LastErrorCode: "finalizing-warning",
	})
	got := mustUpsertUsageBinding(t, s, sess, now, domain.UsageBindingRecord{
		NativeRootID: "root-thread",
		State:        domain.UsageBindingActive,
		UpdatedAt:    now.Add(time.Second),
	})
	if got.ID != binding.ID || got.State != domain.UsageBindingFinalizing || got.LastErrorCode != "finalizing-warning" {
		t.Fatalf("stale upsert regressed binding: %+v", got)
	}
}

func TestFinalizeUsageBindingsForSessionLaunchIsGenerationAndRevisionFenced(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	sess.Metadata.RuntimeLaunchID = "launch-current"
	mustNoError(t, s.UpdateSession(ctx, sess))
	now := time.Unix(1700000000, 0).UTC()
	binding := mustUpsertUsageBinding(t, s, sess, now, domain.UsageBindingRecord{
		NativeRootID: "root-thread",
		State:        domain.UsageBindingActive,
	})
	expectedRevision := sess.UpdatedAt

	finalized, err := s.FinalizeUsageBindingsForSessionLaunch(
		ctx,
		sess.ID,
		"launch-stale",
		expectedRevision,
		now.Add(time.Second),
	)
	if err != nil || len(finalized) != 0 {
		t.Fatalf("stale finalization rows=%+v err=%v", finalized, err)
	}
	got, ok, err := s.GetUsageBinding(ctx, sess.ID, sess.Harness, binding.NativeRootID)
	if err != nil || !ok || got.State != domain.UsageBindingActive {
		t.Fatalf("binding after stale finalization=%+v ok=%v err=%v", got, ok, err)
	}

	finalized, err = s.FinalizeUsageBindingsForSessionLaunch(
		ctx,
		sess.ID,
		"launch-current",
		expectedRevision.Add(-time.Second),
		now.Add(2*time.Second),
	)
	if err != nil || len(finalized) != 0 {
		t.Fatalf("stale-revision finalization rows=%+v err=%v", finalized, err)
	}
	got, ok, err = s.GetUsageBinding(ctx, sess.ID, sess.Harness, binding.NativeRootID)
	if err != nil || !ok || got.State != domain.UsageBindingActive {
		t.Fatalf("binding after stale-revision finalization=%+v ok=%v err=%v", got, ok, err)
	}

	finalized, err = s.FinalizeUsageBindingsForSessionLaunch(
		ctx,
		sess.ID,
		"launch-current",
		expectedRevision,
		now.Add(3*time.Second),
	)
	if err != nil || len(finalized) != 1 || finalized[0].State != domain.UsageBindingFinalizing {
		t.Fatalf("current finalization rows=%+v err=%v", finalized, err)
	}
	if _, err := s.UpdateUsageBindingState(ctx, binding.ID, domain.UsageBindingActive, "", now.Add(4*time.Second)); err != nil {
		t.Fatal(err)
	}
	sess.IsTerminated = true
	mustNoError(t, s.UpdateSession(ctx, sess))
	finalized, err = s.FinalizeUsageBindingsForSessionLaunch(
		ctx,
		sess.ID,
		"launch-current",
		expectedRevision,
		now.Add(5*time.Second),
	)
	if err != nil || len(finalized) != 0 {
		t.Fatalf("terminated finalization rows=%+v err=%v", finalized, err)
	}
	got, ok, err = s.GetUsageBinding(ctx, sess.ID, sess.Harness, binding.NativeRootID)
	if err != nil || !ok || got.State != domain.UsageBindingActive {
		t.Fatalf("binding after terminated finalization=%+v ok=%v err=%v", got, ok, err)
	}
}

func TestInsertUsageSourceErrorRedactsArtifactPath(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	source := seedUsageSource(t, s, sess, now)
	secretPath := "/private/transcripts/customer-session.jsonl"

	_, err := s.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:    source.BindingID,
		Kind:         domain.UsageSourceKind("invalid"),
		ArtifactPath: secretPath,
		State:        domain.UsageSourcePending,
		UpdatedAt:    now,
	})
	if err == nil {
		t.Fatal("expected invalid source insert to fail")
	}
	if strings.Contains(err.Error(), secretPath) {
		t.Fatalf("store error exposed artifact path: %v", err)
	}
}

func TestInsertUsageSourceRejectsNonObjectParserState(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	binding := mustUpsertUsageBinding(t, s, sess, now, domain.UsageBindingRecord{
		NativeRootID: "root-thread",
		State:        domain.UsageBindingActive,
	})
	_, err := s.InsertUsageSource(ctx, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		ArtifactPath:    "/tmp/codex/rollout.jsonl",
		ParserStateJSON: `[]`,
		State:           domain.UsageSourcePending,
		UpdatedAt:       now,
	})
	if err == nil || !strings.Contains(err.Error(), "parser state") {
		t.Fatalf("insert error = %v, want parser state object error", err)
	}
}

func TestReplaceUsageSourceRollsBackRetirementWhenInsertFails(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	source := seedUsageSource(t, s, sess, now)

	_, err := s.ReplaceUsageSource(ctx, source.ID, domain.UsageErrorArtifactReplaced, domain.UsageSourceRecord{
		BindingID:       source.BindingID,
		Kind:            domain.UsageSourceKind("invalid"),
		NativeSessionID: source.NativeSessionID,
		ArtifactPath:    "/tmp/codex/replacement.jsonl",
		FileIdentity:    "replacement",
		Generation:      source.Generation + 1,
		State:           domain.UsageSourcePending,
		UpdatedAt:       now.Add(time.Second),
	}, now.Add(time.Second))
	if err == nil {
		t.Fatal("expected replacement insert to fail")
	}

	sources, err := s.ListUsageSourcesForBinding(ctx, source.BindingID)
	mustNoError(t, err)
	if len(sources) != 1 {
		t.Fatalf("sources = %+v, want only original source", sources)
	}
	if sources[0].ID != source.ID || sources[0].State != domain.UsageSourcePending || sources[0].LastErrorCode != "" {
		t.Fatalf("original source was retired despite rollback: %+v", sources[0])
	}
}

func TestUsageMutationsEmitSessionUpdatedCDC(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	base, err := s.LatestSeq(ctx)
	mustNoError(t, err)

	binding := mustUpsertUsageBinding(t, s, sess, now, domain.UsageBindingRecord{
		NativeRootID: "root-thread",
		State:        domain.UsageBindingActive,
	})
	assertUsageSessionUpdatedEvents(t, s, base, sess, 1)

	base, err = s.LatestSeq(ctx)
	mustNoError(t, err)
	source := mustInsertUsageSource(t, s, now, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: "child-thread",
		ArtifactPath:    "/tmp/codex/rollout.jsonl",
		FileIdentity:    "dev:ino",
		State:           domain.UsageSourcePending,
	})
	assertUsageSessionUpdatedEvents(t, s, base, sess, 0)

	base, err = s.LatestSeq(ctx)
	mustNoError(t, err)
	err = s.ApplyUsageChunk(ctx, source.ID, 0, source.UpdatedAt, domain.SourceCursorState{
		ByteOffset: 10,
		State:      domain.UsageSourceActive,
		UpdatedAt:  now,
	}, []domain.ModelUsageEvent{usageEvent(
		"event-1",
		canonicalUsageTokens(10, 0, 10, 2),
	)})
	mustNoError(t, err)
	// New totals invalidate usage once after the transaction commits.
	assertUsageSessionUpdatedEvents(t, s, base, sess, 1)

	base, err = s.LatestSeq(ctx)
	mustNoError(t, err)
	current, ok, err := s.GetUsageSourceForIngestion(ctx, source.ID)
	mustNoError(t, err)
	if !ok {
		t.Fatal("usage source disappeared")
	}
	err = s.ApplyUsageChunk(ctx, source.ID, 10, current.Source.UpdatedAt, domain.SourceCursorState{
		ByteOffset: 20,
		State:      domain.UsageSourceActive,
		UpdatedAt:  now.Add(time.Second),
	}, nil)
	mustNoError(t, err)
	assertUsageSessionUpdatedEvents(t, s, base, sess, 0)
}

func assertUsageSessionUpdatedEvents(
	t *testing.T,
	s *sqlite.Store,
	after int64,
	session domain.SessionRecord,
	want int,
) {
	t.Helper()
	events, err := s.EventsAfter(context.Background(), after, 100)
	mustNoError(t, err)
	if len(events) != want {
		t.Fatalf("events = %+v, want %d", events, want)
	}
	for _, event := range events {
		if event.Type != cdc.EventSessionUpdated ||
			event.ProjectID != string(session.ProjectID) ||
			event.SessionID != string(session.ID) {
			t.Fatalf("decoded usage event = %+v", event)
		}
		var payload map[string]any
		mustNoError(t, json.Unmarshal(event.Payload, &payload))
		if payload["id"] != string(session.ID) || len(payload) != 1 {
			t.Fatalf("usage event payload = %v, want id-only payload", payload)
		}
	}
}

func TestApplyUsageChunkAtomicReplayAndTokenAggregates(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	source := seedUsageSource(t, s, sess, now)

	reasoning := int64(3)
	event := usageEvent("event-1", canonicalUsageTokens(100, 50, 50, 20))
	event.ProviderDetails.OpenAI.ReasoningOutputTokens = &reasoning
	cacheWrite := int64(10)
	event.ProviderDetails.OpenAI.CacheWriteInputTokens = &cacheWrite

	err := s.ApplyUsageChunk(ctx, source.ID, 0, source.UpdatedAt, domain.SourceCursorState{
		ByteOffset:      100,
		State:           domain.UsageSourceActive,
		ParserStateJSON: `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{"input_tokens":100}}}`,
		UpdatedAt:       now,
	}, []domain.ModelUsageEvent{event})
	if err != nil {
		t.Fatalf("apply chunk: %v", err)
	}
	err = s.ApplyUsageChunk(ctx, source.ID, 100, now, domain.SourceCursorState{
		ByteOffset:      120,
		State:           domain.UsageSourceActive,
		ParserStateJSON: `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{"input_tokens":100},"model_id":"gpt-5.6"}}`,
		UpdatedAt:       now.Add(time.Second),
	}, []domain.ModelUsageEvent{event})
	if err != nil {
		t.Fatalf("apply duplicate chunk: %v", err)
	}
	aggs, err := s.ListUsageModelAggregates(ctx, sess.ID)
	mustNoError(t, err, "aggregates")
	if len(aggs) != 1 {
		t.Fatalf("aggregates = %+v, want one row", aggs)
	}
	got := aggs[0]
	if usageTokenValue(got.Tokens.InputTokens) != 100 || usageTokenValue(got.Tokens.OutputTokens) != 20 ||
		got.ProviderDetails.OpenAI == nil || usageTokenValue(got.ProviderDetails.OpenAI.ReasoningOutputTokens) != 3 {
		t.Fatalf("aggregate tokens = %+v", got.Tokens)
	}

	ctxRow, ok, err := s.GetUsageSourceForIngestion(ctx, source.ID)
	if err != nil || !ok {
		t.Fatalf("get source context: ok=%v err=%v", ok, err)
	}
	if ctxRow.Source.ByteOffset != 120 || ctxRow.NativeRootID != "root-thread" ||
		!strings.Contains(ctxRow.Source.ParserStateJSON, `"model_id":"gpt-5.6"`) ||
		ctxRow.InitialModelID != "gpt-5" || ctxRow.BindingState != domain.UsageBindingActive {
		t.Fatalf("source context = %+v", ctxRow)
	}
}

func TestApplyUsageChunkPersistsProviderSplitsAndPassiveCosts(t *testing.T) {
	dataDir := t.TempDir()
	s := sqlitetest.MustOpenAt(t, dataDir)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessClaudeCode)
	now := time.Unix(1700000000, 0).UTC()
	binding := mustUpsertUsageBinding(t, s, sess, now, domain.UsageBindingRecord{
		NativeRootID:   "root-thread",
		InitialModelID: " claude-sonnet ",
		ProviderHint:   " anthropic ",
		State:          domain.UsageBindingActive,
	})
	source := mustInsertUsageSource(t, s, now, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceClaudeMain,
		NativeSessionID: "root-thread",
		ArtifactPath:    "/tmp/claude/transcript.jsonl",
		State:           domain.UsageSourcePending,
	})
	fiveMinutes, oneHour := int64(7), int64(3)
	direct, cacheCreation := int64(5), int64(10)
	uncachedCost, readCost, writeCost, outputCost, totalCost := int64(11), int64(12), int64(13), int64(14), int64(50)
	tokens := canonicalUsageTokens(20, 5, 15, 4)
	tokens.Provenance.InputTokens = domain.UsageMetricDerived
	event := domain.ModelUsageEvent{
		ProviderID:        domain.UsageProviderAnthropic,
		BillingProviderID: "source-provider",
		ModelID:           " source-model ",
		Tokens:            tokens,
		ProviderDetails: domain.UsageProviderDetails{Anthropic: &domain.AnthropicUsageDetails{
			DirectUncachedInputTokens:  &direct,
			CacheCreationInputTokens:   &cacheCreation,
			CacheCreation5mInputTokens: &fiveMinutes,
			CacheCreation1hInputTokens: &oneHour,
		}},
		Costs: domain.UsageEventCosts{
			UncachedInputCostNanos: &uncachedCost,
			CacheReadCostNanos:     &readCost,
			CacheWriteCostNanos:    &writeCost,
			OutputCostNanos:        &outputCost,
			EstimatedCostNanos:     &totalCost,
			PricingVersion:         "catalog-v1",
		},
		SourceEventKey: "event-cost",
	}
	if err := s.ApplyUsageChunk(ctx, source.ID, 0, source.UpdatedAt, domain.SourceCursorState{
		ByteOffset: 10, State: domain.UsageSourceActive, UpdatedAt: now,
	}, []domain.ModelUsageEvent{event}); err != nil {
		t.Fatalf("apply priced source event: %v", err)
	}

	raw, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "ao.db"))
	if err != nil {
		t.Fatalf("open raw sqlite: %v", err)
	}
	t.Cleanup(func() { _ = raw.Close() })
	var providerHint, billingProviderID, modelID, pricingVersion string
	var got5m, got1h, gotUncached, gotRead, gotWrite, gotOutput, gotTotal int64
	if err := raw.QueryRow(`
SELECT ub.provider_hint, mue.billing_provider_id, mue.model_id,
       anthropic.anthropic_cache_creation_5m_input_tokens,
       anthropic.anthropic_cache_creation_1h_input_tokens,
       mue.uncached_input_cost_nanos, mue.cache_read_cost_nanos,
       mue.cache_write_cost_nanos, mue.output_cost_nanos,
       mue.estimated_cost_nanos, mue.pricing_version
FROM model_usage_events mue
JOIN usage_bindings ub ON ub.id = mue.binding_id
JOIN anthropic_usage_event_details anthropic ON anthropic.event_id = mue.id
WHERE mue.source_event_key = 'event-cost'`).Scan(
		&providerHint, &billingProviderID, &modelID, &got5m, &got1h,
		&gotUncached, &gotRead, &gotWrite, &gotOutput, &gotTotal, &pricingVersion,
	); err != nil {
		t.Fatalf("read persisted source/cost facts: %v", err)
	}
	if providerHint != "anthropic" || billingProviderID != "source-provider" || modelID != "source-model" ||
		got5m != 7 || got1h != 3 || gotUncached != 11 || gotRead != 12 || gotWrite != 13 ||
		gotOutput != 14 || gotTotal != 50 || pricingVersion != "catalog-v1" {
		t.Fatalf("persisted facts = hint:%q billing:%q model:%q splits:%d/%d costs:%d/%d/%d/%d/%d version:%q",
			providerHint, billingProviderID, modelID, got5m, got1h,
			gotUncached, gotRead, gotWrite, gotOutput, gotTotal, pricingVersion)
	}
	contextRow, ok, err := s.GetUsageSourceForIngestion(ctx, source.ID)
	if err != nil || !ok || contextRow.ProviderHint != "anthropic" || contextRow.InitialModelID != "claude-sonnet" {
		t.Fatalf("source context = %+v, ok=%v err=%v", contextRow, ok, err)
	}
}

// Break caught: provider backfill could miss source-exact case/alias variants,
// revisit the active version, include immutable zero totals, or process an
// unbounded/non-deterministic page.
func TestListUsageCostCandidatesReturnsStableCanonicalBatch(t *testing.T) {
	dataDir := t.TempDir()
	s := sqlitetest.MustOpenAt(t, dataDir)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	source := seedUsageSource(t, s, sess, now)
	raw, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "ao.db"))
	mustNoError(t, err)
	t.Cleanup(func() { _ = raw.Close() })
	planRows, err := raw.Query(`EXPLAIN QUERY PLAN
SELECT id FROM model_usage_events
WHERE billing_provider_id IS NOT NULL
  AND CASE lower(trim(billing_provider_id))
        WHEN 'z.ai' THEN 'zai'
        ELSE lower(trim(billing_provider_id))
      END = ?
  AND estimated_cost_nanos IS NULL
  AND pricing_version <> ?
	AND id > ?
	ORDER BY id LIMIT 256`, "openai", "active", 0)
	mustNoError(t, err)
	defer func() { _ = planRows.Close() }()
	usesCanonicalIndex := false
	for planRows.Next() {
		var id, parent, unused int
		var detail string
		mustNoError(t, planRows.Scan(&id, &parent, &unused, &detail))
		usesCanonicalIndex = usesCanonicalIndex ||
			(strings.Contains(detail, "idx_model_usage_events_canonical_cost_candidates") && strings.Contains(detail, "id>?"))
	}
	mustNoError(t, planRows.Err())
	if !usesCanonicalIndex {
		t.Fatal("canonical provider candidate query did not use its expression index")
	}

	insert := func(key, billingProvider, version string, total any) int64 {
		t.Helper()
		result, insertErr := raw.Exec(`
INSERT INTO model_usage_events (
    binding_id, usage_source_id, provider_id, billing_provider_id, model_id,
    input_tokens, input_provenance, cached_input_tokens, cached_input_provenance,
    uncached_input_tokens, uncached_input_provenance,
    output_tokens, output_provenance, pricing_version,
    estimated_cost_nanos, source_event_key
) VALUES (?, ?, 'openai', ?, 'gpt-test', 3, 'reported', 1, 'reported', 2, 'derived', 2, 'reported', ?, ?, ?)`,
			source.BindingID, source.ID, billingProvider, version, total, key)
		mustNoError(t, insertErr)
		id, idErr := result.LastInsertId()
		mustNoError(t, idErr)
		return id
	}

	insert("immutable-zero", "openai", "old", int64(0))
	insert("already-attempted", "openai", "active", nil)
	firstWant := insert("candidate-000", " OpenAI ", "old", nil)
	for index := 1; index < 257; index++ {
		insert(fmt.Sprintf("candidate-%03d", index), " OpenAI ", "old", nil)
	}
	insert("other-provider", "anthropic", "old", nil)

	candidates, err := s.ListUsageCostCandidates(ctx, "openai", "active", 0)
	mustNoError(t, err)
	if len(candidates) != 256 {
		t.Fatalf("candidate count = %d, want exact batch of 256", len(candidates))
	}
	for index, candidate := range candidates {
		wantID := firstWant + int64(index)
		if candidate.ID != wantID || candidate.BillingProviderID != " OpenAI " || candidate.PricingVersion != "old" {
			t.Fatalf("candidate[%d] = %+v, want id %d source-exact provider and old version", index, candidate, wantID)
		}
	}
	remaining, err := s.ListUsageCostCandidates(ctx, "openai", "active", candidates[len(candidates)-1].ID)
	mustNoError(t, err)
	if len(remaining) != 1 || remaining[0].ID != firstWant+256 {
		t.Fatalf("keyset remainder = %+v, want final candidate id %d", remaining, firstWant+256)
	}

	insert("zai-alias", "Z.AI", "old", nil)
	zai, err := s.ListUsageCostCandidates(ctx, "zai", "active", 0)
	mustNoError(t, err)
	if len(zai) != 1 || zai[0].BillingProviderID != "Z.AI" {
		t.Fatalf("zai alias candidates = %+v", zai)
	}
}

// Break caught: per-row enrichment transactions would emit duplicate CDC
// invalidations for one binding, while a partial transaction could expose only
// some estimates from one bounded batch.
func TestApplyUsageCostUpdatesCommitsBatchAndTouchesEachBindingOnce(t *testing.T) {
	dataDir := t.TempDir()
	s := sqlitetest.MustOpenAt(t, dataDir)
	ctx := context.Background()
	now := time.Unix(1700000000, 0).UTC()
	firstSession := seedUsageSession(t, s, domain.HarnessCodex)
	firstSource := seedUsageSource(t, s, firstSession, now)
	secondSession := seedUsageSession(t, s, domain.HarnessCodex)
	secondSource := seedUsageSource(t, s, secondSession, now)

	for _, seeded := range []struct {
		source domain.UsageSourceRecord
		events []domain.ModelUsageEvent
	}{
		{source: firstSource, events: []domain.ModelUsageEvent{
			pricedCandidateEvent("first-a"), pricedCandidateEvent("first-b"),
		}},
		{source: secondSource, events: []domain.ModelUsageEvent{pricedCandidateEvent("second-a")}},
	} {
		mustNoError(t, s.ApplyUsageChunk(ctx, seeded.source.ID, 0, seeded.source.UpdatedAt, domain.SourceCursorState{
			ByteOffset: 10, State: domain.UsageSourceActive, UpdatedAt: now,
		}, seeded.events))
	}
	candidates, err := s.ListUsageCostCandidates(ctx, "openai", "catalog-v2", 0)
	mustNoError(t, err)
	if len(candidates) != 3 {
		t.Fatalf("candidates = %+v, want three", candidates)
	}
	updates := make([]domain.UsageCostUpdate, 0, len(candidates))
	for _, candidate := range candidates {
		input, read, write, output, total := int64(1), int64(2), int64(3), int64(4), int64(10)
		updates = append(updates, domain.UsageCostUpdate{
			Candidate: candidate,
			Costs: domain.UsageEventCosts{
				UncachedInputCostNanos: &input,
				CacheReadCostNanos:     &read,
				CacheWriteCostNanos:    &write,
				OutputCostNanos:        &output,
				EstimatedCostNanos:     &total,
				PricingVersion:         "catalog-v2",
			},
		})
	}
	base, err := s.LatestSeq(ctx)
	mustNoError(t, err)
	applied, err := s.ApplyUsageCostUpdates(ctx, updates, now.Add(time.Minute))
	mustNoError(t, err)
	if applied != 3 {
		t.Fatalf("applied = %d, want 3", applied)
	}
	changes, err := s.EventsAfter(ctx, base, 100)
	mustNoError(t, err)
	if len(changes) != 2 {
		t.Fatalf("CDC changes = %+v, want one per affected binding", changes)
	}
	seenSessions := map[string]int{}
	for _, change := range changes {
		if change.Type != cdc.EventSessionUpdated {
			t.Fatalf("CDC change = %+v", change)
		}
		seenSessions[change.SessionID]++
	}
	if seenSessions[string(firstSession.ID)] != 1 || seenSessions[string(secondSession.ID)] != 1 {
		t.Fatalf("CDC sessions = %+v, want each affected session once", seenSessions)
	}

	raw, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "ao.db"))
	mustNoError(t, err)
	t.Cleanup(func() { _ = raw.Close() })
	rows, err := raw.Query(`
SELECT uncached_input_cost_nanos, cache_read_cost_nanos,
       cache_write_cost_nanos, output_cost_nanos,
       estimated_cost_nanos, pricing_version
FROM model_usage_events ORDER BY id`)
	mustNoError(t, err)
	defer func() { _ = rows.Close() }()
	count := 0
	for rows.Next() {
		var input, read, write, output, total int64
		var version string
		mustNoError(t, rows.Scan(&input, &read, &write, &output, &total, &version))
		if input != 1 || read != 2 || write != 3 || output != 4 || total != 10 || version != "catalog-v2" {
			t.Fatalf("persisted estimate = %d/%d/%d/%d/%d %q", input, read, write, output, total, version)
		}
		count++
	}
	mustNoError(t, rows.Err())
	if count != 3 {
		t.Fatalf("updated rows = %d, want 3", count)
	}
}

// Break caught: a stale backfill page could overwrite a concurrent catalog
// attempt, changed raw source facts, or an immutable known-zero total.
func TestApplyUsageCostUpdatesRefusesStaleFactsVersionAndKnownZero(t *testing.T) {
	dataDir := t.TempDir()
	s := sqlitetest.MustOpenAt(t, dataDir)
	ctx := context.Background()
	now := time.Unix(1700000000, 0).UTC()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	source := seedUsageSource(t, s, sess, now)
	events := []domain.ModelUsageEvent{
		pricedCandidateEvent("version-race"),
		pricedCandidateEvent("fact-race"),
		pricedCandidateEvent("known-zero"),
	}
	mustNoError(t, s.ApplyUsageChunk(ctx, source.ID, 0, source.UpdatedAt, domain.SourceCursorState{
		ByteOffset: 10, State: domain.UsageSourceActive, UpdatedAt: now,
	}, events))
	candidates, err := s.ListUsageCostCandidates(ctx, "openai", "catalog-v2", 0)
	mustNoError(t, err)
	if len(candidates) != 3 {
		t.Fatalf("candidates = %+v", candidates)
	}

	raw, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "ao.db"))
	mustNoError(t, err)
	t.Cleanup(func() { _ = raw.Close() })
	_, err = raw.Exec(`UPDATE model_usage_events SET pricing_version = 'raced' WHERE source_event_key = 'version-race'`)
	mustNoError(t, err)
	_, err = raw.Exec(`UPDATE model_usage_events SET model_id = 'changed-model' WHERE source_event_key = 'fact-race'`)
	mustNoError(t, err)
	_, err = raw.Exec(`UPDATE model_usage_events SET estimated_cost_nanos = 0, pricing_version = 'known' WHERE source_event_key = 'known-zero'`)
	mustNoError(t, err)

	total := int64(99)
	updates := make([]domain.UsageCostUpdate, 0, len(candidates))
	for _, candidate := range candidates {
		updates = append(updates, domain.UsageCostUpdate{
			Candidate: candidate,
			Costs: domain.UsageEventCosts{
				EstimatedCostNanos: &total, PricingVersion: "catalog-v2",
			},
		})
	}
	base, err := s.LatestSeq(ctx)
	mustNoError(t, err)
	applied, err := s.ApplyUsageCostUpdates(ctx, updates, now.Add(time.Minute))
	mustNoError(t, err)
	if applied != 0 {
		t.Fatalf("applied stale updates = %d, want 0", applied)
	}
	assertUsageSessionUpdatedEvents(t, s, base, sess, 0)

	var version string
	var zero int64
	mustNoError(t, raw.QueryRow(`SELECT pricing_version FROM model_usage_events WHERE source_event_key = 'version-race'`).Scan(&version))
	if version != "raced" {
		t.Fatalf("raced version = %q", version)
	}
	mustNoError(t, raw.QueryRow(`SELECT estimated_cost_nanos, pricing_version FROM model_usage_events WHERE source_event_key = 'known-zero'`).Scan(&zero, &version))
	if zero != 0 || version != "known" {
		t.Fatalf("known-zero row = %d %q", zero, version)
	}
}

// Break caught: legacy attribution must be selected source-by-source and the
// repair transaction may not advance or rewrite the durable parser cursor.
func TestApplyLegacyUsageRepairsUsesExactSourceFactsAndPreservesCursor(t *testing.T) {
	dataDir := t.TempDir()
	s := sqlitetest.MustOpenAt(t, dataDir)
	ctx := context.Background()
	now := time.Unix(1700000000, 0).UTC()
	sess := seedUsageSession(t, s, domain.HarnessClaudeCode)
	source := seedUsageSource(t, s, sess, now)
	event := anthropicUsageEvent("legacy-repair", 5, 10, 5, 4)
	event.ModelID = "claude-test"
	event.BillingProviderID = "anthropic"
	parserState := `{"version":1,"source_kind":"claude_main","claude":{"model_id":"claude-test"}}`
	mustNoError(t, s.ApplyUsageChunk(ctx, source.ID, 0, source.UpdatedAt, domain.SourceCursorState{
		ByteOffset: 123, ParserStateJSON: parserState,
		State: domain.UsageSourceActive, UpdatedAt: now.Add(time.Second),
	}, []domain.ModelUsageEvent{event}))

	raw, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "ao.db"))
	mustNoError(t, err)
	t.Cleanup(func() { _ = raw.Close() })
	_, err = raw.Exec(`UPDATE model_usage_events
SET billing_provider_id = NULL, pricing_version = '', estimated_cost_nanos = NULL
WHERE source_event_key = 'legacy-repair'`)
	mustNoError(t, err)

	sources, err := s.ListLegacyUsageSources(ctx)
	mustNoError(t, err)
	if len(sources) != 1 || sources[0].Source.ID != source.ID ||
		sources[0].Source.ByteOffset != 123 || sources[0].Source.ParserStateJSON != parserState {
		t.Fatalf("legacy sources = %+v", sources)
	}
	candidates, err := s.ListLegacyUsageEvents(ctx, source.ID)
	mustNoError(t, err)
	if len(candidates) != 1 || candidates[0].SourceEventKey != "legacy-repair" ||
		candidates[0].ModelID != "claude-test" || !reflect.DeepEqual(candidates[0].Tokens, event.Tokens) {
		t.Fatalf("legacy candidates = %+v", candidates)
	}
	input, read, write, output, total := int64(1), int64(2), int64(3), int64(4), int64(10)
	base, err := s.LatestSeq(ctx)
	mustNoError(t, err)
	applied, err := s.ApplyLegacyUsageRepairs(ctx, []domain.LegacyUsageRepair{{
		Candidate:               candidates[0],
		ExpectedFileIdentity:    sources[0].Source.FileIdentity,
		ExpectedByteOffset:      sources[0].Source.ByteOffset,
		ExpectedParserStateJSON: sources[0].Source.ParserStateJSON,
		ExpectedSourceUpdatedAt: sources[0].Source.UpdatedAt,
		BillingProviderID:       "anthropic",
		Costs: domain.UsageEventCosts{
			UncachedInputCostNanos: &input,
			CacheReadCostNanos:     &read,
			CacheWriteCostNanos:    &write,
			OutputCostNanos:        &output,
			EstimatedCostNanos:     &total,
			PricingVersion:         "catalog-v2",
		},
	}}, now.Add(2*time.Second))
	mustNoError(t, err)
	if applied != 1 {
		t.Fatalf("applied legacy repairs = %d, want 1", applied)
	}
	assertUsageSessionUpdatedEvents(t, s, base, sess, 1)

	var billingProvider, version string
	var gotTotal int64
	mustNoError(t, raw.QueryRow(`SELECT billing_provider_id, estimated_cost_nanos, pricing_version
FROM model_usage_events WHERE source_event_key = 'legacy-repair'`).Scan(
		&billingProvider, &gotTotal, &version))
	if billingProvider != "anthropic" || gotTotal != 10 || version != "catalog-v2" {
		t.Fatalf("repaired row = %q total=%d version=%q", billingProvider, gotTotal, version)
	}
	got, ok, err := s.GetUsageSourceForIngestion(ctx, source.ID)
	mustNoError(t, err)
	if !ok || got.Source.ByteOffset != 123 || got.Source.ParserStateJSON != parserState {
		t.Fatalf("repair changed source cursor/state: %+v ok=%v", got.Source, ok)
	}
}

// Break caught: a replay result from a stale/replaced source generation must
// not repair a row after any generic fact or the event's prior version changed.
func TestApplyLegacyUsageRepairsRefusesStaleSourceAndRawFacts(t *testing.T) {
	dataDir := t.TempDir()
	s := sqlitetest.MustOpenAt(t, dataDir)
	ctx := context.Background()
	now := time.Unix(1700000000, 0).UTC()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	source := seedUsageSource(t, s, sess, now)

	raw, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "ao.db"))
	mustNoError(t, err)
	t.Cleanup(func() { _ = raw.Close() })
	_, err = raw.Exec(`INSERT INTO model_usage_events (
binding_id, usage_source_id, provider_id, billing_provider_id, model_id,
input_tokens, input_provenance, cached_input_tokens, cached_input_provenance,
uncached_input_tokens, uncached_input_provenance,
output_tokens, output_provenance, pricing_version, source_event_key
) VALUES (?, ?, 'openai', NULL, 'gpt-test', 9, 'reported', 2, 'reported', 7, 'derived', 1, 'reported', '', 'legacy-stale')`,
		source.BindingID, source.ID)
	mustNoError(t, err)
	candidates, err := s.ListLegacyUsageEvents(ctx, source.ID)
	mustNoError(t, err)
	if len(candidates) != 1 {
		t.Fatalf("legacy candidates = %+v", candidates)
	}
	_, err = raw.Exec(`UPDATE model_usage_events
SET input_tokens = 10, uncached_input_tokens = 8, pricing_version = 'raced'
WHERE source_event_key = 'legacy-stale'`)
	mustNoError(t, err)
	total := int64(99)
	base, err := s.LatestSeq(ctx)
	mustNoError(t, err)
	applied, err := s.ApplyLegacyUsageRepairs(ctx, []domain.LegacyUsageRepair{{
		Candidate:         candidates[0],
		BillingProviderID: "openai",
		Costs: domain.UsageEventCosts{
			EstimatedCostNanos: &total, PricingVersion: "catalog-v2",
		},
	}}, now.Add(time.Minute))
	mustNoError(t, err)
	if applied != 0 {
		t.Fatalf("applied stale legacy repairs = %d, want 0", applied)
	}
	assertUsageSessionUpdatedEvents(t, s, base, sess, 0)
	var billingProvider sql.NullString
	mustNoError(t, raw.QueryRow(`SELECT billing_provider_id FROM model_usage_events
WHERE source_event_key = 'legacy-stale'`).Scan(&billingProvider))
	if billingProvider.Valid {
		t.Fatalf("stale row billing provider = %q, want NULL", billingProvider.String)
	}
}

func TestApplyUsageChunkReplayComparesNewSourceFactsButNotCosts(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessClaudeCode)
	now := time.Unix(1700000000, 0).UTC()
	source := seedUsageSource(t, s, sess, now)
	fiveMinutes, oneHour := int64(7), int64(3)
	event := anthropicUsageEvent("event-1", 5, 10, 5, 4)
	event.BillingProviderID = "anthropic"
	event.ProviderDetails.Anthropic.CacheCreation5mInputTokens = &fiveMinutes
	event.ProviderDetails.Anthropic.CacheCreation1hInputTokens = &oneHour
	if err := s.ApplyUsageChunk(ctx, source.ID, 0, source.UpdatedAt, domain.SourceCursorState{ByteOffset: 10, State: domain.UsageSourceActive, UpdatedAt: now}, []domain.ModelUsageEvent{event}); err != nil {
		t.Fatalf("seed event: %v", err)
	}

	differentCost := int64(99)
	replay := event
	replay.Costs.EstimatedCostNanos = &differentCost
	replay.Costs.PricingVersion = "later-version"
	if err := s.ApplyUsageChunk(ctx, source.ID, 10, now, domain.SourceCursorState{ByteOffset: 20, State: domain.UsageSourceActive, UpdatedAt: now.Add(time.Second)}, []domain.ModelUsageEvent{replay}); err != nil {
		t.Fatalf("cost-only replay conflict: %v", err)
	}

	providerConflict := event
	providerConflict.BillingProviderID = "zai"
	if err := s.ApplyUsageChunk(ctx, source.ID, 20, now.Add(time.Second), domain.SourceCursorState{ByteOffset: 30, State: domain.UsageSourceActive, UpdatedAt: now.Add(2 * time.Second)}, []domain.ModelUsageEvent{providerConflict}); !errors.Is(err, domain.ErrUsageSourceEventConflict) {
		t.Fatalf("provider replay err = %v, want source conflict", err)
	}
	otherFiveMinutes := int64(6)
	splitConflict := event
	splitDetails := *event.ProviderDetails.Anthropic
	splitDetails.CacheCreation5mInputTokens = &otherFiveMinutes
	splitConflict.ProviderDetails = domain.UsageProviderDetails{Anthropic: &splitDetails}
	if err := s.ApplyUsageChunk(ctx, source.ID, 20, now.Add(time.Second), domain.SourceCursorState{ByteOffset: 30, State: domain.UsageSourceActive, UpdatedAt: now.Add(2 * time.Second)}, []domain.ModelUsageEvent{splitConflict}); !errors.Is(err, domain.ErrUsageSourceEventConflict) {
		t.Fatalf("split replay err = %v, want source conflict", err)
	}
}

func TestApplyUsageChunkLegacyNullProviderReplayUsesGenericTokenFacts(t *testing.T) {
	dataDir := t.TempDir()
	s := sqlitetest.MustOpenAt(t, dataDir)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	source := seedUsageSource(t, s, sess, now)
	raw, err := sql.Open("sqlite", "file:"+filepath.Join(dataDir, "ao.db"))
	if err != nil {
		t.Fatalf("open raw sqlite: %v", err)
	}
	t.Cleanup(func() { _ = raw.Close() })
	if _, err := raw.Exec(`
INSERT INTO model_usage_events (
    binding_id, usage_source_id, provider_id, billing_provider_id, model_id,
    input_tokens, input_provenance, cached_input_tokens, cached_input_provenance,
    uncached_input_tokens, uncached_input_provenance,
    output_tokens, output_provenance, source_event_key
) VALUES (?, ?, 'openai', NULL, 'gpt-5', 20, 'reported', 5, 'reported', 15, 'derived', 4, 'reported', 'legacy-event')`, source.BindingID, source.ID); err != nil {
		t.Fatalf("seed legacy event: %v", err)
	}
	replay := usageEvent("legacy-event", canonicalUsageTokens(20, 5, 15, 4))
	replay.BillingProviderID = "openai"
	if err := s.ApplyUsageChunk(ctx, source.ID, 0, source.UpdatedAt, domain.SourceCursorState{
		ByteOffset: 10, State: domain.UsageSourceActive, UpdatedAt: now,
	}, []domain.ModelUsageEvent{replay}); err != nil {
		t.Fatalf("legacy replay conflict: %v", err)
	}
}

func TestApplyUsageChunkRejectsBlankProviderOnNewEvent(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	source := seedUsageSource(t, s, sess, now)
	event := usageEvent("event-blank-provider", canonicalUsageTokens(1, 0, 1, 1))
	event.ProviderID = "  "
	if err := s.ApplyUsageChunk(ctx, source.ID, 0, source.UpdatedAt, domain.SourceCursorState{
		ByteOffset: 10, State: domain.UsageSourceActive, UpdatedAt: now,
	}, []domain.ModelUsageEvent{event}); err == nil {
		t.Fatal("blank provider event was persisted")
	}
	assertUsageSourceOffset(t, s, source.ID, 0)
}

func TestApplyUsageChunkRejectsConflictsAndPreservesCursor(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	source := seedUsageSource(t, s, sess, now)

	if err := s.ApplyUsageChunk(ctx, source.ID, 0, source.UpdatedAt, domain.SourceCursorState{ByteOffset: 50, State: domain.UsageSourceActive, UpdatedAt: now}, []domain.ModelUsageEvent{
		usageEvent("event-1", canonicalUsageTokens(10, 0, 10, 1)),
	}); err != nil {
		t.Fatalf("seed event: %v", err)
	}

	conflict := usageEvent("event-1", canonicalUsageTokens(11, 0, 11, 1))
	err := s.ApplyUsageChunk(ctx, source.ID, 50, now, domain.SourceCursorState{ByteOffset: 80, State: domain.UsageSourceActive, UpdatedAt: now}, []domain.ModelUsageEvent{
		usageEvent("event-2", canonicalUsageTokens(4, 0, 4, 1)),
		conflict,
	})
	if !errors.Is(err, domain.ErrUsageSourceEventConflict) {
		t.Fatalf("conflict err = %v, want ErrUsageSourceEventConflict", err)
	}
	assertUsageSourceOffset(t, s, source.ID, 50)
	aggregates, err := s.ListUsageModelAggregates(ctx, sess.ID)
	mustNoError(t, err)
	if len(aggregates) != 1 || usageTokenValue(aggregates[0].Tokens.InputTokens)+usageTokenValue(aggregates[0].Tokens.OutputTokens) != 11 {
		t.Fatalf("rolled-back chunk persisted events: %+v", aggregates)
	}

	bad := usageEvent("event-2", canonicalUsageTokens(10, 11, 10, 1))
	if err := s.ApplyUsageChunk(ctx, source.ID, 50, now, domain.SourceCursorState{ByteOffset: 90, State: domain.UsageSourceActive, UpdatedAt: now}, []domain.ModelUsageEvent{bad}); err == nil {
		t.Fatal("expected invalid event insert to fail")
	}
	assertUsageSourceOffset(t, s, source.ID, 50)

	if err := s.ApplyUsageChunk(ctx, source.ID, 0, now, domain.SourceCursorState{ByteOffset: 60, State: domain.UsageSourceActive, UpdatedAt: now}, nil); !errors.Is(err, domain.ErrUsageSourceOffsetConflict) {
		t.Fatalf("offset err = %v, want ErrUsageSourceOffsetConflict", err)
	}
	assertUsageSourceOffset(t, s, source.ID, 50)
}

func TestApplyUsageChunkProviderDetailConflictsRollback(t *testing.T) {
	tests := []struct {
		name        string
		harness     domain.AgentHarness
		wantInput   int64
		wantOutput  int64
		baseEvent   func(string) domain.ModelUsageEvent
		conflicting func(string) domain.ModelUsageEvent
	}{
		{
			name: "OpenAI", harness: domain.HarnessCodex, wantInput: 10, wantOutput: 1,
			baseEvent: func(key string) domain.ModelUsageEvent {
				return usageEvent(key, canonicalUsageTokens(10, 0, 10, 1))
			},
			conflicting: func(key string) domain.ModelUsageEvent {
				event := usageEvent(key, canonicalUsageTokens(10, 0, 10, 1))
				reasoning := int64(1)
				event.ProviderDetails.OpenAI.ReasoningOutputTokens = &reasoning
				return event
			},
		},
		{
			name: "Anthropic", harness: domain.HarnessClaudeCode, wantInput: 20, wantOutput: 4,
			baseEvent: func(key string) domain.ModelUsageEvent {
				return anthropicUsageEvent(key, 10, 3, 7, 4)
			},
			conflicting: func(key string) domain.ModelUsageEvent {
				event := anthropicUsageEvent(key, 10, 3, 7, 4)
				creation := int64(4)
				event.ProviderDetails.Anthropic.CacheCreationInputTokens = &creation
				return event
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			s := newTestStore(t)
			ctx := context.Background()
			sess := seedUsageSession(t, s, test.harness)
			now := time.Unix(1700000000, 0).UTC()
			source := seedUsageSource(t, s, sess, now)
			if err := s.ApplyUsageChunk(ctx, source.ID, 0, source.UpdatedAt, domain.SourceCursorState{
				ByteOffset: 50, State: domain.UsageSourceActive, UpdatedAt: now,
			}, []domain.ModelUsageEvent{test.baseEvent("event-1")}); err != nil {
				t.Fatalf("seed provider event: %v", err)
			}

			err := s.ApplyUsageChunk(ctx, source.ID, 50, now, domain.SourceCursorState{
				ByteOffset: 80, State: domain.UsageSourceActive, UpdatedAt: now.Add(time.Second),
			}, []domain.ModelUsageEvent{test.baseEvent("event-2"), test.conflicting("event-1")})
			if !errors.Is(err, domain.ErrUsageSourceEventConflict) {
				t.Fatalf("provider conflict err = %v, want ErrUsageSourceEventConflict", err)
			}
			assertUsageSourceOffset(t, s, source.ID, 50)
			aggregates, err := s.ListUsageModelAggregates(ctx, sess.ID)
			mustNoError(t, err)
			if len(aggregates) != 1 || usageTokenValue(aggregates[0].Tokens.InputTokens) != test.wantInput ||
				usageTokenValue(aggregates[0].Tokens.OutputTokens) != test.wantOutput {
				t.Fatalf("provider conflict persisted partial chunk: %+v", aggregates)
			}
		})
	}
}

func TestApplyUsageChunkProviderDetailEnrichmentAdvancesCursorWithoutDuplicate(t *testing.T) {
	tests := []struct {
		name         string
		harness      domain.AgentHarness
		wantInput    int64
		wantOutput   int64
		baseEvent    func() domain.ModelUsageEvent
		richerEvent  func() domain.ModelUsageEvent
		assertDetail func(*testing.T, domain.UsageModelAggregate)
	}{
		{
			name: "OpenAI", harness: domain.HarnessCodex, wantInput: 10, wantOutput: 1,
			baseEvent: func() domain.ModelUsageEvent {
				event := usageEvent("event-1", canonicalUsageTokens(10, 0, 10, 1))
				event.ProviderDetails.OpenAI.ReasoningOutputTokens = nil
				return event
			},
			richerEvent: func() domain.ModelUsageEvent {
				event := usageEvent("event-1", canonicalUsageTokens(10, 0, 10, 1))
				reasoning := int64(1)
				event.ProviderDetails.OpenAI.ReasoningOutputTokens = &reasoning
				return event
			},
			assertDetail: func(t *testing.T, aggregate domain.UsageModelAggregate) {
				t.Helper()
				if aggregate.ProviderDetails.OpenAI == nil ||
					usageTokenValue(aggregate.ProviderDetails.OpenAI.ReasoningOutputTokens) != 1 {
					t.Fatalf("enriched OpenAI details = %+v", aggregate.ProviderDetails.OpenAI)
				}
			},
		},
		{
			name: "Anthropic", harness: domain.HarnessClaudeCode, wantInput: 20, wantOutput: 4,
			baseEvent: func() domain.ModelUsageEvent {
				return anthropicUsageEvent("event-1", 10, 3, 7, 4)
			},
			richerEvent: func() domain.ModelUsageEvent {
				event := anthropicUsageEvent("event-1", 10, 3, 7, 4)
				creation5m := int64(2)
				event.ProviderDetails.Anthropic.CacheCreation5mInputTokens = &creation5m
				return event
			},
			assertDetail: func(t *testing.T, aggregate domain.UsageModelAggregate) {
				t.Helper()
				if aggregate.ProviderDetails.Anthropic == nil ||
					usageTokenValue(aggregate.ProviderDetails.Anthropic.CacheCreation5mInputTokens) != 2 {
					t.Fatalf("enriched Anthropic details = %+v", aggregate.ProviderDetails.Anthropic)
				}
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			s := newTestStore(t)
			ctx := context.Background()
			sess := seedUsageSession(t, s, test.harness)
			now := time.Unix(1700000000, 0).UTC()
			source := seedUsageSource(t, s, sess, now)
			if err := s.ApplyUsageChunk(ctx, source.ID, 0, source.UpdatedAt, domain.SourceCursorState{
				ByteOffset: 50, State: domain.UsageSourceActive, UpdatedAt: now,
			}, []domain.ModelUsageEvent{test.baseEvent()}); err != nil {
				t.Fatalf("seed provider event: %v", err)
			}
			if err := s.ApplyUsageChunk(ctx, source.ID, 50, now, domain.SourceCursorState{
				ByteOffset: 80, State: domain.UsageSourceActive, UpdatedAt: now.Add(time.Second),
			}, []domain.ModelUsageEvent{test.richerEvent()}); err != nil {
				t.Fatalf("enrich provider event: %v", err)
			}
			assertUsageSourceOffset(t, s, source.ID, 80)
			aggregates, err := s.ListUsageModelAggregates(ctx, sess.ID)
			mustNoError(t, err)
			if len(aggregates) != 1 || usageTokenValue(aggregates[0].Tokens.InputTokens) != test.wantInput ||
				usageTokenValue(aggregates[0].Tokens.OutputTokens) != test.wantOutput {
				t.Fatalf("enrichment duplicated provider event: %+v", aggregates)
			}
			test.assertDetail(t, aggregates[0])
		})
	}
}

func TestUsageBindingWaitsForPersistedCodexChildren(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	const childID = "22222222-2222-4222-8222-222222222222"
	binding := mustUpsertUsageBinding(t, s, sess, now, domain.UsageBindingRecord{
		NativeRootID: "11111111-1111-4111-8111-111111111111",
		State:        domain.UsageBindingActive,
	})
	mustInsertUsageSource(t, s, now, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: binding.NativeRootID,
		ArtifactPath:    "/tmp/codex/parent.jsonl",
		FileIdentity:    "parent",
		ParserStateJSON: `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{},"pending_spawn_call_ids":[],"discovered_child_ids":["` + childID + `"]}}`,
		State:           domain.UsageSourceComplete,
	})

	discovery, err := s.ListUsageDiscoveryBindings(ctx, 8)
	if err != nil || len(discovery) != 1 || discovery[0].ID != binding.ID {
		t.Fatalf("startup discovery bindings = %+v, err=%v", discovery, err)
	}
	if _, err := s.UpdateUsageBindingState(ctx, binding.ID, domain.UsageBindingFinalizing, "", now); err != nil {
		t.Fatal(err)
	}
	completed, err := s.CompleteUsageBindingIfSettled(ctx, binding.ID, now)
	mustNoError(t, err)
	if completed {
		t.Fatal("binding completed before its persisted Codex child was registered")
	}
	got, ok, err := s.GetUsageBinding(ctx, sess.ID, sess.Harness, binding.NativeRootID)
	if err != nil || !ok || got.State != domain.UsageBindingFinalizing {
		t.Fatalf("binding while child missing = %+v, ok=%v err=%v", got, ok, err)
	}

	mustInsertUsageSource(t, s, now, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            domain.UsageSourceCodexRollout,
		NativeSessionID: childID,
		SubagentID:      childID,
		ArtifactPath:    "/tmp/codex/child.jsonl",
		FileIdentity:    "child",
		State:           domain.UsageSourceComplete,
	})
	completed, err = s.CompleteUsageBindingIfSettled(ctx, binding.ID, now)
	if err != nil || !completed {
		t.Fatalf("complete after child registration = %v, err=%v", completed, err)
	}
}

func TestUsageBindingIgnoresChildrenFromSupersededCodexGeneration(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	now := time.Unix(1700000000, 0).UTC()
	const (
		rootID  = "11111111-1111-4111-8111-111111111111"
		childID = "22222222-2222-4222-8222-222222222222"
	)
	binding := mustUpsertUsageBinding(t, s, sess, now, domain.UsageBindingRecord{
		NativeRootID: rootID,
		State:        domain.UsageBindingFinalizing,
	})
	oldState := `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{},"pending_spawn_call_ids":[],"discovered_child_ids":["` + childID + `"]}}`
	emptyState := `{"version":1,"source_kind":"codex_rollout","codex":{"baseline":{},"pending_spawn_call_ids":[],"discovered_child_ids":[]}}`
	for generation, state := range []string{oldState, emptyState} {
		mustInsertUsageSource(t, s, now, domain.UsageSourceRecord{
			BindingID:       binding.ID,
			Kind:            domain.UsageSourceCodexRollout,
			NativeSessionID: rootID,
			ArtifactPath:    "/tmp/codex/root.jsonl",
			FileIdentity:    fmt.Sprintf("root-%d", generation),
			Generation:      int64(generation),
			ParserStateJSON: state,
			State:           domain.UsageSourceComplete,
		})
	}

	completed, err := s.CompleteUsageBindingIfSettled(ctx, binding.ID, now)
	if err != nil || !completed {
		sources, _ := s.ListUsageSourcesForBinding(ctx, binding.ID)
		got, _, _ := s.GetUsageBinding(ctx, sess.ID, sess.Harness, rootID)
		t.Fatalf("completion with superseded child edge = %v, err=%v, binding=%+v, sources=%+v", completed, err, got, sources)
	}
}

func TestUsageBindingValidatesCodexDiscoveryStateShapes(t *testing.T) {
	const childID = "22222222-2222-4222-8222-222222222222"
	tests := []struct {
		name          string
		state         string
		wantCompleted bool
	}{
		{name: "scalar discovered ids", state: `{"version":1,"source_kind":"codex_rollout","codex":{"discovered_child_ids":"` + childID + `"}}`, wantCompleted: true},
		{name: "object discovered ids", state: `{"version":1,"source_kind":"codex_rollout","codex":{"discovered_child_ids":{"child":"` + childID + `"}}}`, wantCompleted: true},
		{name: "future version", state: `{"version":2,"source_kind":"codex_rollout","codex":{"discovered_child_ids":["` + childID + `"]}}`, wantCompleted: true},
		{name: "wrong source kind", state: `{"version":1,"source_kind":"claude_main","codex":{"discovered_child_ids":["` + childID + `"]}}`, wantCompleted: true},
		{name: "non object codex payload", state: `{"version":1,"source_kind":"codex_rollout","codex":"not-an-object"}`, wantCompleted: true},
		{name: "noncanonical child", state: `{"version":1,"source_kind":"codex_rollout","codex":{"discovered_child_ids":["22222222-2222-4222-8222-22222222222A"]}}`, wantCompleted: true},
		{name: "mixed-type child array", state: `{"version":1,"source_kind":"codex_rollout","codex":{"discovered_child_ids":["` + childID + `",7]}}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := newTestStore(t)
			ctx := context.Background()
			sess := seedUsageSession(t, s, domain.HarnessCodex)
			now := time.Unix(1700000000, 0).UTC()
			binding := mustUpsertUsageBinding(t, s, sess, now, domain.UsageBindingRecord{
				NativeRootID: "11111111-1111-4111-8111-111111111111",
				State:        domain.UsageBindingActive,
			})
			mustInsertUsageSource(t, s, now, domain.UsageSourceRecord{
				BindingID:       binding.ID,
				Kind:            domain.UsageSourceCodexRollout,
				NativeSessionID: binding.NativeRootID,
				ArtifactPath:    "/tmp/codex/root.jsonl",
				FileIdentity:    "root",
				ParserStateJSON: tt.state,
				State:           domain.UsageSourceComplete,
			})

			discovery, err := s.ListUsageDiscoveryBindings(ctx, 8)
			mustNoError(t, err)
			if len(discovery) != 0 {
				t.Fatalf("invalid state invented discovery bindings: %+v", discovery)
			}
			if _, err := s.UpdateUsageBindingState(ctx, binding.ID, domain.UsageBindingFinalizing, "", now); err != nil {
				t.Fatal(err)
			}
			completed, err := s.CompleteUsageBindingIfSettled(ctx, binding.ID, now)
			mustNoError(t, err)
			if completed != tt.wantCompleted {
				t.Fatalf("completed = %v, want %v", completed, tt.wantCompleted)
			}
		})
	}
}

func TestUsageRowsCascadeWhenSeedSessionDeleted(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	seedProject(t, s, "usage")
	now := time.Unix(1700000000, 0).UTC()
	sess, err := s.CreateSession(ctx, domain.SessionRecord{
		ProjectID: "usage",
		Kind:      domain.KindWorker,
		Harness:   domain.HarnessCodex,
		Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("create seed session: %v", err)
	}
	source := seedUsageSource(t, s, sess, now)
	if err := s.ApplyUsageChunk(ctx, source.ID, 0, source.UpdatedAt, domain.SourceCursorState{ByteOffset: 10, State: domain.UsageSourceComplete, UpdatedAt: now}, []domain.ModelUsageEvent{
		usageEvent("event-1", canonicalUsageTokens(1, 0, 1, 1)),
	}); err != nil {
		t.Fatalf("apply event: %v", err)
	}

	deleted, err := s.DeleteSession(ctx, sess.ID)
	if err != nil || !deleted {
		t.Fatalf("delete seed session = %v, %v; want true nil", deleted, err)
	}
	bindings, err := s.ListUsageBindingsForSession(ctx, sess.ID)
	mustNoError(t, err, "bindings after delete")
	aggregates, err := s.ListUsageModelAggregates(ctx, sess.ID)
	mustNoError(t, err, "aggregates after delete")
	if len(bindings) != 0 || len(aggregates) != 0 {
		t.Fatalf("rows after delete = bindings:%d aggregates:%d, want zero", len(bindings), len(aggregates))
	}
}

func TestUsageAggregatesSeparateProvidersAndPreserveCostCoverageFacts(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(1700000000, 0).UTC()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	source := seedUsageSource(t, s, sess, now)
	value := func(n int64) *int64 { return &n }
	events := []domain.ModelUsageEvent{
		{
			ProviderID: domain.UsageProviderOpenAI, BillingProviderID: "openai",
			ModelID: "shared-model", SourceEventKey: "complete",
			Tokens: canonicalUsageTokens(10, 4, 6, 2),
			ProviderDetails: domain.UsageProviderDetails{OpenAI: &domain.OpenAIUsageDetails{
				ReasoningOutputTokens: value(0), CacheWriteInputTokens: value(0),
			}},
			Costs: domain.UsageEventCosts{
				UncachedInputCostNanos: value(20), CacheReadCostNanos: value(10), CacheWriteCostNanos: value(0),
				OutputCostNanos: value(70), EstimatedCostNanos: value(100), PricingVersion: "openai-v1",
			},
		},
		{
			ProviderID: domain.UsageProviderOpenAI, BillingProviderID: "zai",
			ModelID: "shared-model", SourceEventKey: "partial",
			Tokens: canonicalUsageTokens(5, 0, 5, 1),
			ProviderDetails: domain.UsageProviderDetails{OpenAI: &domain.OpenAIUsageDetails{
				ReasoningOutputTokens: value(0), CacheWriteInputTokens: value(0),
			}},
			Costs: domain.UsageEventCosts{
				UncachedInputCostNanos: value(30), CacheWriteCostNanos: value(0), OutputCostNanos: value(5),
				PricingVersion: "zai-v1",
			},
		},
	}
	if err := s.ApplyUsageChunk(ctx, source.ID, 0, source.UpdatedAt, domain.SourceCursorState{
		ByteOffset: 10, State: domain.UsageSourceComplete, UpdatedAt: now,
	}, events); err != nil {
		t.Fatalf("apply cost events: %v", err)
	}

	models, err := s.ListUsageModelAggregates(ctx, sess.ID)
	mustNoError(t, err)
	if len(models) != 2 || models[0].BillingProviderID != "openai" || models[1].BillingProviderID != "zai" {
		t.Fatalf("provider/model rows = %+v", models)
	}
	complete := models[0].Cost
	if complete.EventCount != 1 || complete.PricedEventCount != 1 || complete.PricedTotalNanos != 100 ||
		complete.KnownUncachedInputNanos != 20 || complete.UnpricedKnownUncachedInputNanos != 0 {
		t.Fatalf("complete cost facts = %+v", complete)
	}
	partial := models[1].Cost
	if partial.EventCount != 1 || partial.PricedEventCount != 0 || partial.PricedTotalNanos != 0 ||
		partial.KnownUncachedInputCount != 1 || partial.KnownUncachedInputNanos != 30 || partial.UnpricedKnownUncachedInputNanos != 30 ||
		partial.KnownCacheReadCount != 0 || partial.KnownCacheWriteCount != 1 || partial.UnpricedKnownOutputNanos != 5 {
		t.Fatalf("partial cost facts = %+v", partial)
	}

	compact, err := s.ListCompactSessionUsageAggregates(ctx, sess.ProjectID)
	mustNoError(t, err)
	if len(compact) != 1 || usageTokenValue(compact[0].ProcessedTokens) != 18 {
		t.Fatalf("compact rows = %+v", compact)
	}
	cost := compact[0].Cost
	if cost.EventCount != 2 || cost.PricedEventCount != 1 || cost.PricedTotalNanos != 100 ||
		cost.KnownUncachedInputCount != 2 || cost.KnownUncachedInputNanos != 50 || cost.UnpricedKnownUncachedInputNanos != 30 ||
		cost.KnownCacheReadCount != 1 || cost.KnownOutputNanos != 75 || cost.UnpricedKnownOutputNanos != 5 {
		t.Fatalf("compact cost facts = %+v", cost)
	}
}

func TestUsageAggregatesReturnSQLiteIntegerOverflow(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(1700000000, 0).UTC()
	sess := seedUsageSession(t, s, domain.HarnessCodex)
	source := seedUsageSource(t, s, sess, now)
	if err := s.ApplyUsageChunk(ctx, source.ID, 0, source.UpdatedAt, domain.SourceCursorState{
		ByteOffset: 10, State: domain.UsageSourceComplete, UpdatedAt: now,
	}, []domain.ModelUsageEvent{
		usageEvent("overflow-1", canonicalUsageTokens(math.MaxInt64, 0, math.MaxInt64, 0)),
		usageEvent("overflow-2", canonicalUsageTokens(math.MaxInt64, 0, math.MaxInt64, 0)),
	}); err != nil {
		t.Fatalf("apply overflow events: %v", err)
	}
	if _, err := s.ListUsageModelAggregates(ctx, sess.ID); err == nil || !strings.Contains(err.Error(), "integer overflow") {
		t.Fatalf("detail overflow error = %v", err)
	}
	if _, err := s.ListCompactSessionUsageAggregates(ctx, sess.ProjectID); err == nil || !strings.Contains(err.Error(), "integer overflow") {
		t.Fatalf("compact overflow error = %v", err)
	}
}

func TestListCompactSessionUsageAggregatesAndFiltersByProject(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(1700000000, 0).UTC()
	seedProject(t, s, "usage")
	seedProject(t, s, "other")

	usageRec := sampleRecord("usage")
	usageRec.Harness = domain.HarnessCodex
	usageSession, err := s.CreateSession(ctx, usageRec)
	mustNoError(t, err, "create usage session")
	otherSession, err := s.CreateSession(ctx, sampleRecord("other"))
	mustNoError(t, err, "create other session")
	source := seedUsageSource(t, s, usageSession, now)
	if err := s.ApplyUsageChunk(ctx, source.ID, 0, source.UpdatedAt, domain.SourceCursorState{
		ByteOffset: 10,
		State:      domain.UsageSourceComplete,
		UpdatedAt:  now,
	}, []domain.ModelUsageEvent{
		usageEvent("event-1", canonicalUsageTokens(100, 50, 50, 20)),
		usageEvent("event-2", canonicalUsageTokens(50, 20, 30, 10)),
	}); err != nil {
		t.Fatalf("apply usage events: %v", err)
	}
	if _, err := s.MarkUsageSourceState(ctx, source.ID, domain.UsageSourceComplete, domain.UsageErrorArtifactReplaced, nil, now); err != nil {
		t.Fatalf("retire original source: %v", err)
	}
	mustInsertUsageSource(t, s, now, domain.UsageSourceRecord{
		BindingID:       source.BindingID,
		Kind:            source.Kind,
		NativeSessionID: source.NativeSessionID,
		ArtifactPath:    source.ArtifactPath,
		FileIdentity:    "replacement",
		Generation:      1,
		State:           domain.UsageSourceComplete,
	})
	if _, err := s.UpdateUsageBindingState(ctx, source.BindingID, domain.UsageBindingComplete, "", now); err != nil {
		t.Fatalf("complete replacement binding: %v", err)
	}

	got, err := s.ListCompactSessionUsageAggregates(ctx, "usage")
	mustNoError(t, err, "list compact usage")
	if len(got) != 1 || got[0].SessionID != usageSession.ID {
		t.Fatalf("filtered rows = %+v, want only %s (not %s)", got, usageSession.ID, otherSession.ID)
	}
	row := got[0]
	if usageTokenValue(row.ProcessedTokens) != 180 || row.Incomplete {
		t.Fatalf("aggregate = %+v", row)
	}
	all, err := s.ListCompactSessionUsageAggregates(ctx, "")
	mustNoError(t, err, "list all compact usage")
	if len(all) != 1 {
		t.Fatalf("all rows = %d, want only sessions with usage", len(all))
	}
}

func TestListCompactSessionUsageSeparatesRetriesFromIntegrityFailures(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(1700000000, 0).UTC()
	transientSession := seedUsageSession(t, s, domain.HarnessCodex)
	transientSource := seedUsageSource(t, s, transientSession, now)
	if err := s.ApplyUsageChunk(ctx, transientSource.ID, 0, transientSource.UpdatedAt, domain.SourceCursorState{
		ByteOffset: 1,
		State:      domain.UsageSourceActive,
		UpdatedAt:  now,
	}, []domain.ModelUsageEvent{
		usageEvent("transient-event", canonicalUsageTokens(1, 0, 1, 0)),
	}); err != nil {
		t.Fatalf("seed transient usage: %v", err)
	}
	if _, err := s.MarkUsageSourceState(
		ctx,
		transientSource.ID,
		domain.UsageSourceError,
		domain.UsageErrorSourceReadFailed,
		nil,
		now,
	); err != nil {
		t.Fatalf("mark transient failure: %v", err)
	}

	incompleteSession := seedUsageSession(t, s, domain.HarnessCodex)
	incompleteSource := seedUsageSource(t, s, incompleteSession, now)
	if err := s.ApplyUsageChunk(ctx, incompleteSource.ID, 0, incompleteSource.UpdatedAt, domain.SourceCursorState{
		ByteOffset: 1,
		State:      domain.UsageSourceActive,
		UpdatedAt:  now,
	}, []domain.ModelUsageEvent{
		usageEvent("incomplete-event", canonicalUsageTokens(1, 0, 1, 0)),
	}); err != nil {
		t.Fatalf("seed incomplete usage: %v", err)
	}
	if _, err := s.MarkUsageSourceState(
		ctx,
		incompleteSource.ID,
		domain.UsageSourceComplete,
		domain.UsageErrorSourceEventConflict,
		nil,
		now,
	); err != nil {
		t.Fatalf("mark integrity failure: %v", err)
	}

	rows, err := s.ListCompactSessionUsageAggregates(ctx, transientSession.ProjectID)
	mustNoError(t, err)
	bySession := make(map[domain.SessionID]domain.CompactSessionUsageAggregate, len(rows))
	for _, row := range rows {
		bySession[row.SessionID] = row
	}
	if got := bySession[transientSession.ID]; got.Incomplete {
		t.Fatalf("transient aggregate = %+v, want retry without integrity warning", got)
	}
	if got := bySession[incompleteSession.ID]; !got.Incomplete {
		t.Fatalf("incomplete aggregate = %+v, want integrity warning", got)
	}
}

func TestUsageSessionAggregatesParentChildAndMultipleBindingsExactlyOnce(t *testing.T) {
	s := newTestStore(t)
	ctx := context.Background()
	now := time.Unix(1700000000, 0).UTC()
	sess := seedUsageSession(t, s, domain.HarnessCodex)

	newBinding := func(nativeRootID string) domain.UsageBindingRecord {
		t.Helper()
		return mustUpsertUsageBinding(t, s, sess, now, domain.UsageBindingRecord{
			NativeRootID:   nativeRootID,
			InitialModelID: "gpt-5",
			State:          domain.UsageBindingActive,
		})
	}
	newSource := func(binding domain.UsageBindingRecord, nativeID, subagentID, path string) domain.UsageSourceRecord {
		t.Helper()
		return mustInsertUsageSource(t, s, now, domain.UsageSourceRecord{
			BindingID:       binding.ID,
			Kind:            domain.UsageSourceCodexRollout,
			NativeSessionID: nativeID,
			SubagentID:      subagentID,
			ArtifactPath:    path,
			FileIdentity:    nativeID,
			State:           domain.UsageSourceActive,
		})
	}
	apply := func(source domain.UsageSourceRecord, key string, input, output int64, observedAt time.Time) {
		t.Helper()
		err := s.ApplyUsageChunk(ctx, source.ID, 0, source.UpdatedAt, domain.SourceCursorState{
			ByteOffset: 10,
			State:      domain.UsageSourceComplete,
			UpdatedAt:  observedAt,
		}, []domain.ModelUsageEvent{usageEvent(key, canonicalUsageTokens(input, 0, input, output))})
		if err != nil {
			t.Fatalf("apply source %d: %v", source.ID, err)
		}
	}

	rootBinding := newBinding("root-thread")
	parent := newSource(rootBinding, "root-thread", "", "/tmp/codex/root.jsonl")
	child := newSource(rootBinding, "child-thread", "child-thread", "/tmp/codex/child.jsonl")
	secondBinding := newBinding("resumed-thread")
	resumed := newSource(secondBinding, "resumed-thread", "", "/tmp/codex/resumed.jsonl")
	apply(parent, "parent-event", 100, 20, now)
	apply(child, "child-event", 30, 5, now.Add(time.Second))
	apply(resumed, "resumed-event", 50, 10, now.Add(2*time.Second))
	for _, binding := range []domain.UsageBindingRecord{rootBinding, secondBinding} {
		if _, err := s.UpdateUsageBindingState(ctx, binding.ID, domain.UsageBindingComplete, "", now); err != nil {
			t.Fatalf("complete binding %d: %v", binding.ID, err)
		}
	}

	models, err := s.ListUsageModelAggregates(ctx, sess.ID)
	mustNoError(t, err, "list model aggregates")
	if len(models) != 1 ||
		usageTokenValue(models[0].Tokens.InputTokens) != 180 || usageTokenValue(models[0].Tokens.OutputTokens) != 35 {
		t.Fatalf("model aggregates = %+v, want input=180 output=35 events=3", models)
	}

	compact, err := s.ListCompactSessionUsageAggregates(ctx, sess.ProjectID)
	mustNoError(t, err, "list compact usage")
	if len(compact) != 1 {
		t.Fatalf("compact rows = %+v, want one", compact)
	}
	row := compact[0]
	if usageTokenValue(row.ProcessedTokens) != 215 || row.Incomplete {
		t.Fatalf("compact aggregate = %+v", row)
	}
}

func seedUsageSession(t *testing.T, s *sqlite.Store, harness domain.AgentHarness) domain.SessionRecord {
	t.Helper()
	ctx := context.Background()
	seedProject(t, s, "usage")
	rec := sampleRecord("usage")
	rec.Harness = harness
	got, err := s.CreateSession(ctx, rec)
	mustNoError(t, err, "create usage session")
	return got
}

func seedUsageSource(t *testing.T, s *sqlite.Store, sess domain.SessionRecord, now time.Time) domain.UsageSourceRecord {
	t.Helper()
	initialModelID := "gpt-5"
	sourceKind := domain.UsageSourceCodexRollout
	artifactPath := "/tmp/codex/rollout.jsonl"
	if sess.Harness == domain.HarnessClaudeCode {
		initialModelID = "claude-x"
		sourceKind = domain.UsageSourceClaudeMain
		artifactPath = "/tmp/claude/transcript.jsonl"
	}
	binding := mustUpsertUsageBinding(t, s, sess, now, domain.UsageBindingRecord{
		NativeRootID:   "root-thread",
		InitialModelID: initialModelID,
		State:          domain.UsageBindingActive,
	})
	return mustInsertUsageSource(t, s, now, domain.UsageSourceRecord{
		BindingID:       binding.ID,
		Kind:            sourceKind,
		NativeSessionID: "child-thread",
		ArtifactPath:    artifactPath,
		FileIdentity:    "dev:ino",
		State:           domain.UsageSourcePending,
	})
}

func mustUpsertUsageBinding(
	t *testing.T,
	s *sqlite.Store,
	session domain.SessionRecord,
	now time.Time,
	record domain.UsageBindingRecord,
) domain.UsageBindingRecord {
	t.Helper()
	record.SessionID = session.ID
	record.Harness = session.Harness
	if record.UpdatedAt.IsZero() {
		record.UpdatedAt = now
	}
	binding, err := s.UpsertUsageBinding(context.Background(), record)
	mustNoError(t, err)
	return binding
}

func mustInsertUsageSource(
	t *testing.T,
	s *sqlite.Store,
	now time.Time,
	record domain.UsageSourceRecord,
) domain.UsageSourceRecord {
	t.Helper()
	if record.UpdatedAt.IsZero() {
		record.UpdatedAt = now
	}
	source, err := s.InsertUsageSource(context.Background(), record)
	mustNoError(t, err)
	return source
}

func usageEvent(key string, tokens domain.UsageTokenMetrics) domain.ModelUsageEvent {
	zero := int64(0)
	return domain.ModelUsageEvent{
		ProviderID: domain.UsageProviderOpenAI,
		ModelID:    "gpt-5",
		Tokens:     tokens,
		ProviderDetails: domain.UsageProviderDetails{OpenAI: &domain.OpenAIUsageDetails{
			ReasoningOutputTokens: &zero, CacheWriteInputTokens: &zero,
		}},
		SourceEventKey: key,
	}
}

func pricedCandidateEvent(key string) domain.ModelUsageEvent {
	event := usageEvent(key, canonicalUsageTokens(5, 1, 4, 3))
	event.BillingProviderID = "openai"
	event.ModelID = "gpt-test"
	event.Costs.PricingVersion = "catalog-v1"
	return event
}

func anthropicUsageEvent(key string, directInput, cacheCreationInput, cachedInput, output int64) domain.ModelUsageEvent {
	input := directInput + cacheCreationInput + cachedInput
	uncachedInput := directInput + cacheCreationInput
	tokens := canonicalUsageTokens(input, cachedInput, uncachedInput, output)
	tokens.Provenance.InputTokens = domain.UsageMetricDerived
	return domain.ModelUsageEvent{
		ProviderID: domain.UsageProviderAnthropic,
		ModelID:    "claude-x",
		Tokens:     tokens,
		ProviderDetails: domain.UsageProviderDetails{Anthropic: &domain.AnthropicUsageDetails{
			DirectUncachedInputTokens: &directInput, CacheCreationInputTokens: &cacheCreationInput,
		}},
		SourceEventKey: key,
	}
}

func canonicalUsageTokens(input, cachedInput, uncachedInput, output int64) domain.UsageTokenMetrics {
	return domain.UsageTokenMetrics{
		InputTokens: &input, CachedInputTokens: &cachedInput, UncachedInputTokens: &uncachedInput,
		OutputTokens: &output,
		Provenance: domain.UsageMetricProvenanceSet{
			InputTokens: domain.UsageMetricReported, CachedInputTokens: domain.UsageMetricReported,
			UncachedInputTokens: domain.UsageMetricDerived,
			OutputTokens:        domain.UsageMetricReported,
		},
	}
}

func usageTokenValue(value *int64) int64 {
	if value == nil {
		return -1
	}
	return *value
}

func assertUsageSourceOffset(t *testing.T, s *sqlite.Store, sourceID int64, want int64) {
	t.Helper()
	got, ok, err := s.GetUsageSourceForIngestion(context.Background(), sourceID)
	if err != nil || !ok {
		t.Fatalf("get usage source: ok=%v err=%v", ok, err)
	}
	if got.Source.ByteOffset != want {
		t.Fatalf("source offset = %d, want %d", got.Source.ByteOffset, want)
	}
}

func mustNoError(t testing.TB, err error, context ...string) {
	t.Helper()
	if err != nil {
		if len(context) > 0 {
			t.Fatalf("%s: %v", context[0], err)
		}
		t.Fatal(err)
	}
}
