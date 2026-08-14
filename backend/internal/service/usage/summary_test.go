package usage

import (
	"context"
	"math"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type usageSummaryStoreStub struct {
	projectID  domain.ProjectID
	rows       []domain.CompactSessionUsageAggregate
	session    domain.SessionRecord
	found      bool
	incomplete bool
	models     []domain.UsageModelAggregate
	calls      [4]int
}

func (s *usageSummaryStoreStub) ListCompactSessionUsageAggregates(_ context.Context, id domain.ProjectID) ([]domain.CompactSessionUsageAggregate, error) {
	s.projectID, s.calls[0] = id, s.calls[0]+1
	return s.rows, nil
}
func (s *usageSummaryStoreStub) GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error) {
	s.calls[1]++
	return s.session, s.found, nil
}
func (s *usageSummaryStoreStub) ListUsageModelAggregates(context.Context, domain.SessionID) ([]domain.UsageModelAggregate, error) {
	s.calls[2]++
	return s.models, nil
}
func (s *usageSummaryStoreStub) GetUsageSessionIncomplete(context.Context, domain.SessionID) (bool, error) {
	s.calls[3]++
	return s.incomplete, nil
}

func TestSummaryReaderListCompactUsesOneBatchRead(t *testing.T) {
	store := &usageSummaryStoreStub{rows: []domain.CompactSessionUsageAggregate{
		{
			SessionID: "zero", InputTokens: 0, OutputTokens: 0,
			Cost: completeCostAggregate(1, 0, 0, 0, 0, 0),
		},
		{
			SessionID: "partial", InputTokens: 100, OutputTokens: 20, Incomplete: true,
			Cost: domain.UsageCostAggregate{
				EventCount:                      1,
				KnownUncachedInputCount:         1,
				KnownUncachedInputNanos:         30,
				UnpricedKnownUncachedInputNanos: 30,
				KnownCacheWriteCount:            1,
				KnownCacheWriteNanos:            0,
				UnpricedKnownCacheWriteNanos:    0,
				KnownOutputCount:                1,
				KnownOutputNanos:                5,
				UnpricedKnownOutputNanos:        5,
			},
		},
	}}

	got, err := NewSummaryReader(store).ListCompact(context.Background(), "reverb")
	mustNoError(t, err)
	if store.calls[0] != 1 || store.projectID != "reverb" || len(got) != 2 {
		t.Fatalf("read=%d project=%q items=%+v", store.calls[0], store.projectID, got)
	}
	if got[0].EstimatedCost == nil || got[0].EstimatedCost.Coverage != domain.EstimatedCostCoverageComplete || got[0].EstimatedCost.TotalNanos != 0 {
		t.Fatalf("zero cost = %+v, want complete zero", got[0].EstimatedCost)
	}
	if got[1].TotalTokens != 120 || !got[1].Incomplete || got[1].EstimatedCost == nil ||
		got[1].EstimatedCost.Coverage != domain.EstimatedCostCoveragePartial || got[1].EstimatedCost.TotalNanos != 35 {
		t.Fatalf("partial compact summary = %+v", got[1])
	}
	if got[1].EstimatedCost.CacheReadNanos != nil || got[1].EstimatedCost.CacheWriteNanos == nil || *got[1].EstimatedCost.CacheWriteNanos != 0 {
		t.Fatalf("partial components = %+v", got[1].EstimatedCost)
	}
}

func TestSummaryReaderGetPreservesStrongestPartialLowerBoundWithoutDoubleCounting(t *testing.T) {
	reasoning := int64(40)
	store := &usageSummaryStoreStub{
		found:      true,
		incomplete: true,
		session:    domain.SessionRecord{ID: "reverb-12", Harness: domain.HarnessCodex},
		models: []domain.UsageModelAggregate{
			{
				Harness: domain.HarnessCodex, ProviderID: "openai", ModelID: "shared-model",
				Tokens:              domain.UsageTokenMetrics{InputTokens: 1000, UncachedInputTokens: 600, CacheReadTokens: 400, OutputTokens: 200, ReasoningTokens: &reasoning},
				ReasoningEventCount: 2,
				Cost:                completeCostAggregate(1, 100, 20, 10, 0, 70),
			},
			{
				Harness: domain.HarnessCodex, ProviderID: "zai", ModelID: "shared-model",
				Tokens: domain.UsageTokenMetrics{InputTokens: 100, UncachedInputTokens: 80, CacheReadTokens: 20, OutputTokens: 25},
				Cost: domain.UsageCostAggregate{
					EventCount:                      1,
					KnownUncachedInputCount:         1,
					KnownUncachedInputNanos:         30,
					UnpricedKnownUncachedInputNanos: 30,
					KnownCacheWriteCount:            1,
					KnownCacheWriteNanos:            0,
					KnownOutputCount:                1,
					KnownOutputNanos:                5,
					UnpricedKnownOutputNanos:        5,
				},
			},
		},
	}

	got, err := NewSummaryReader(store).Get(context.Background(), "reverb-12")
	mustNoError(t, err)
	if !got.Incomplete {
		t.Fatal("token integrity failure did not remain independent from cost coverage")
	}
	if got.Totals.InputTokens == nil || *got.Totals.InputTokens != 1100 ||
		got.Totals.OutputTokens == nil || *got.Totals.OutputTokens != 225 ||
		got.Totals.ReasoningTokens == nil || *got.Totals.ReasoningTokens != 40 {
		t.Fatalf("totals = %+v", got.Totals)
	}
	cost := got.Totals.EstimatedCost
	if cost == nil || cost.Coverage != domain.EstimatedCostCoveragePartial || cost.TotalNanos != 135 {
		t.Fatalf("session cost = %+v, want partial lower bound 100+30+5", cost)
	}
	if cost.UncachedInputNanos == nil || *cost.UncachedInputNanos != 50 || cost.CacheReadNanos != nil ||
		cost.CacheWriteNanos == nil || *cost.CacheWriteNanos != 0 || cost.OutputNanos == nil || *cost.OutputNanos != 75 {
		t.Fatalf("session component coverage = %+v", cost)
	}
	if len(got.Harnesses) != 1 || len(got.Harnesses[0].Models) != 2 ||
		got.Harnesses[0].Models[0].ProviderID != "openai" || got.Harnesses[0].Models[1].ProviderID != "zai" {
		t.Fatalf("provider/model grouping = %+v", got.Harnesses)
	}
	if got.Harnesses[0].Models[0].Totals.EstimatedCost == nil ||
		got.Harnesses[0].Models[0].Totals.EstimatedCost.Coverage != domain.EstimatedCostCoverageComplete ||
		got.Harnesses[0].Models[1].Totals.EstimatedCost == nil ||
		got.Harnesses[0].Models[1].Totals.EstimatedCost.TotalNanos != 35 {
		t.Fatalf("model costs = %+v", got.Harnesses[0].Models)
	}
	if store.calls != [4]int{0, 1, 1, 1} {
		t.Fatalf("store calls = %v", store.calls)
	}
}

