package usage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/pricing"
	usagesvc "github.com/aoagents/agent-orchestrator/backend/internal/service/usage"
)

type legacyRepairStore interface {
	ListLegacyUsageSources(context.Context) ([]domain.UsageSourceContext, error)
	ListLegacyUsageEvents(context.Context, int64) ([]domain.LegacyUsageEvent, error)
	ApplyLegacyUsageRepairs(context.Context, []domain.LegacyUsageRepair, time.Time) (int, error)
}

// LegacyRepairerConfig controls bounded replay and lifecycle diagnostics.
type LegacyRepairerConfig struct {
	ChunkBytes  int64
	RecordBytes int
	Clock       func() time.Time
	OnError     func(error)
}

// LegacyRepairer performs one startup pass over provider-null historical rows.
type LegacyRepairer struct {
	store   legacyRepairStore
	pricing *pricing.Manager
	config  LegacyRepairerConfig
	started atomic.Bool
	done    chan struct{}
}

// NewLegacyRepairer constructs a one-shot historical attribution repairer.
func NewLegacyRepairer(
	store legacyRepairStore,
	manager *pricing.Manager,
	config LegacyRepairerConfig,
) *LegacyRepairer {
	if config.ChunkBytes <= 0 {
		config.ChunkBytes = defaultChunkBytes
	}
	if config.RecordBytes <= 0 {
		config.RecordBytes = defaultRecordBytes
	}
	if config.Clock == nil {
		config.Clock = time.Now
	}
	if config.OnError == nil {
		config.OnError = func(error) {}
	}
	return &LegacyRepairer{
		store: store, pricing: manager, config: config, done: make(chan struct{}),
	}
}

// Start launches the one-shot repair pass.
func (r *LegacyRepairer) Start(ctx context.Context) error {
	if !r.started.CompareAndSwap(false, true) {
		return errors.New("legacy usage repairer already started")
	}
	if r.store == nil || r.pricing == nil {
		return errors.New("legacy usage repairer requires store and pricing manager")
	}
	go func() {
		defer close(r.done)
		if err := r.Run(ctx); err != nil && ctx.Err() == nil {
			r.config.OnError(err)
		}
	}()
	return nil
}

// Wait joins a started repair pass.
func (r *LegacyRepairer) Wait() {
	if !r.started.Load() {
		return
	}
	<-r.done
}

// Run performs one synchronous repair pass. Individual unverifiable sources
// are intentionally skipped without mutating their lifecycle or cursor.
func (r *LegacyRepairer) Run(ctx context.Context) error {
	if r.store == nil || r.pricing == nil {
		return errors.New("legacy usage repairer requires store and pricing manager")
	}
	sources, err := r.store.ListLegacyUsageSources(ctx)
	if err != nil {
		return err
	}
	for _, source := range sources {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := r.repairSource(ctx, source); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			r.config.OnError(err)
		}
	}
	return nil
}

func (r *LegacyRepairer) repairSource(ctx context.Context, source domain.UsageSourceContext) error {
	if source.Source.State == domain.UsageSourceComplete &&
		source.Source.LastErrorCode == domain.UsageErrorArtifactReplaced {
		return nil
	}
	persisted, err := decodeParserState(source.Source)
	if err != nil || source.Source.ByteOffset <= 0 || persisted.Integrity.Checkpoint == nil {
		return nil
	}
	candidates, err := r.store.ListLegacyUsageEvents(ctx, source.Source.ID)
	if err != nil || len(candidates) == 0 {
		return err
	}
	file, err := os.Open(source.Source.ArtifactPath) //nolint:gosec // registered transcript path.
	if err != nil {
		return nil
	}
	defer func() { _ = file.Close() }()
	if !legacyArtifactMatches(file, source.Source, persisted.Integrity.Checkpoint) {
		return nil
	}

	state, err := newParserState(source.Source.Kind)
	if err != nil {
		return nil
	}
	if state.Codex != nil && persisted.Codex != nil {
		state.Codex.NativeSessionID = persisted.Codex.NativeSessionID
		state.Codex.DirectParentID = persisted.Codex.DirectParentID
	}
	parsedEvents, ok, err := r.reparseDurablePrefix(ctx, file, source, state)
	if err != nil {
		return err
	}
	if !ok || !legacyArtifactMatches(file, source.Source, persisted.Integrity.Checkpoint) {
		return nil
	}

	matches := matchLegacyEvents(candidates, parsedEvents)
	if len(matches) == 0 {
		return nil
	}
	return r.pricing.WithSnapshot(ctx, func(snapshot *pricing.Snapshot) error {
		repairs := make([]domain.LegacyUsageRepair, 0, min(len(matches), 256))
		flush := func() error {
			if len(repairs) == 0 {
				return nil
			}
			_, err := r.store.ApplyLegacyUsageRepairs(ctx, repairs, r.config.Clock().UTC())
			repairs = repairs[:0]
			return err
		}
		for _, match := range matches {
			if err := ctx.Err(); err != nil {
				return err
			}
			event := match.event
			billingProviderID := strings.TrimSpace(event.BillingProviderID)
			if billingProviderID == "" {
				continue
			}
			repair := domain.LegacyUsageRepair{
				Candidate:               match.candidate,
				ExpectedFileIdentity:    source.Source.FileIdentity,
				ExpectedByteOffset:      source.Source.ByteOffset,
				ExpectedParserStateJSON: source.Source.ParserStateJSON,
				ExpectedSourceUpdatedAt: source.Source.UpdatedAt,
				BillingProviderID:       billingProviderID,
				Costs:                   domain.UsageEventCosts{PricingVersion: snapshot.ProviderVersion(billingProviderID)},
			}
			estimate, estimateErr := snapshot.Estimate(event)
			if estimateErr != nil {
				r.config.OnError(estimateErr)
			} else {
				repair.Costs = domain.UsageEventCosts{
					UncachedInputCostNanos: estimate.UncachedInputNanos,
					CacheReadCostNanos:     estimate.CacheReadNanos,
					CacheWriteCostNanos:    estimate.CacheWriteNanos,
					OutputCostNanos:        estimate.OutputNanos,
					EstimatedCostNanos:     estimate.TotalNanos,
					PricingVersion:         estimate.PricingVersion,
				}
			}
			repairs = append(repairs, repair)
			if len(repairs) == 256 {
				if err := flush(); err != nil {
					return err
				}
			}
		}
		return flush()
	})
}

