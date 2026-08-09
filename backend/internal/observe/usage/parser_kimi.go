package usage

import (
	"encoding/json"
	"strconv"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type kimiWireRecord struct {
	ID    string `json:"id"`
	Time  string `json:"time"`
	Type  string `json:"type"`
	Model string `json:"model"`
	Usage *struct {
		InputOther         int64 `json:"inputOther"`
		InputCacheRead     int64 `json:"inputCacheRead"`
		InputCacheCreation int64 `json:"inputCacheCreation"`
		Output             int64 `json:"output"`
	} `json:"usage"`
}

func parseKimi(source domain.UsageSourceContext, records []jsonlRecord, result *parseResult) {
	for _, record := range records {
		var native kimiWireRecord
		if err := json.Unmarshal(record.Data, &native); err != nil {
			recordMalformed(result)
			continue
		}
		if native.Type != "usage.record" {
			continue
		}
		model := firstNonEmpty(native.Model)
		if model == "" || native.Usage == nil {
			recordMalformed(result)
			continue
		}
		usage := native.Usage
		input, ok := sumNonNegative(usage.InputOther, usage.InputCacheRead, usage.InputCacheCreation)
		if !ok || usage.Output < 0 {
			recordMalformed(result)
			continue
		}
		tokens := domain.UsageTokenMetrics{
			InputTokens:         input,
			UncachedInputTokens: usage.InputOther,
			CacheReadTokens:     usage.InputCacheRead,
			CacheWriteTokens:    usage.InputCacheCreation,
			OutputTokens:        usage.Output,
		}
		if !validTokenMetrics(tokens) {
			recordMalformed(result)
			continue
		}
		identity := firstNonEmpty(native.ID, native.Time, strconv.FormatInt(record.Offset, 10))
		result.Events = append(result.Events, domain.ModelUsageEvent{
			ModelID: model,
			Tokens:  tokens,
			SourceEventKey: stableSourceEventKey(
				"kimi",
				source.NativeRootID,
				source.Source.SubagentID,
				identity,
				model,
			),
		})
	}
}