func TestSummaryReaderReturnsUnavailableCostForZeroPartialLowerBound(t *testing.T) {
	store := &usageSummaryStoreStub{rows: []domain.CompactSessionUsageAggregate{{
		SessionID: "unknown", Cost: domain.UsageCostAggregate{EventCount: 1},
	}}}
	got, err := NewSummaryReader(store).ListCompact(context.Background(), "")
	mustNoError(t, err)
	if len(got) != 1 || got[0].EstimatedCost != nil {
		t.Fatalf("cost = %+v, want unavailable", got)
	}
}

func TestSummaryReaderRejectsAggregateOverflow(t *testing.T) {
	t.Run("compact tokens", func(t *testing.T) {
		store := &usageSummaryStoreStub{rows: []domain.CompactSessionUsageAggregate{{
			SessionID: "overflow", InputTokens: math.MaxInt64, OutputTokens: 1,
		}}}
		if _, err := NewSummaryReader(store).ListCompact(context.Background(), ""); err == nil {
			t.Fatal("compact token overflow returned nil error")
		}
	})

	t.Run("partial lower bound", func(t *testing.T) {
		store := &usageSummaryStoreStub{rows: []domain.CompactSessionUsageAggregate{{
			SessionID: "overflow",
			Cost: domain.UsageCostAggregate{
				EventCount:                      2,
				PricedEventCount:                1,
				PricedTotalNanos:                math.MaxInt64,
				KnownUncachedInputCount:         1,
				KnownUncachedInputNanos:         1,
				UnpricedKnownUncachedInputNanos: 1,
			},
		}}}
		if _, err := NewSummaryReader(store).ListCompact(context.Background(), ""); err == nil {
			t.Fatal("partial cost overflow returned nil error")
		}
	})

	t.Run("detail groups", func(t *testing.T) {
		store := &usageSummaryStoreStub{found: true, models: []domain.UsageModelAggregate{
			{Harness: domain.HarnessCodex, ProviderID: "openai", ModelID: "one", Tokens: domain.UsageTokenMetrics{InputTokens: math.MaxInt64}},
			{Harness: domain.HarnessCodex, ProviderID: "openai", ModelID: "two", Tokens: domain.UsageTokenMetrics{InputTokens: 1}},
		}}
		if _, err := NewSummaryReader(store).Get(context.Background(), "overflow"); err == nil {
			t.Fatal("detailed token overflow returned nil error")
		}
	})
}

func TestSummaryReaderGetReturnsUnavailableMetricsWithoutEvents(t *testing.T) {
	store := &usageSummaryStoreStub{found: true, session: domain.SessionRecord{ID: "empty"}}
	got, err := NewSummaryReader(store).Get(context.Background(), "empty")
	mustNoError(t, err)
	if got.Totals.InputTokens != nil || got.Totals.OutputTokens != nil || got.Totals.EstimatedCost != nil || len(got.Harnesses) != 0 {
		t.Fatalf("empty usage = %+v", got)
	}
}

func completeCostAggregate(events, total, input, cacheRead, cacheWrite, output int64) domain.UsageCostAggregate {
	return domain.UsageCostAggregate{
		EventCount: events, PricedEventCount: events, PricedTotalNanos: total,
		KnownUncachedInputCount: events, KnownUncachedInputNanos: input,
		KnownCacheReadCount: events, KnownCacheReadNanos: cacheRead,
		KnownCacheWriteCount: events, KnownCacheWriteNanos: cacheWrite,
		KnownOutputCount: events, KnownOutputNanos: output,
	}
}
