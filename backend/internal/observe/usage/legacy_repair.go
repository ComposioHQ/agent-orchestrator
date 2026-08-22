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
	replayed := newLegacyReplayIndex(candidates)
	ok, err := r.reparseDurablePrefix(ctx, file, source, state, replayed)
	if err != nil {
		return err
	}
	if !ok || !legacyArtifactMatches(file, source.Source, persisted.Integrity.Checkpoint) {
		return nil
	}

	matches := matchLegacyEvents(candidates, replayed)
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
				ProviderUsageJSON:       event.ProviderUsageJSON,
				Costs:                   domain.UsageEventCosts{PricingVersion: snapshot.ProviderVersion(billingProviderID)},
			}
			estimate, estimateErr := snapshot.Estimate(event)
			if estimateErr != nil {
				r.config.OnError(estimateErr)
			} else {
				repair.Costs = domain.UsageEventCosts{
					InputCostNanos:       estimate.InputNanos,
					CachedInputCostNanos: estimate.CachedInputNanos,
					OutputCostNanos:      estimate.OutputNanos,
					EstimatedCostNanos:   estimate.TotalNanos,
					PricingVersion:       estimate.PricingVersion,
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

// legacyReplayIndex keeps only the replayed events a candidate could match.
//
// The chunk reader bounds each read, but a transcript prefix is unbounded, so
// retaining every parsed event would make this one-shot startup repair allocate
// in proportion to the whole file — exactly what the bounded ingestion design
// exists to prevent. Retention is instead proportional to the number of legacy
// rows on the one source being repaired.
type legacyReplayIndex struct {
	wanted     map[string]struct{}
	byKey      map[string]domain.ModelUsageEvent
	duplicates map[string]struct{}
}

func newLegacyReplayIndex(candidates []domain.LegacyUsageEvent) *legacyReplayIndex {
	index := &legacyReplayIndex{
		wanted:     make(map[string]struct{}, len(candidates)),
		byKey:      make(map[string]domain.ModelUsageEvent, len(candidates)),
		duplicates: make(map[string]struct{}),
	}
	for _, candidate := range candidates {
		index.wanted[candidate.SourceEventKey] = struct{}{}
	}
	return index
}

// observe records one chunk's events. A key repeated across the prefix is
// ambiguous and disqualifies its candidate, so both sightings are tracked even
// though only the last event is kept.
func (i *legacyReplayIndex) observe(events []domain.ModelUsageEvent) {
	for _, event := range events {
		if _, want := i.wanted[event.SourceEventKey]; !want {
			continue
		}
		if _, seen := i.byKey[event.SourceEventKey]; seen {
			i.duplicates[event.SourceEventKey] = struct{}{}
		}
		i.byKey[event.SourceEventKey] = event
	}
}

func (r *LegacyRepairer) reparseDurablePrefix(
	ctx context.Context,
	file *os.File,
	source domain.UsageSourceContext,
	state *parserStateEnvelope,
	replayed *legacyReplayIndex,
) (bool, error) {
	durableOffset := source.Source.ByteOffset
	offset := int64(0)
	discardingOversized := false
	attributionChecked := false
	for offset < durableOffset {
		chunk, err := readJSONLChunkFromSnapshot(
			ctx, file, durableOffset, offset,
			r.config.ChunkBytes, r.config.RecordBytes, discardingOversized,
		)
		if err != nil {
			return false, err
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
				return false, nil
			}
			attributionChecked = true
		}
		parsed := parseRecordsWithState(source, chunk.records, chunk.nextOffset, r.config.Clock().UTC(), state)
		if parsed.err != nil {
			return false, parsed.err
		}
		replayed.observe(parsed.Events)
		discardingOversized = chunk.discardingOversizedRecord
		if chunk.nextOffset <= offset {
			return false, nil
		}
		offset = chunk.nextOffset
	}
	return true, nil
}

type legacyEventMatch struct {
	candidate domain.LegacyUsageEvent
	event     domain.ModelUsageEvent
}

func matchLegacyEvents(candidates []domain.LegacyUsageEvent, replayed *legacyReplayIndex) []legacyEventMatch {
	matches := make([]legacyEventMatch, 0, len(candidates))
	for _, candidate := range candidates {
		if _, duplicate := replayed.duplicates[candidate.SourceEventKey]; duplicate {
			continue
		}
		event, ok := replayed.byKey[candidate.SourceEventKey]
		// The stored provider usage object is deliberately not compared: filling
		// it in is what this repair exists to do, so a stored NULL must still match.
		if !ok || event.ProviderID != candidate.ProviderID || event.ModelID != candidate.ModelID ||
			event.MeasurementKind != candidate.MeasurementKind ||
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
		optionalInt64Equal(left.OutputTokens, right.OutputTokens)
}

func optionalInt64Equal(left, right *int64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
