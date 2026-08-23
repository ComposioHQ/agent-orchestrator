package usage

import (
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// TestParseQwenUsageForBoundSession catches cross-session attribution and
// preserves Qwen's cached and reasoning token buckets.
func TestParseQwenUsageForBoundSession(t *testing.T) {
	source := usageSource(domain.UsageSourceQwenMonthly)
	source.NativeRootID = "qwen-session"
	records := []jsonlRecord{
		{Data: []byte(`{"schemaVersion":1,"id":"other","sessionId":"another","model":"qwen3","inputTokens":999,"outputTokens":999,"cachedTokens":0,"thoughtsTokens":0,"totalTokens":1998}`)},
		{Offset: 100, Data: []byte(`{"schemaVersion":1,"id":"turn-1","timestamp":"2026-08-09T10:00:00Z","sessionId":"qwen-session","model":"qwen3-coder","inputTokens":30,"outputTokens":12,"cachedTokens":9,"thoughtsTokens":4,"totalTokens":46}`)},
	}

	result := parseRecords(source, records, 300, time.Unix(1700000000, 0).UTC())
	if result.err != nil || len(result.Events) != 1 {
		t.Fatalf("result = %+v", result)
	}
	event := result.Events[0]
	if event.ProviderID != domain.UsageProviderOpenAI || event.ModelID != "qwen3-coder" ||
		event.CreatedAt != time.Date(2026, 8, 9, 10, 0, 0, 0, time.UTC) || event.SourceEventKey == "" {
		t.Fatalf("event = %+v", event)
	}
	assertQwenMetric(t, "input", event.Tokens.InputTokens, 30, event.Tokens.Provenance.InputTokens, domain.UsageMetricReported)
	assertQwenMetric(t, "cached input", event.Tokens.CachedInputTokens, 9, event.Tokens.Provenance.CachedInputTokens, domain.UsageMetricReported)
	assertQwenMetric(t, "uncached input", event.Tokens.UncachedInputTokens, 21, event.Tokens.Provenance.UncachedInputTokens, domain.UsageMetricDerived)
	assertQwenMetric(t, "output", event.Tokens.OutputTokens, 16, event.Tokens.Provenance.OutputTokens, domain.UsageMetricReported)
	details := event.ProviderDetails.OpenAI
	if details == nil || details.ReasoningOutputTokens == nil || *details.ReasoningOutputTokens != 4 ||
		details.ReportedTotalTokens == nil || *details.ReportedTotalTokens != 46 ||
		event.ProviderDetails.Anthropic != nil {
		t.Fatalf("provider details = %+v", event.ProviderDetails)
	}
}

func TestParseQwenRejectsInconsistentTotals(t *testing.T) {
	source := usageSource(domain.UsageSourceQwenMonthly)
	source.NativeRootID = "native-root"
	record := jsonlRecord{Data: []byte(`{"schemaVersion":1,"id":"bad","sessionId":"native-root","model":"qwen3","inputTokens":3,"outputTokens":2,"cachedTokens":4,"thoughtsTokens":0,"totalTokens":5}`)}
	result := parseRecords(source, []jsonlRecord{record}, 100, time.Now())
	if result.err != nil {
		t.Fatal(result.err)
	}
	if len(result.Events) != 0 || result.Cursor.AnomalyCount != 1 ||
		result.Cursor.LastErrorCode != domain.UsageErrorMalformedJSONL {
		t.Fatalf("result = %+v", result)
	}
}

func TestParseQwenAllowsOmittedTotalTokens(t *testing.T) {
	source := usageSource(domain.UsageSourceQwenMonthly)
	source.NativeRootID = "native-root"
	record := jsonlRecord{Data: []byte(`{"schemaVersion":1,"id":"turn-1","sessionId":"native-root","model":"qwen3","inputTokens":3,"outputTokens":2,"cachedTokens":1,"thoughtsTokens":0}`)}
	result := parseRecords(source, []jsonlRecord{record}, 100, time.Now())
	if result.err != nil || len(result.Events) != 1 {
		t.Fatalf("result = %+v", result)
	}
}

func assertQwenMetric(
	t *testing.T,
	name string,
	value *int64,
	want int64,
	provenance domain.UsageMetricProvenance,
	wantProvenance domain.UsageMetricProvenance,
) {
	t.Helper()
	if value == nil || *value != want || provenance != wantProvenance {
		t.Fatalf("%s = %v (%s), want %d (%s)", name, value, provenance, want, wantProvenance)
	}
}
