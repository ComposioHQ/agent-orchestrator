package usage

import (
	"context"
	"fmt"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

type usageSummaryStore interface {
	GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error)
	ListCompactSessionUsage(context.Context, domain.ProjectID) ([]domain.CompactSessionUsage, error)
	ListUsageModelAggregates(context.Context, domain.SessionID) ([]domain.UsageModelAggregate, error)
	GetUsageSessionIncomplete(context.Context, domain.SessionID) (bool, error)
}

// SummaryReader derives token summaries from normalized usage events.
type SummaryReader struct{ store usageSummaryStore }

// NewSummaryReader constructs a token-usage summary reader.
func NewSummaryReader(store usageSummaryStore) *SummaryReader { return &SummaryReader{store: store} }

// ListCompact returns one batch suitable for dashboard cards.
func (r *SummaryReader) ListCompact(ctx context.Context, projectID domain.ProjectID) ([]domain.CompactSessionUsage, error) {
	if r == nil || r.store == nil {
		return nil, fmt.Errorf("usage summary store is unavailable")
	}
	return r.store.ListCompactSessionUsage(ctx, projectID)
}

// Get returns detailed token telemetry for one session.
func (r *SummaryReader) Get(ctx context.Context, sessionID domain.SessionID) (domain.SessionUsageSummary, error) {
	if r == nil || r.store == nil {
		return domain.SessionUsageSummary{}, fmt.Errorf("usage summary store is unavailable")
	}
	if _, ok, err := r.store.GetSession(ctx, sessionID); err != nil {
		return domain.SessionUsageSummary{}, err
	} else if !ok {
		return domain.SessionUsageSummary{}, apierr.NotFound("SESSION_NOT_FOUND", "Unknown session")
	}

	models, err := r.store.ListUsageModelAggregates(ctx, sessionID)
	if err != nil {
		return domain.SessionUsageSummary{}, err
	}
	visibleModels := make([]domain.UsageModelAggregate, 0, len(models))
	for _, model := range models {
		if strings.EqualFold(strings.TrimSpace(model.ModelID), "<synthetic>") {
			continue
		}
		visibleModels = append(visibleModels, model)
	}
	models = visibleModels
	incomplete, err := r.store.GetUsageSessionIncomplete(ctx, sessionID)
	if err != nil {
		return domain.SessionUsageSummary{}, err
	}
	return domain.SessionUsageSummary{
		SessionID: sessionID, Incomplete: incomplete,
		Totals: usageTotals(models), Harnesses: harnessUsageSummaries(models),
	}, nil
}

func usageTotals(models []domain.UsageModelAggregate) domain.UsageMetricTotals {
	if len(models) == 0 {
		return domain.UsageMetricTotals{Provenance: unknownUsageProvenance()}
	}
	input, inputProvenance := aggregateMetric(models, func(model domain.UsageModelAggregate) (*int64, domain.UsageMetricProvenance) {
		return model.Tokens.InputTokens, model.Tokens.Provenance.InputTokens
	})
	cachedInput, cachedInputProvenance := aggregateMetric(models, func(model domain.UsageModelAggregate) (*int64, domain.UsageMetricProvenance) {
		return model.Tokens.CachedInputTokens, model.Tokens.Provenance.CachedInputTokens
	})
	uncachedInput, uncachedInputProvenance := aggregateMetric(models, func(model domain.UsageModelAggregate) (*int64, domain.UsageMetricProvenance) {
		return model.Tokens.UncachedInputTokens, model.Tokens.Provenance.UncachedInputTokens
	})
	output, outputProvenance := aggregateMetric(models, func(model domain.UsageModelAggregate) (*int64, domain.UsageMetricProvenance) {
		return model.Tokens.OutputTokens, model.Tokens.Provenance.OutputTokens
	})
	totals := domain.UsageMetricTotals{
		InputTokens: input, CachedInputTokens: cachedInput, UncachedInputTokens: uncachedInput,
		OutputTokens: output,
		Provenance: domain.UsageMetricProvenanceSet{
			InputTokens: inputProvenance, CachedInputTokens: cachedInputProvenance,
			UncachedInputTokens: uncachedInputProvenance,
			OutputTokens:        outputProvenance,
		},
		ProviderDetails: aggregateProviderDetails(models),
	}
	if input != nil && output != nil {
		processed := *input + *output
		totals.ProcessedTokens = &processed
	}
	return totals
}

