package usage

import (
	"context"
	"fmt"
	"math"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
)

type usageSummaryStore interface {
	GetSession(context.Context, domain.SessionID) (domain.SessionRecord, bool, error)
	ListCompactSessionUsageAggregates(context.Context, domain.ProjectID) ([]domain.CompactSessionUsageAggregate, error)
	ListUsageModelAggregates(context.Context, domain.SessionID) ([]domain.UsageModelAggregate, error)
	GetUsageSessionIncomplete(context.Context, domain.SessionID) (bool, error)
}

// SummaryReader derives token and estimated-cost summaries from normalized
// usage events.
type SummaryReader struct{ store usageSummaryStore }

// NewSummaryReader constructs a usage summary reader.
func NewSummaryReader(store usageSummaryStore) *SummaryReader { return &SummaryReader{store: store} }

// ListCompact returns one batch suitable for dashboard cards.
func (r *SummaryReader) ListCompact(ctx context.Context, projectID domain.ProjectID) ([]domain.CompactSessionUsage, error) {
	if r == nil || r.store == nil {
		return nil, fmt.Errorf("usage summary store is unavailable")
	}
	rows, err := r.store.ListCompactSessionUsageAggregates(ctx, projectID)
	if err != nil {
		return nil, err
	}
	out := make([]domain.CompactSessionUsage, 0, len(rows))
	for _, row := range rows {
		estimatedCost, err := estimatedCost(row.Cost)
		if err != nil {
			return nil, err
		}
		out = append(out, domain.CompactSessionUsage{
			SessionID: row.SessionID, ProcessedTokens: row.ProcessedTokens,
			Incomplete: row.Incomplete, EstimatedCost: estimatedCost,
		})
	}
	return out, nil
}

// Get returns detailed token and estimated-cost telemetry for one session.
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
	totals, err := usageTotals(models)
	if err != nil {
		return domain.SessionUsageSummary{}, err
	}
	harnesses, err := harnessUsageSummaries(models)
	if err != nil {
		return domain.SessionUsageSummary{}, err
	}
	return domain.SessionUsageSummary{
		SessionID: sessionID, Incomplete: incomplete, Totals: totals, Harnesses: harnesses,
	}, nil
}

func usageTotals(models []domain.UsageModelAggregate) (domain.UsageMetricTotals, error) {
	if len(models) == 0 {
		return domain.UsageMetricTotals{Provenance: unknownUsageProvenance()}, nil
	}
	var costs domain.UsageCostAggregate
	for _, model := range models {
		if err := mergeUsageCostAggregate(&costs, model.Cost); err != nil {
			return domain.UsageMetricTotals{}, err
		}
	}
	estimate, err := estimatedCost(costs)
	if err != nil {
		return domain.UsageMetricTotals{}, err
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
		EstimatedCost:   estimate,
	}
	if input != nil && output != nil {
		processed := *input + *output
		totals.ProcessedTokens = &processed
	}
	return totals, nil
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

func harnessUsageSummaries(models []domain.UsageModelAggregate) ([]domain.HarnessUsageSummary, error) {
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
		totals, err := usageTotals(rows)
		if err != nil {
			return nil, err
		}
		summary := domain.HarnessUsageSummary{Harness: harness, Totals: totals}
		for _, row := range rows {
			modelTotals, err := usageTotals([]domain.UsageModelAggregate{row})
			if err != nil {
				return nil, err
			}
			summary.Models = append(summary.Models, domain.ModelUsageSummary{
				BillingProviderID: row.BillingProviderID, ModelID: row.ModelID, Totals: modelTotals,
			})
		}
		out = append(out, summary)
	}
	return out, nil
}

func estimatedCost(raw domain.UsageCostAggregate) (*domain.EstimatedCost, error) {
	if err := validateUsageCostAggregate(raw); err != nil {
		return nil, err
	}
	if raw.EventCount == 0 {
		return nil, nil
	}
	coverage := domain.EstimatedCostCoverageComplete
	total := raw.PricedTotalNanos
	if raw.PricedEventCount != raw.EventCount {
		coverage = domain.EstimatedCostCoveragePartial
		var err error
		for _, component := range []struct {
			name  string
			value int64
		}{
			{"uncached input cost", raw.UnpricedKnownUncachedInputNanos},
			{"cache read cost", raw.UnpricedKnownCacheReadNanos},
			{"cache write cost", raw.UnpricedKnownCacheWriteNanos},
			{"output cost", raw.UnpricedKnownOutputNanos},
		} {
			total, err = checkedUsageAdd(component.name, total, component.value)
			if err != nil {
				return nil, err
			}
		}
		if total == 0 {
			return nil, nil
		}
	}
	return &domain.EstimatedCost{
		TotalNanos:         total,
		UncachedInputNanos: knownComponent(raw.EventCount, raw.KnownUncachedInputCount, raw.KnownUncachedInputNanos),
		CacheReadNanos:     knownComponent(raw.EventCount, raw.KnownCacheReadCount, raw.KnownCacheReadNanos),
		CacheWriteNanos:    knownComponent(raw.EventCount, raw.KnownCacheWriteCount, raw.KnownCacheWriteNanos),
		OutputNanos:        knownComponent(raw.EventCount, raw.KnownOutputCount, raw.KnownOutputNanos),
		Coverage:           coverage,
	}, nil
}

