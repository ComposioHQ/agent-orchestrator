package catalogsync_test

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pricing"
	"github.com/aoagents/agent-orchestrator/backend/internal/pricing/catalogsync"
)

// Break caught: the generator accepted fractional trailing zeroes that the
// runtime's stricter canonical decimal decoder rejected.
func TestGeneratedFractionalRatesLoadInRuntime(t *testing.T) {
	root := t.TempDir()
	upstream := []byte(`{
"anthropic/a":{"litellm_provider":"anthropic","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1},
"openai/o":{"litellm_provider":"openai","mode":"chat","input_cost_per_token":0.0010,"output_cost_per_token":1.2300e-3},
"zai/z":{"litellm_provider":"zai","mode":"chat","input_cost_per_token":1,"output_cost_per_token":1}
}`)
	_, err := catalogsync.Sync(root, upstream, catalogsync.Source{
		Repository: "BerriAI/litellm",
		Revision:   "0123456789abcdef0123456789abcdef01234567",
		Path:       "model_prices_and_context_window.json",
	})
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := pricing.NewCache(root).Load()
	if err != nil {
		t.Fatalf("runtime load generated catalog: %v", err)
	}
	estimate, err := catalog.Snapshot().Estimate(domain.ModelUsageEvent{
		ProviderID: "openai",
		ModelID:    "o",
		Tokens: domain.UsageTokenMetrics{
			InputTokens: 1, UncachedInputTokens: 1, OutputTokens: 1,
		},
	})
	if err != nil {
		t.Fatalf("runtime estimate generated rates: %v", err)
	}
	if estimate.TotalNanos == nil || *estimate.TotalNanos != 2_230_000 {
		t.Fatalf("runtime total = %v, want 2230000 nano-USD", estimate.TotalNanos)
	}
}
