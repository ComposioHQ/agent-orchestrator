package usage

import (
	"encoding/json"
	"strconv"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

type copilotTranscriptRecord struct {
	Type string `json:"type"`
	Data struct {
		ModelMetrics map[string]struct {
			Usage *struct {
				InputTokens      int64 `json:"inputTokens"`
				OutputTokens     int64 `json:"outputTokens"`
				CacheReadTokens  int64 `json:"cacheReadTokens"`
				CacheWriteTokens int64 `json:"cacheWriteTokens"`
				ReasoningTokens  int64 `json:"reasoningTokens"`
			} `json:"usage"`
		} `json:"modelMetrics"`
	} `json:"data"`
}

func parseCopilot(
	source domain.UsageSourceContext,
	records []jsonlRecord,
	state *copilotParserStateV1,
	result *parseResult,
) {
	for _, record := range records {
		var native copilotTranscriptRecord
		if err := json.Unmarshal(record.Data, &native); err != nil {
			recordMalformed(result)
			continue
		}
		if native.Type != "session.shutdown" {
			continue
		}
		for nativeModel, metrics := range native.Data.ModelMetrics {
			model := firstNonEmpty(nativeModel)
			if model == "" || metrics.Usage == nil {
				recordMalformed(result)
				continue
			}
			usage := metrics.Usage
			total := copilotTokenVector{
				InputTokens:      usage.InputTokens,
				CacheReadTokens:  usage.CacheReadTokens,
				CacheWriteTokens: usage.CacheWriteTokens,
				OutputTokens:     usage.OutputTokens,
				ReasoningTokens:  usage.ReasoningTokens,
			}
			if !validCopilotTotal(total) {
				recordMalformed(result)
				continue
			}
			baseline := state.Models[model]
			if copilotCounterRegressed(total, baseline) {
				state.Models[model] = total
				result.Cursor.AnomalyCount++
				result.Cursor.LastErrorCode = domain.UsageErrorNonMonotonicCumulativeUsage
				continue
			}
			delta := subtractCopilotTotal(total, baseline)
			state.Models[model] = total
			if delta.InputTokens == 0 && delta.OutputTokens == 0 && delta.CacheWriteTokens == 0 {
				continue
			}
			uncached := delta.InputTokens - delta.CacheReadTokens - delta.CacheWriteTokens
			tokens := domain.UsageTokenMetrics{
				InputTokens:         delta.InputTokens,
				UncachedInputTokens: uncached,
				CacheReadTokens:     delta.CacheReadTokens,
				CacheWriteTokens:    delta.CacheWriteTokens,
				OutputTokens:        delta.OutputTokens,
				ReasoningTokens:     int64Ptr(delta.ReasoningTokens),
			}
			if !validTokenMetrics(tokens) {
				recordMalformed(result)
				continue
			}
			result.Events = append(result.Events, domain.ModelUsageEvent{
				ModelID: model,
				Tokens:  tokens,
				SourceEventKey: stableSourceEventKey(
					"copilot",
					source.NativeRootID,
					model,
					strconv.FormatInt(total.InputTokens, 10),
					strconv.FormatInt(total.CacheReadTokens, 10),
					strconv.FormatInt(total.CacheWriteTokens, 10),
					strconv.FormatInt(total.OutputTokens, 10),
					strconv.FormatInt(total.ReasoningTokens, 10),
				),
			})
		}
	}
}

func validCopilotTotal(total copilotTokenVector) bool {
	return total.InputTokens >= 0 && total.CacheReadTokens >= 0 && total.CacheWriteTokens >= 0 &&
		total.OutputTokens >= 0 && total.ReasoningTokens >= 0 &&
		total.CacheReadTokens <= total.InputTokens &&
		total.CacheWriteTokens <= total.InputTokens-total.CacheReadTokens &&
		total.ReasoningTokens <= total.OutputTokens
}

func copilotCounterRegressed(total, baseline copilotTokenVector) bool {
	return total.InputTokens < baseline.InputTokens ||
		total.CacheReadTokens < baseline.CacheReadTokens ||
		total.CacheWriteTokens < baseline.CacheWriteTokens ||
		total.OutputTokens < baseline.OutputTokens ||
		total.ReasoningTokens < baseline.ReasoningTokens
}

func subtractCopilotTotal(total, baseline copilotTokenVector) copilotTokenVector {
	return copilotTokenVector{
		InputTokens:      total.InputTokens - baseline.InputTokens,
		CacheReadTokens:  total.CacheReadTokens - baseline.CacheReadTokens,
		CacheWriteTokens: total.CacheWriteTokens - baseline.CacheWriteTokens,
		OutputTokens:     total.OutputTokens - baseline.OutputTokens,
		ReasoningTokens:  total.ReasoningTokens - baseline.ReasoningTokens,
	}
}
