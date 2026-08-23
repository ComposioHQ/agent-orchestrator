package usage

import (
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// TestParsePiAssistantUsage catches dropping Pi cache-write input or treating
// non-assistant messages as model usage.
func TestParsePiAssistantUsage(t *testing.T) {
	source := usageSource(domain.UsageSourcePiSession)
	source.NativeRootID = "pi-session"
	records := []jsonlRecord{
		{Data: []byte(`{"type":"session","id":"pi-session","cwd":"/repo","version":3}`)},
		{Offset: 100, Data: []byte(`{"type":"message","id":"msg-1","timestamp":"2026-08-09T10:00:00Z","message":{"role":"assistant","provider":"zai-glm","model":"glm-4.5","usage":{"input":11,"output":7,"cacheRead":5,"cacheWrite":3,"totalTokens":26}}}`)},
		{Offset: 200, Data: []byte(`{"type":"message","id":"msg-2","message":{"role":"user","usage":{"input":100}}}`)},
	}

	result := parseRecords(source, records, 300, time.Unix(1700000000, 0).UTC())
	if result.err != nil || len(result.Events) != 1 {
		t.Fatalf("result = %+v", result)
	}
	event := result.Events[0]
	if event.ProviderID != domain.UsageProviderOpenAI || event.ModelID != "zai-glm/glm-4.5" ||
		event.CreatedAt != time.Date(2026, 8, 9, 10, 0, 0, 0, time.UTC) || event.SourceEventKey == "" {
		t.Fatalf("event = %+v", event)
	}
	assertUsageMetric(t, "input", event.Tokens.InputTokens, 19, event.Tokens.Provenance.InputTokens, domain.UsageMetricDerived)
	assertUsageMetric(t, "cached input", event.Tokens.CachedInputTokens, 5, event.Tokens.Provenance.CachedInputTokens, domain.UsageMetricReported)
	assertUsageMetric(t, "uncached input", event.Tokens.UncachedInputTokens, 14, event.Tokens.Provenance.UncachedInputTokens, domain.UsageMetricDerived)
	assertUsageMetric(t, "output", event.Tokens.OutputTokens, 7, event.Tokens.Provenance.OutputTokens, domain.UsageMetricReported)
	details := event.ProviderDetails.OpenAI
	if details == nil || details.CacheWriteInputTokens == nil || *details.CacheWriteInputTokens != 3 ||
		details.ReasoningOutputTokens == nil || *details.ReasoningOutputTokens != 0 ||
		event.ProviderDetails.Anthropic != nil {
		t.Fatalf("provider details = %+v", event.ProviderDetails)
	}
}

func TestParsePiRejectsInvalidUsage(t *testing.T) {
	source := usageSource(domain.UsageSourcePiSession)
	record := jsonlRecord{Data: []byte(`{"type":"message","id":"bad","message":{"role":"assistant","model":"m","usage":{"input":-1,"output":1}}}`)}
	result := parseRecords(source, []jsonlRecord{record}, 100, time.Now())
	if result.err != nil {
		t.Fatal(result.err)
	}
	if len(result.Events) != 0 || result.Cursor.AnomalyCount != 1 ||
		result.Cursor.LastErrorCode != domain.UsageErrorMalformedJSONL {
		t.Fatalf("result = %+v", result)
	}
}

func TestParsePiAnthropicUsageUsesAnthropicVocabulary(t *testing.T) {
	source := usageSource(domain.UsageSourcePiSession)
	source.NativeRootID = "pi-session"
	record := jsonlRecord{Data: []byte(`{"type":"message","id":"msg-1","message":{"role":"assistant","provider":"anthropic","model":"claude-sonnet","usage":{"input":11,"output":7,"cacheRead":5,"cacheWrite":3,"totalTokens":26}}}`)}

	result := parseRecords(source, []jsonlRecord{record}, 100, time.Now())
	if result.err != nil || len(result.Events) != 1 {
		t.Fatalf("result = %+v", result)
	}
	event := result.Events[0]
	if event.ProviderID != domain.UsageProviderAnthropic || event.ProviderDetails.OpenAI != nil {
		t.Fatalf("event = %+v", event)
	}
	details := event.ProviderDetails.Anthropic
	if details == nil || details.DirectUncachedInputTokens == nil ||
		*details.DirectUncachedInputTokens != 11 || details.CacheCreationInputTokens == nil ||
		*details.CacheCreationInputTokens != 3 {
		t.Fatalf("details = %+v", details)
	}
}

func assertUsageMetric(
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
