package usagetelemetry

import (
	"math"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func i64(v int64) *int64 { return &v }

func TestModelCost(t *testing.T) {
	t.Parallel()
	// Opus 4.x is $5 / $25: 1M fresh input + 1M output = $5 + $25 = $30.
	opus := domain.UsageMetricTotals{UncachedInputTokens: i64(1_000_000), OutputTokens: i64(1_000_000)}
	if got := round2(modelCost("claude-opus-4-8", opus)); got != 30 {
		t.Fatalf("opus-4-8 cost = %v, want 30", got)
	}
	// Legacy Claude 3 Opus keeps its own $15 / $75 rate, not the 4.x rate.
	if got := round2(modelCost("claude-3-opus-20240229", opus)); got != 90 {
		t.Fatalf("claude-3-opus cost = %v, want 90", got)
	}
	// Uncached is derived from InputTokens minus the cached portion, so cached
	// reads are not double-charged. 5M input, 1M cached on Sonnet =
	// 4M fresh*$3 + 1M cached*$0.30 = $12 + $0.30 = $12.30.
	split := domain.UsageMetricTotals{InputTokens: i64(5_000_000), CachedInputTokens: i64(1_000_000)}
	if got := round2(modelCost("claude-sonnet-5", split)); got != 12.30 {
		t.Fatalf("sonnet split-input cost = %v, want 12.30", got)
	}
	// GPT-5.4 is $2.50 / $15, cached $0.25.
	gpt := domain.UsageMetricTotals{UncachedInputTokens: i64(1_000_000), OutputTokens: i64(1_000_000), CachedInputTokens: i64(1_000_000)}
	if got := round2(modelCost("gpt-5.4", gpt)); got != 17.75 {
		t.Fatalf("gpt-5.4 cost = %v, want 17.75", got)
	}
	// Opus 4.x cache-read is $0.50/M.
	cache := domain.UsageMetricTotals{CachedInputTokens: i64(1_000_000)}
	if got := round2(modelCost("claude-opus-4-8", cache)); got != 0.5 {
		t.Fatalf("opus-4-8 cache-read cost = %v, want 0.5", got)
	}
	// Unmatched model: unpriced (never guessed), tokens still counted elsewhere.
	if got := modelCost("gpt-9-turbo", opus); got != 0 {
		t.Fatalf("unmatched model cost = %v, want 0", got)
	}
	if got := modelCost("some-other-llm", opus); got != 0 {
		t.Fatalf("unknown model cost = %v, want 0", got)
	}
}

func TestPriceForHaikuTierPrecedence(t *testing.T) {
	t.Parallel()
	one := domain.UsageMetricTotals{OutputTokens: i64(1_000_000)}
	if got := round2(modelCost("claude-3-haiku-20240307", one)); got != 1.25 {
		t.Fatalf("claude-3-haiku output cost = %v, want 1.25", got)
	}
	if got := round2(modelCost("claude-3-5-haiku-latest", one)); got != 4 {
		t.Fatalf("claude-3-5-haiku output cost = %v, want 4", got)
	}
	if got := round2(modelCost("claude-haiku-4-5", one)); got != 4 {
		t.Fatalf("claude-haiku-4-5 output cost = %v, want 4", got)
	}
}

// Regression for the precision defect: many sub-cent sessions must aggregate
// exactly via integer micro-dollars, not vanish to $0 through per-session
// cent rounding.
func TestMicroUSDAggregationDoesNotLoseSubCentSessions(t *testing.T) {
	t.Parallel()
	// A sub-cent session on Opus 4.x: 100 output tokens = 100/1e6 * $25 =
	// $0.0025, which cent-rounds to $0.00.
	small := domain.UsageMetricTotals{OutputTokens: i64(100)}
	perSession := modelCost("claude-opus-4-8", small)
	if round2(perSession) != 0 {
		t.Fatalf("sanity: a sub-cent session should cent-round to $0.00, got %v", round2(perSession))
	}
	microPerSession := int64(math.Round(perSession * 1_000_000))
	if microPerSession != 2500 {
		t.Fatalf("micro-usd/session = %d, want 2500 (=$0.0025)", microPerSession)
	}
	// Micro-dollars sum exactly across many sessions, where per-session cent
	// rounding would have summed to $0.
	var totalMicro int64
	for i := 0; i < 10_000; i++ {
		totalMicro += microPerSession
	}
	if totalMicro != 25_000_000 { // 10k * 2500 micro-usd = $25.00
		t.Fatalf("aggregated micro-usd = %d, want 25000000 ($25)", totalMicro)
	}
}