func legacyArtifactMatches(file *os.File, source domain.UsageSourceRecord, checkpoint *parserCheckpointV1) bool {
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() < source.ByteOffset {
		return false
	}
	identity, err := usagesvc.SourceIdentityFromFile(file)
	if err != nil || identity != source.FileIdentity {
		return false
	}
	sample, err := parserCheckpointSampleAt(file, source.ByteOffset)
	return err == nil && parserCheckpointsEqual(sample.checkpoint, checkpoint)
}

func (r *LegacyRepairer) reparseDurablePrefix(
	ctx context.Context,
	file *os.File,
	source domain.UsageSourceContext,
	state *parserStateEnvelope,
) ([]domain.ModelUsageEvent, bool, error) {
	durableOffset := source.Source.ByteOffset
	offset := int64(0)
	discardingOversized := false
	attributionChecked := false
	events := make([]domain.ModelUsageEvent, 0)
	for offset < durableOffset {
		chunk, err := readJSONLChunkFromSnapshot(
			ctx, file, durableOffset, offset,
			r.config.ChunkBytes, r.config.RecordBytes, discardingOversized,
		)
		if err != nil {
			return nil, false, err
		}
		if chunk.readToEOF && len(chunk.trailing) > 0 {
			tail := bytes.TrimSpace(chunk.trailing)
			if len(tail) > 0 && json.Valid(tail) {
				chunk.records = append(chunk.records, jsonlRecord{
					Data: append([]byte(nil), tail...), Offset: chunk.trailingOffset,
				})
			}
			chunk.nextOffset = durableOffset
		}
		if !attributionChecked && len(chunk.records) > 0 {
			origin := source.Source
			origin.ByteOffset = 0
			if !codexChunkAttributionMatches(origin, state.Codex, chunk.records) {
				return nil, false, nil
			}
			attributionChecked = true
		}
		parsed := parseRecordsWithState(source, chunk.records, chunk.nextOffset, r.config.Clock().UTC(), state)
		if parsed.err != nil {
			return nil, false, parsed.err
		}
		events = append(events, parsed.Events...)
		discardingOversized = chunk.discardingOversizedRecord
		if chunk.nextOffset <= offset {
			return nil, false, nil
		}
		offset = chunk.nextOffset
	}
	return events, true, nil
}

type legacyEventMatch struct {
	candidate domain.LegacyUsageEvent
	event     domain.ModelUsageEvent
}

func matchLegacyEvents(candidates []domain.LegacyUsageEvent, parsed []domain.ModelUsageEvent) []legacyEventMatch {
	byKey := make(map[string]domain.ModelUsageEvent, len(parsed))
	duplicates := make(map[string]struct{})
	for _, event := range parsed {
		if _, exists := byKey[event.SourceEventKey]; exists {
			duplicates[event.SourceEventKey] = struct{}{}
		}
		byKey[event.SourceEventKey] = event
	}
	matches := make([]legacyEventMatch, 0, len(candidates))
	for _, candidate := range candidates {
		if _, duplicate := duplicates[candidate.SourceEventKey]; duplicate {
			continue
		}
		event, ok := byKey[candidate.SourceEventKey]
		if !ok || event.ProviderID != candidate.ProviderID || event.ModelID != candidate.ModelID ||
			!genericTokensEqual(event.Tokens, candidate.Tokens) {
			continue
		}
		matches = append(matches, legacyEventMatch{candidate: candidate, event: event})
	}
	return matches
}

func genericTokensEqual(left, right domain.UsageTokenMetrics) bool {
	return optionalInt64Equal(left.InputTokens, right.InputTokens) &&
		optionalInt64Equal(left.CachedInputTokens, right.CachedInputTokens) &&
		optionalInt64Equal(left.UncachedInputTokens, right.UncachedInputTokens) &&
		optionalInt64Equal(left.OutputTokens, right.OutputTokens) &&
		left.Provenance == right.Provenance
}

func optionalInt64Equal(left, right *int64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