type usageMetricSelector func(domain.UsageModelAggregate) (*int64, domain.UsageMetricProvenance)

func aggregateMetric(models []domain.UsageModelAggregate, selectMetric usageMetricSelector) (*int64, domain.UsageMetricProvenance) {
	var total int64
	provenance := domain.UsageMetricProvenance("")
	for _, model := range models {
		value, current := selectMetric(model)
		if value == nil || current == domain.UsageMetricUnknown {
			return nil, domain.UsageMetricUnknown
		}
		total += *value
		if provenance == "" {
			provenance = current
		} else if provenance != current {
			provenance = domain.UsageMetricDerived
		}
	}
	return &total, provenance
}

func aggregateProviderDetails(models []domain.UsageModelAggregate) domain.UsageProviderDetails {
	var openAI []*domain.OpenAIUsageDetails
	var anthropic []*domain.AnthropicUsageDetails
	for _, model := range models {
		if model.ProviderDetails.OpenAI != nil {
			openAI = append(openAI, model.ProviderDetails.OpenAI)
		}
		if model.ProviderDetails.Anthropic != nil {
			anthropic = append(anthropic, model.ProviderDetails.Anthropic)
		}
	}
	var details domain.UsageProviderDetails
	if len(openAI) > 0 {
		details.OpenAI = &domain.OpenAIUsageDetails{
			ReasoningOutputTokens: sumOptionalMetrics(openAI, func(detail *domain.OpenAIUsageDetails) *int64 { return detail.ReasoningOutputTokens }),
			CacheWriteInputTokens: sumOptionalMetrics(openAI, func(detail *domain.OpenAIUsageDetails) *int64 { return detail.CacheWriteInputTokens }),
		}
	}
	if len(anthropic) > 0 {
		details.Anthropic = &domain.AnthropicUsageDetails{
			DirectUncachedInputTokens:  sumOptionalMetrics(anthropic, func(detail *domain.AnthropicUsageDetails) *int64 { return detail.DirectUncachedInputTokens }),
			CacheCreationInputTokens:   sumOptionalMetrics(anthropic, func(detail *domain.AnthropicUsageDetails) *int64 { return detail.CacheCreationInputTokens }),
			CacheCreation5mInputTokens: sumOptionalMetrics(anthropic, func(detail *domain.AnthropicUsageDetails) *int64 { return detail.CacheCreation5mInputTokens }),
			CacheCreation1hInputTokens: sumOptionalMetrics(anthropic, func(detail *domain.AnthropicUsageDetails) *int64 { return detail.CacheCreation1hInputTokens }),
		}
	}
	return details
}

func sumOptionalMetrics[T any](values []*T, selectMetric func(*T) *int64) *int64 {
	var total int64
	for _, value := range values {
		metric := selectMetric(value)
		if metric == nil {
			return nil
		}
		total += *metric
	}
	return &total
}

func unknownUsageProvenance() domain.UsageMetricProvenanceSet {
	return domain.UsageMetricProvenanceSet{
		InputTokens: domain.UsageMetricUnknown, CachedInputTokens: domain.UsageMetricUnknown,
		UncachedInputTokens: domain.UsageMetricUnknown,
		OutputTokens:        domain.UsageMetricUnknown,
	}
}

func harnessUsageSummaries(models []domain.UsageModelAggregate) []domain.HarnessUsageSummary {
	order := make([]domain.AgentHarness, 0)
	grouped := make(map[domain.AgentHarness][]domain.UsageModelAggregate)
	for _, model := range models {
		if _, ok := grouped[model.Harness]; !ok {
			order = append(order, model.Harness)
		}
		grouped[model.Harness] = append(grouped[model.Harness], model)
	}
	out := make([]domain.HarnessUsageSummary, 0, len(order))
	for _, harness := range order {
		rows := grouped[harness]
		summary := domain.HarnessUsageSummary{Harness: harness, Totals: usageTotals(rows)}
		for _, row := range rows {
			summary.Models = append(summary.Models, domain.ModelUsageSummary{
				ModelID: row.ModelID, Totals: usageTotals([]domain.UsageModelAggregate{row}),
			})
		}
		out = append(out, summary)
	}
	return out
}