func knownComponent(eventCount, knownCount, value int64) *int64 {
	if eventCount == knownCount {
		return &value
	}
	return nil
}

func mergeUsageCostAggregate(dst *domain.UsageCostAggregate, src domain.UsageCostAggregate) error {
	if err := validateUsageCostAggregate(src); err != nil {
		return err
	}
	fields := []struct {
		name string
		dst  *int64
		src  int64
	}{
		{"cost event count", &dst.EventCount, src.EventCount},
		{"priced event count", &dst.PricedEventCount, src.PricedEventCount},
		{"priced total cost", &dst.PricedTotalNanos, src.PricedTotalNanos},
		{"known uncached input count", &dst.KnownUncachedInputCount, src.KnownUncachedInputCount},
		{"known uncached input cost", &dst.KnownUncachedInputNanos, src.KnownUncachedInputNanos},
		{"unpriced known uncached input cost", &dst.UnpricedKnownUncachedInputNanos, src.UnpricedKnownUncachedInputNanos},
		{"known cache read count", &dst.KnownCacheReadCount, src.KnownCacheReadCount},
		{"known cache read cost", &dst.KnownCacheReadNanos, src.KnownCacheReadNanos},
		{"unpriced known cache read cost", &dst.UnpricedKnownCacheReadNanos, src.UnpricedKnownCacheReadNanos},
		{"known cache write count", &dst.KnownCacheWriteCount, src.KnownCacheWriteCount},
		{"known cache write cost", &dst.KnownCacheWriteNanos, src.KnownCacheWriteNanos},
		{"unpriced known cache write cost", &dst.UnpricedKnownCacheWriteNanos, src.UnpricedKnownCacheWriteNanos},
		{"known output count", &dst.KnownOutputCount, src.KnownOutputCount},
		{"known output cost", &dst.KnownOutputNanos, src.KnownOutputNanos},
		{"unpriced known output cost", &dst.UnpricedKnownOutputNanos, src.UnpricedKnownOutputNanos},
	}
	for _, field := range fields {
		value, err := checkedUsageAdd(field.name, *field.dst, field.src)
		if err != nil {
			return err
		}
		*field.dst = value
	}
	return nil
}

func validateUsageCostAggregate(raw domain.UsageCostAggregate) error {
	values := []struct {
		name  string
		value int64
	}{
		{"event count", raw.EventCount}, {"priced event count", raw.PricedEventCount}, {"priced total cost", raw.PricedTotalNanos},
		{"known uncached input count", raw.KnownUncachedInputCount}, {"known uncached input cost", raw.KnownUncachedInputNanos}, {"unpriced known uncached input cost", raw.UnpricedKnownUncachedInputNanos},
		{"known cache read count", raw.KnownCacheReadCount}, {"known cache read cost", raw.KnownCacheReadNanos}, {"unpriced known cache read cost", raw.UnpricedKnownCacheReadNanos},
		{"known cache write count", raw.KnownCacheWriteCount}, {"known cache write cost", raw.KnownCacheWriteNanos}, {"unpriced known cache write cost", raw.UnpricedKnownCacheWriteNanos},
		{"known output count", raw.KnownOutputCount}, {"known output cost", raw.KnownOutputNanos}, {"unpriced known output cost", raw.UnpricedKnownOutputNanos},
	}
	for _, item := range values {
		if item.value < 0 {
			return fmt.Errorf("usage %s must be nonnegative", item.name)
		}
	}
	if raw.PricedEventCount > raw.EventCount || raw.KnownUncachedInputCount > raw.EventCount ||
		raw.KnownCacheReadCount > raw.EventCount || raw.KnownCacheWriteCount > raw.EventCount || raw.KnownOutputCount > raw.EventCount {
		return fmt.Errorf("usage cost coverage count exceeds event count")
	}
	if raw.UnpricedKnownUncachedInputNanos > raw.KnownUncachedInputNanos || raw.UnpricedKnownCacheReadNanos > raw.KnownCacheReadNanos ||
		raw.UnpricedKnownCacheWriteNanos > raw.KnownCacheWriteNanos || raw.UnpricedKnownOutputNanos > raw.KnownOutputNanos {
		return fmt.Errorf("usage unpriced component cost exceeds known component cost")
	}
	return nil
}

func checkedUsageAdd(label string, left, right int64) (int64, error) {
	if left < 0 || right < 0 {
		return 0, fmt.Errorf("usage %s must be nonnegative", label)
	}
	if left > math.MaxInt64-right {
		return 0, fmt.Errorf("usage %s overflows int64", label)
	}
	return left + right, nil
}
