package usage

import (
	"encoding/json"
	"strconv"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type piSessionRecord struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Timestamp string `json:"timestamp"`
	Message   *struct {
		Role     string `json:"role"`
		Provider string `json:"provider"`
		Model    string `json:"model"`
		Usage    *struct {
			Input       int64  `json:"input"`
			Output      int64  `json:"output"`
			CacheRead   int64  `json:"cacheRead"`
			CacheWrite  int64  `json:"cacheWrite"`
			TotalTokens *int64 `json:"totalTokens"`
		} `json:"usage"`
	} `json:"message"`
}

func parsePi(source domain.UsageSourceContext, records []jsonlRecord, result *parseResult) {
	eventsByKey := make(map[string]domain.ModelUsageEvent)
	for _, record := range records {
		var native piSessionRecord
		if err := json.Unmarshal(record.Data, &native); err != nil {
			recordMalformed(result)
			continue
		}
		if native.Type != "message" || native.Message == nil || native.Message.Role != "assistant" {
			continue
		}
		message := native.Message
		model := firstNonEmpty(message.Model)
		if model == "" || message.Usage == nil {
			recordMalformed(result)
			continue
		}
		provider := strings.TrimSpace(message.Provider)
		if provider != "" {
			model = provider + "/" + model
		}
		usage := message.Usage
		input, ok := sumNonNegative(usage.Input, usage.CacheRead, usage.CacheWrite)
		if !ok {
			recordMalformed(result)
			continue
		}
		providerID := domain.UsageProviderOpenAI
		providerDetails := domain.UsageProviderDetails{}
		var tokens domain.UsageTokenMetrics
		if strings.EqualFold(provider, "anthropic") {
			var details domain.AnthropicUsageDetails
			tokens, details, ok = normalizeAnthropicUsage(
				usage.Input, usage.CacheWrite, usage.CacheRead, usage.Output, nil, nil,
			)
			providerID = domain.UsageProviderAnthropic
			providerDetails.Anthropic = &details
		} else {
			reportedTotal := int64(0)
			if usage.TotalTokens != nil {
				reportedTotal = *usage.TotalTokens
			}
			var details domain.OpenAIUsageDetails
			tokens, details, ok = normalizeOpenAIUsage(
				input, usage.CacheRead, usage.CacheWrite, usage.Output, 0, reportedTotal,
			)
			// Pi reports direct input and cache buckets separately, so its
			// canonical total input is derived rather than directly reported.
			tokens.Provenance.InputTokens = domain.UsageMetricDerived
			providerDetails.OpenAI = &details
		}
		if !ok {
			recordMalformed(result)
			continue
		}
		identity := firstNonEmpty(native.ID, strconv.FormatInt(record.Offset, 10))
		event := domain.ModelUsageEvent{
			ProviderID:      providerID,
			ModelID:         model,
			Tokens:          tokens,
			ProviderDetails: providerDetails,
			CreatedAt:       parseUsageTimestamp(native.Timestamp),
			SourceEventKey: stableSourceEventKey(
				"pi", source.NativeRootID, identity, provider, strings.TrimSpace(message.Model),
			),
		}
		if existing, duplicate := eventsByKey[event.SourceEventKey]; duplicate {
			if !usageEventsEqual(existing, event) {
				result.Cursor.AnomalyCount++
				result.Cursor.LastErrorCode = domain.UsageErrorSourceEventConflict
			}
			continue
		}
		eventsByKey[event.SourceEventKey] = event
		result.Events = append(result.Events, event)
	}
}
