package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

// UpsertUsageBinding records or refreshes the association between an AO
// session and a native root session/thread.
func (s *Store) UpsertUsageBinding(ctx context.Context, rec domain.UsageBindingRecord) (domain.UsageBindingRecord, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	row, err := s.qw.UpsertUsageBinding(ctx, gen.UpsertUsageBindingParams{
		SessionID:      rec.SessionID,
		Harness:        rec.Harness,
		NativeRootID:   rec.NativeRootID,
		InitialModelID: strings.TrimSpace(rec.InitialModelID),
		ProviderHint:   strings.TrimSpace(rec.ProviderHint),
		State:          usageBindingStateOrDefault(rec.State),
		LastErrorCode:  rec.LastErrorCode,
		UpdatedAt:      timeOrNow(rec.UpdatedAt),
	})
	if err != nil {
		return domain.UsageBindingRecord{}, fmt.Errorf("upsert usage binding for session %s root %q: %w", rec.SessionID, rec.NativeRootID, err)
	}
	return usageBindingFromGen(row), nil
}

// GetUsageBinding returns one binding, or ok=false when absent.
func (s *Store) GetUsageBinding(ctx context.Context, sessionID domain.SessionID, harness domain.AgentHarness, nativeRootID string) (domain.UsageBindingRecord, bool, error) {
	row, err := s.qr.GetUsageBindingBySessionHarnessRoot(ctx, gen.GetUsageBindingBySessionHarnessRootParams{
		SessionID:    sessionID,
		Harness:      harness,
		NativeRootID: nativeRootID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return domain.UsageBindingRecord{}, false, nil
	}
	if err != nil {
		return domain.UsageBindingRecord{}, false, fmt.Errorf("get usage binding for session %s root %q: %w", sessionID, nativeRootID, err)
	}
	return usageBindingFromGen(row), true, nil
}

// ListUsageBindingsForSession returns every native usage binding for a session.
func (s *Store) ListUsageBindingsForSession(ctx context.Context, sessionID domain.SessionID) ([]domain.UsageBindingRecord, error) {
	rows, err := s.qr.ListUsageBindingsForSession(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("list usage bindings for session %s: %w", sessionID, err)
	}
	out := make([]domain.UsageBindingRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, usageBindingFromGen(row))
	}
	return out, nil
}

// FinalizeUsageBindingsForSessionLaunch atomically moves a live session's
// bindings into finalization only while its durable runtime generation and
// session revision match the lifecycle observation.
func (s *Store) FinalizeUsageBindingsForSessionLaunch(
	ctx context.Context,
	sessionID domain.SessionID,
	expectedRuntimeLaunchID string,
	expectedSessionUpdatedAt time.Time,
	at time.Time,
) ([]domain.UsageBindingRecord, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	rows, err := s.qw.FinalizeUsageBindingsForSessionLaunch(ctx, gen.FinalizeUsageBindingsForSessionLaunchParams{
		SessionID:                sessionID,
		ExpectedRuntimeLaunchID:  expectedRuntimeLaunchID,
		ExpectedSessionUpdatedAt: expectedSessionUpdatedAt,
		FinalizedAt:              timeOrNow(at),
	})
	if err != nil {
		return nil, fmt.Errorf("finalize usage bindings for session %s launch %q: %w", sessionID, expectedRuntimeLaunchID, err)
	}
	out := make([]domain.UsageBindingRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, usageBindingFromGen(row))
	}
	return out, nil
}

// UpdateUsageBindingState updates only the binding lifecycle/error state.
func (s *Store) UpdateUsageBindingState(ctx context.Context, id int64, state domain.UsageBindingState, lastErrorCode string, at time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := s.qw.UpdateUsageBinding(ctx, gen.UpdateUsageBindingParams{
		ID:            id,
		State:         usageBindingStateOrDefault(state),
		LastErrorCode: lastErrorCode,
		UpdatedAt:     timeOrNow(at),
	})
	if err != nil {
		return false, fmt.Errorf("update usage binding %d: %w", id, err)
	}
	return n > 0, nil
}

// UpdateUsageBindingErrorCode refreshes binding diagnostics without changing
// lifecycle state chosen by a concurrent finalization or ingestion pass.
func (s *Store) UpdateUsageBindingErrorCode(ctx context.Context, id int64, lastErrorCode string, at time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := s.qw.UpdateUsageBinding(ctx, gen.UpdateUsageBindingParams{
		ID:            id,
		State:         "",
		LastErrorCode: lastErrorCode,
		UpdatedAt:     timeOrNow(at),
	})
	if err != nil {
		return false, fmt.Errorf("update usage binding %d error code: %w", id, err)
	}
	return n > 0, nil
}

// CompleteUsageBindingIfSettled atomically completes a finalizing binding only
// when every registered source generation is complete.
func (s *Store) CompleteUsageBindingIfSettled(ctx context.Context, bindingID int64, at time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := s.qw.CompleteUsageBindingIfSettled(ctx, gen.CompleteUsageBindingIfSettledParams{
		UsageBindingID: bindingID,
		UpdatedAt:      timeOrNow(at),
	})
	if err != nil {
		return false, fmt.Errorf("complete settled usage binding %d: %w", bindingID, err)
	}
	return n > 0, nil
}

// InsertUsageSource records a physical JSONL source generation. Repeated calls
// for the same binding/path/generation return the existing row.
func (s *Store) InsertUsageSource(ctx context.Context, rec domain.UsageSourceRecord) (domain.UsageSourceRecord, error) {
	if err := validateParserStateObject(rec.ParserStateJSON); err != nil {
		return domain.UsageSourceRecord{}, err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	row, err := s.qw.InsertUsageSource(ctx, usageSourceInsertParams(rec))
	if err != nil {
		return domain.UsageSourceRecord{}, fmt.Errorf("insert usage source for binding %d generation %d: %w", rec.BindingID, rec.Generation, err)
	}
	return usageSourceFromGen(row), nil
}

// ReplaceUsageSource atomically retires one source generation and inserts its
// replacement so startup or watcher reconciliation can never observe a gap.
func (s *Store) ReplaceUsageSource(
	ctx context.Context,
	oldSourceID int64,
	oldErrorCode string,
	rec domain.UsageSourceRecord,
	at time.Time,
) (domain.UsageSourceRecord, error) {
	if err := validateParserStateObject(rec.ParserStateJSON); err != nil {
		return domain.UsageSourceRecord{}, err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	var replaced domain.UsageSourceRecord
	err := s.inTx(ctx, "replace usage source", func(q *gen.Queries) error {
		n, err := q.UpdateUsageSourceLifecycle(ctx, gen.UpdateUsageSourceLifecycleParams{
			ID:            oldSourceID,
			State:         domain.UsageSourceComplete,
			FailureCount:  sql.NullInt64{},
			LastErrorCode: oldErrorCode,
			NextRetryAt:   sql.NullTime{},
			UpdatedAt:     timeOrNow(at),
		})
		if err != nil {
			return err
		}
		if n == 0 {
			return fmt.Errorf("usage source %d not found", oldSourceID)
		}
		row, err := q.InsertUsageSource(ctx, usageSourceInsertParams(rec))
		if err != nil {
			return err
		}
		replaced = usageSourceFromGen(row)
		return nil
	})
	if err != nil {
		return domain.UsageSourceRecord{}, fmt.Errorf("replace usage source %d: %w", oldSourceID, err)
	}
	return replaced, nil
}

// ListUsageSourcesForBinding returns all source generations for one native
// session binding.
func (s *Store) ListUsageSourcesForBinding(ctx context.Context, bindingID int64) ([]domain.UsageSourceRecord, error) {
	rows, err := s.qr.ListUsageSourcesForBinding(ctx, bindingID)
	if err != nil {
		return nil, fmt.Errorf("list usage sources for binding %d: %w", bindingID, err)
	}
	out := make([]domain.UsageSourceRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, usageSourceFromGen(row))
	}
	return out, nil
}

// ListWatchableUsageSources returns the latest source generation for every
// provider artifact attached to a resumable session. Watch registrations are
// rebuilt from this durable inventory after daemon and watcher restarts.
func (s *Store) ListWatchableUsageSources(ctx context.Context) ([]domain.UsageSourceRecord, error) {
	rows, err := s.qr.ListWatchableUsageSources(ctx)
	if err != nil {
		return nil, fmt.Errorf("list watchable usage sources: %w", err)
	}
	out := make([]domain.UsageSourceRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, usageSourceFromGen(row))
	}
	return out, nil
}

// HasPendingUsageDiscovery reports whether a live binding has a durable reason
// to retry source discovery. It excludes healthy active bindings, so retries do
// not degrade into global transcript polling.
func (s *Store) HasPendingUsageDiscovery(ctx context.Context) (bool, error) {
	pending, err := s.qr.HasPendingUsageDiscovery(ctx)
	if err != nil {
		return false, fmt.Errorf("check pending usage discovery: %w", err)
	}
	return pending != 0, nil
}

// ListLatestRetiredCodexReplacementClaimsByPath returns durable replacement
// claims for one exact provider artifact path on resumable bindings.
func (s *Store) ListLatestRetiredCodexReplacementClaimsByPath(
	ctx context.Context,
	artifactPath string,
) ([]domain.UsageSourceRecord, error) {
	rows, err := s.qr.ListLatestRetiredCodexReplacementClaimsByPath(ctx, artifactPath)
	if err != nil {
		return nil, fmt.Errorf("list retired Codex replacement claims: %w", err)
	}
	out := make([]domain.UsageSourceRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, usageSourceFromGen(row))
	}
	return out, nil
}

// ListUsageDiscoveryBindings returns live-session bindings that may need a
// main source, a relocated source, or newly-created subagent sources.
func (s *Store) ListUsageDiscoveryBindings(ctx context.Context, limit int64) ([]domain.UsageBindingRecord, error) {
	rows, err := s.qr.ListUsageDiscoveryBindings(ctx, limit)
	if err != nil {
		return nil, fmt.Errorf("list usage discovery bindings: %w", err)
	}
	out := make([]domain.UsageBindingRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, usageBindingFromGen(row))
	}
	return out, nil
}

// ListUsageBindingsForCodexParent returns live bindings whose latest source
// matches one exact Codex parent native session. The collector validates the
// child edge from that source's parser state before registration.
func (s *Store) ListUsageBindingsForCodexParent(ctx context.Context, parentNativeSessionID string) ([]domain.UsageBindingRecord, error) {
	rows, err := s.qr.ListUsageBindingsForCodexParent(ctx, parentNativeSessionID)
	if err != nil {
		return nil, fmt.Errorf("list usage bindings for Codex parent: %w", err)
	}
	out := make([]domain.UsageBindingRecord, 0, len(rows))
	for _, row := range rows {
		out = append(out, usageBindingFromGen(row))
	}
	return out, nil
}

// GetUsageSourceForIngestion returns a source plus immutable binding/session
// facts needed by the ingestor.
func (s *Store) GetUsageSourceForIngestion(ctx context.Context, id int64) (domain.UsageSourceContext, bool, error) {
	row, err := s.qr.GetUsageSourceWithBindingAndSession(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.UsageSourceContext{}, false, nil
	}
	if err != nil {
		return domain.UsageSourceContext{}, false, fmt.Errorf("get usage source %d: %w", id, err)
	}
	return usageSourceContextFromGen(row), true, nil
}

// MarkUsageSourceState updates only the source lifecycle/error state.
func (s *Store) MarkUsageSourceState(ctx context.Context, id int64, state domain.UsageSourceState, lastErrorCode string, nextRetryAt *time.Time, updatedAt time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := s.qw.UpdateUsageSourceLifecycle(ctx, gen.UpdateUsageSourceLifecycleParams{
		ID:            id,
		State:         usageSourceStateOrDefault(state),
		FailureCount:  sql.NullInt64{},
		LastErrorCode: lastErrorCode,
		NextRetryAt:   ptrTimeToNullTime(nextRetryAt),
		UpdatedAt:     timeOrNow(updatedAt),
	})
	if err != nil {
		return false, fmt.Errorf("mark usage source %d: %w", id, err)
	}
	return n > 0, nil
}

// ReactivateUsageSource makes a completed or failed source eligible for
// immediate resumed-session ingestion and clears transient retry state.
func (s *Store) ReactivateUsageSource(ctx context.Context, id int64, updatedAt time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := s.qw.UpdateUsageSourceLifecycle(ctx, gen.UpdateUsageSourceLifecycleParams{
		ID:            id,
		State:         domain.UsageSourceActive,
		FailureCount:  sql.NullInt64{Int64: 0, Valid: true},
		LastErrorCode: "",
		NextRetryAt:   sql.NullTime{},
		UpdatedAt:     timeOrNow(updatedAt),
	})
	if err != nil {
		return false, fmt.Errorf("reactivate usage source %d: %w", id, err)
	}
	return n > 0, nil
}

// MarkUsageSourceFailure records a failed ingestion attempt and its bounded
// retry schedule.
func (s *Store) MarkUsageSourceFailure(ctx context.Context, id, failureCount int64, lastErrorCode string, nextRetryAt, updatedAt time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := s.qw.UpdateUsageSourceLifecycle(ctx, gen.UpdateUsageSourceLifecycleParams{
		ID:            id,
		State:         domain.UsageSourceError,
		FailureCount:  sql.NullInt64{Int64: failureCount, Valid: true},
		LastErrorCode: lastErrorCode,
		NextRetryAt:   sql.NullTime{Time: nextRetryAt.UTC(), Valid: true},
		UpdatedAt:     timeOrNow(updatedAt),
	})
	if err != nil {
		return false, fmt.Errorf("mark usage source %d failure: %w", id, err)
	}
	return n > 0, nil
}

// ApplyUsageChunk atomically writes parsed usage events and advances the source
// cursor/baselines. The cursor never moves unless all event writes commit.
func (s *Store) ApplyUsageChunk(
	ctx context.Context,
	sourceID, expectedOffset int64,
	expectedRevision time.Time,
	nextState domain.SourceCursorState,
	events []domain.ModelUsageEvent,
) error {
	if nextState.ParserStateJSON != "" {
		if err := validateParserStateObject(nextState.ParserStateJSON); err != nil {
			return err
		}
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	err := s.inTx(ctx, "apply usage chunk", func(q *gen.Queries) error {
		source, err := q.GetUsageSourceWithBindingAndSession(ctx, sourceID)
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("usage source %d not found", sourceID)
		}
		if err != nil {
			return err
		}
		if source.ByteOffset != expectedOffset {
			return fmt.Errorf("%w: source %d has offset %d, expected %d", domain.ErrUsageSourceOffsetConflict, sourceID, source.ByteOffset, expectedOffset)
		}
		if !source.SourceUpdatedAt.Equal(expectedRevision) ||
			(source.SourceState == domain.UsageSourceComplete && source.SourceLastErrorCode == domain.UsageErrorArtifactReplaced) {
			return fmt.Errorf("%w: source %d changed while its chunk was being read", domain.ErrUsageSourceRevisionConflict, sourceID)
		}
		insertedEvent := false
		for _, ev := range events {
			ev.ProviderID = strings.TrimSpace(ev.ProviderID)
			ev.ModelID = strings.TrimSpace(ev.ModelID)
			if ev.ProviderID == "" {
				return errors.New("usage event provider must be nonempty")
			}
			existing, err := q.GetModelUsageEventByKey(ctx, gen.GetModelUsageEventByKeyParams{
				BindingID:      source.BindingID,
				SourceEventKey: ev.SourceEventKey,
			})
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if err == nil {
				if !usageEventMatches(existing, ev) {
					return fmt.Errorf("%w: binding %d event %q", domain.ErrUsageSourceEventConflict, source.BindingID, ev.SourceEventKey)
				}
				continue
			}
			if err := q.InsertModelUsageEvent(ctx, usageEventInsertParams(source, ev)); err != nil {
				return err
			}
			insertedEvent = true
		}
		if err := q.UpdateUsageSourceCursor(ctx, gen.UpdateUsageSourceCursorParams{
			ID:              sourceID,
			ByteOffset:      nextState.ByteOffset,
			ParserStateJson: stringOrDefault(nextState.ParserStateJSON, source.ParserStateJson),
			State:           usageSourceStateOrDefault(nextState.State),
			FailureCount:    nextState.FailureCount,
			AnomalyCount:    nextState.AnomalyCount,
			NextRetryAt:     ptrTimeToNullTime(nextState.NextRetryAt),
			LastErrorCode:   nextState.LastErrorCode,
			UpdatedAt:       timeOrNow(nextState.UpdatedAt),
		}); err != nil {
			return err
		}
		if insertedEvent {
			return q.TouchUsageBinding(ctx, gen.TouchUsageBindingParams{
				UpdatedAt: timeOrNow(nextState.UpdatedAt),
				ID:        source.BindingID,
			})
		}
		return nil
	})
	if err != nil {
		return err
	}
	return nil
}

// ListUsageCostCandidates returns the next stable bounded page of total-null
// events whose exact canonical provider has not been attempted at version.
func (s *Store) ListUsageCostCandidates(
	ctx context.Context,
	providerID, version string,
	afterID int64,
) ([]domain.UsageCostCandidate, error) {
	rows, err := s.qr.ListUsageCostCandidates(ctx, gen.ListUsageCostCandidatesParams{
		ProviderID:     sql.NullString{String: providerID, Valid: true},
		PricingVersion: version,
		AfterID:        afterID,
	})
	if err != nil {
		return nil, fmt.Errorf("list %s usage cost candidates: %w", providerID, err)
	}
	out := make([]domain.UsageCostCandidate, 0, len(rows))
	for _, row := range rows {
		out = append(out, domain.UsageCostCandidate{
			ID:         row.ID,
			BindingID:  row.BindingID,
			ProviderID: row.ProviderID.String,
			ModelID:    row.ModelID,
			Tokens: domain.UsageTokenMetrics{
				InputTokens:         row.InputTokens,
				UncachedInputTokens: row.UncachedInputTokens,
				CacheReadTokens:     row.CacheReadTokens,
				CacheWriteTokens:    row.CacheWriteTokens,
				OutputTokens:        row.OutputTokens,
				ReasoningTokens:     nullInt64Ptr(row.ReasoningTokens),
			},
			CacheWrite5mTokens: nullInt64Ptr(row.CacheWrite5mTokens),
			CacheWrite1hTokens: nullInt64Ptr(row.CacheWrite1hTokens),
			PricingVersion:     row.PricingVersion,
			SourceEventKey:     row.SourceEventKey,
		})
	}
	return out, nil
}

// ApplyUsageCostUpdates applies one bounded candidate page atomically. Stale
// candidates are ignored, and every binding with at least one winning CAS is
// touched exactly once so the existing trigger publishes one CDC invalidation.
func (s *Store) ApplyUsageCostUpdates(
	ctx context.Context,
	updates []domain.UsageCostUpdate,
	at time.Time,
) (int, error) {
	if len(updates) == 0 {
		return 0, nil
	}
	if len(updates) > 256 {
		return 0, fmt.Errorf("usage cost update batch has %d rows, maximum is 256", len(updates))
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return 0, err
	}
	defer s.writeMu.Unlock()
	applied := 0
	err := s.inTx(ctx, "apply usage cost updates", func(q *gen.Queries) error {
		affectedBindings := make(map[int64]struct{})
		for _, update := range updates {
			candidate := update.Candidate
			bindingID, err := q.UpdateUsageCostCandidate(ctx, gen.UpdateUsageCostCandidateParams{
				UncachedInputCostNanos:      ptrInt64ToNull(update.UncachedInputCostNanos),
				CacheReadCostNanos:          ptrInt64ToNull(update.CacheReadCostNanos),
				CacheWriteCostNanos:         ptrInt64ToNull(update.CacheWriteCostNanos),
				OutputCostNanos:             ptrInt64ToNull(update.OutputCostNanos),
				EstimatedCostNanos:          ptrInt64ToNull(update.EstimatedCostNanos),
				AttemptedPricingVersion:     update.PricingVersion,
				ID:                          candidate.ID,
				BindingID:                   candidate.BindingID,
				ExpectedProviderID:          sql.NullString{String: candidate.ProviderID, Valid: true},
				ExpectedModelID:             candidate.ModelID,
				ExpectedInputTokens:         candidate.Tokens.InputTokens,
				ExpectedUncachedInputTokens: candidate.Tokens.UncachedInputTokens,
				ExpectedCacheReadTokens:     candidate.Tokens.CacheReadTokens,
				ExpectedCacheWriteTokens:    candidate.Tokens.CacheWriteTokens,
				ExpectedOutputTokens:        candidate.Tokens.OutputTokens,
				ExpectedReasoningTokens:     ptrInt64ToNull(candidate.Tokens.ReasoningTokens),
				ExpectedCacheWrite5mTokens:  ptrInt64ToNull(candidate.CacheWrite5mTokens),
				ExpectedCacheWrite1hTokens:  ptrInt64ToNull(candidate.CacheWrite1hTokens),
				ExpectedSourceEventKey:      candidate.SourceEventKey,
				ExpectedPricingVersion:      candidate.PricingVersion,
			})
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			if err != nil {
				return err
			}
			applied++
			affectedBindings[bindingID] = struct{}{}
		}
		bindingIDs := make([]int64, 0, len(affectedBindings))
		for bindingID := range affectedBindings {
			bindingIDs = append(bindingIDs, bindingID)
		}
		sort.Slice(bindingIDs, func(left, right int) bool { return bindingIDs[left] < bindingIDs[right] })
		for _, bindingID := range bindingIDs {
			if err := q.TouchUsageBinding(ctx, gen.TouchUsageBindingParams{
				UpdatedAt: timeOrNow(at),
				ID:        bindingID,
			}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return applied, nil
}

// ListLegacyUsageSources returns source contexts that still own provider-null,
// total-null events. The repairer validates each durable artifact before use.
func (s *Store) ListLegacyUsageSources(ctx context.Context) ([]domain.UsageSourceContext, error) {
	ids, err := s.qr.ListLegacyUsageSourceIDs(ctx)
	if err != nil {
		return nil, fmt.Errorf("list legacy usage sources: %w", err)
	}
	out := make([]domain.UsageSourceContext, 0, len(ids))
	for _, id := range ids {
		row, err := s.qr.GetUsageSourceWithBindingAndSession(ctx, id)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("get legacy usage source %d: %w", id, err)
		}
		out = append(out, usageSourceContextFromGen(row))
	}
	return out, nil
}

// ListLegacyUsageEvents returns the immutable generic facts that transcript
// attribution must match before provider and split repair is eligible.
func (s *Store) ListLegacyUsageEvents(ctx context.Context, sourceID int64) ([]domain.LegacyUsageEvent, error) {
	rows, err := s.qr.ListLegacyUsageEvents(ctx, sourceID)
	if err != nil {
		return nil, fmt.Errorf("list legacy usage events for source %d: %w", sourceID, err)
	}
	out := make([]domain.LegacyUsageEvent, 0, len(rows))
	for _, row := range rows {
		out = append(out, domain.LegacyUsageEvent{
			ID:            row.ID,
			BindingID:     row.BindingID,
			UsageSourceID: row.UsageSourceID,
			ModelID:       row.ModelID,
			Tokens: domain.UsageTokenMetrics{
				InputTokens:         row.InputTokens,
				UncachedInputTokens: row.UncachedInputTokens,
				CacheReadTokens:     row.CacheReadTokens,
				CacheWriteTokens:    row.CacheWriteTokens,
				OutputTokens:        row.OutputTokens,
				ReasoningTokens:     nullInt64Ptr(row.ReasoningTokens),
			},
			PricingVersion: row.PricingVersion,
			SourceEventKey: row.SourceEventKey,
		})
	}
	return out, nil
}

// ApplyLegacyUsageRepairs atomically CAS-updates one bounded replay result and
// touches each winning binding once. It never writes usage source cursor state.
func (s *Store) ApplyLegacyUsageRepairs(
	ctx context.Context,
	repairs []domain.LegacyUsageRepair,
	at time.Time,
) (int, error) {
	if len(repairs) == 0 {
		return 0, nil
	}
	if len(repairs) > 256 {
		return 0, fmt.Errorf("legacy usage repair batch has %d rows, maximum is 256", len(repairs))
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return 0, err
	}
	defer s.writeMu.Unlock()
	applied := 0
	err := s.inTx(ctx, "apply legacy usage repairs", func(q *gen.Queries) error {
		affectedBindings := make(map[int64]struct{})
		for _, repair := range repairs {
			providerID := strings.TrimSpace(repair.ProviderID)
			if providerID == "" {
				return errors.New("legacy usage repair provider must be nonempty")
			}
			candidate := repair.Candidate
			bindingID, err := q.UpdateLegacyUsageEvent(ctx, gen.UpdateLegacyUsageEventParams{
				ProviderID:                  sql.NullString{String: providerID, Valid: true},
				CacheWrite5mTokens:          ptrInt64ToNull(repair.CacheWrite5mTokens),
				CacheWrite1hTokens:          ptrInt64ToNull(repair.CacheWrite1hTokens),
				UncachedInputCostNanos:      ptrInt64ToNull(repair.UncachedInputCostNanos),
				CacheReadCostNanos:          ptrInt64ToNull(repair.CacheReadCostNanos),
				CacheWriteCostNanos:         ptrInt64ToNull(repair.CacheWriteCostNanos),
				OutputCostNanos:             ptrInt64ToNull(repair.OutputCostNanos),
				EstimatedCostNanos:          ptrInt64ToNull(repair.EstimatedCostNanos),
				PricingVersion:              repair.PricingVersion,
				ID:                          candidate.ID,
				BindingID:                   candidate.BindingID,
				UsageSourceID:               candidate.UsageSourceID,
				ExpectedModelID:             candidate.ModelID,
				ExpectedInputTokens:         candidate.Tokens.InputTokens,
				ExpectedUncachedInputTokens: candidate.Tokens.UncachedInputTokens,
				ExpectedCacheReadTokens:     candidate.Tokens.CacheReadTokens,
				ExpectedCacheWriteTokens:    candidate.Tokens.CacheWriteTokens,
				ExpectedOutputTokens:        candidate.Tokens.OutputTokens,
				ExpectedReasoningTokens:     ptrInt64ToNull(candidate.Tokens.ReasoningTokens),
				ExpectedSourceEventKey:      candidate.SourceEventKey,
				ExpectedPricingVersion:      candidate.PricingVersion,
				ExpectedFileIdentity:        repair.ExpectedFileIdentity,
				ExpectedByteOffset:          repair.ExpectedByteOffset,
				ExpectedParserStateJson:     repair.ExpectedParserStateJSON,
				ExpectedSourceUpdatedAt:     repair.ExpectedSourceUpdatedAt,
			})
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			if err != nil {
				return err
			}
			applied++
			affectedBindings[bindingID] = struct{}{}
		}
		bindingIDs := make([]int64, 0, len(affectedBindings))
		for bindingID := range affectedBindings {
			bindingIDs = append(bindingIDs, bindingID)
		}
		sort.Slice(bindingIDs, func(left, right int) bool { return bindingIDs[left] < bindingIDs[right] })
		for _, bindingID := range bindingIDs {
			if err := q.TouchUsageBinding(ctx, gen.TouchUsageBindingParams{
				UpdatedAt: timeOrNow(at), ID: bindingID,
			}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return applied, nil
}

// ListUsageModelAggregates returns model-level aggregate rows for a session.
func (s *Store) ListUsageModelAggregates(ctx context.Context, sessionID domain.SessionID) ([]domain.UsageModelAggregate, error) {
	rows, err := s.qr.AggregateUsageBySessionHarnessModel(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("aggregate usage for session %s: %w", sessionID, err)
	}
	out := make([]domain.UsageModelAggregate, 0, len(rows))
	for _, row := range rows {
		out = append(out, usageAggregateFromGen(row))
	}
	return out, nil
}

// GetUsageSessionIncomplete reports whether durable collection facts indicate missing usage.
func (s *Store) GetUsageSessionIncomplete(ctx context.Context, sessionID domain.SessionID) (bool, error) {
	incomplete, err := s.qr.GetUsageSessionIncomplete(ctx, string(sessionID))
	if err != nil {
		return false, fmt.Errorf("get usage integrity for session %s: %w", sessionID, err)
	}
	return incomplete != 0, nil
}

// ListCompactSessionUsageAggregates returns sessions with observed usage in
// one grouped read. projectID optionally limits the rows to one dashboard board.
func (s *Store) ListCompactSessionUsageAggregates(ctx context.Context, projectID domain.ProjectID) ([]domain.CompactSessionUsageAggregate, error) {
	rows, err := s.qr.ListCompactSessionUsage(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("list compact session usage for project %s: %w", projectID, err)
	}
	out := make([]domain.CompactSessionUsageAggregate, 0, len(rows))
	for _, row := range rows {
		out = append(out, domain.CompactSessionUsageAggregate{
			SessionID: row.SessionID, InputTokens: row.InputTokens, OutputTokens: row.OutputTokens,
			Incomplete: row.Incomplete != 0,
			Cost: domain.UsageCostAggregate{
				EventCount: row.EventCount, PricedEventCount: row.PricedEventCount, PricedTotalNanos: row.PricedTotalNanos,
				KnownUncachedInputCount: row.KnownUncachedInputCount, KnownUncachedInputNanos: row.KnownUncachedInputNanos,
				UnpricedKnownUncachedInputNanos: row.UnpricedKnownUncachedInputNanos,
				KnownCacheReadCount:             row.KnownCacheReadCount, KnownCacheReadNanos: row.KnownCacheReadNanos,
				UnpricedKnownCacheReadNanos: row.UnpricedKnownCacheReadNanos,
				KnownCacheWriteCount:        row.KnownCacheWriteCount, KnownCacheWriteNanos: row.KnownCacheWriteNanos,
				UnpricedKnownCacheWriteNanos: row.UnpricedKnownCacheWriteNanos,
				KnownOutputCount:             row.KnownOutputCount, KnownOutputNanos: row.KnownOutputNanos,
				UnpricedKnownOutputNanos: row.UnpricedKnownOutputNanos,
			},
		})
	}
	return out, nil
}

func usageBindingFromGen(row gen.UsageBinding) domain.UsageBindingRecord {
	return domain.UsageBindingRecord{
		ID:             row.ID,
		SessionID:      row.SessionID,
		Harness:        row.Harness,
		NativeRootID:   row.NativeRootID,
		InitialModelID: row.InitialModelID,
		ProviderHint:   row.ProviderHint,
		State:          row.State,
		LastErrorCode:  row.LastErrorCode,
		UpdatedAt:      row.UpdatedAt,
	}
}

func usageSourceFromGen(row gen.UsageSource) domain.UsageSourceRecord {
	return domain.UsageSourceRecord{
		ID:              row.ID,
		BindingID:       row.BindingID,
		Kind:            row.Kind,
		NativeSessionID: row.NativeSessionID,
		SubagentID:      row.SubagentID,
		ArtifactPath:    row.ArtifactPath,
		FileIdentity:    row.FileIdentity,
		Generation:      row.Generation,
		ByteOffset:      row.ByteOffset,
		ParserStateJSON: row.ParserStateJson,
		State:           row.State,
		FailureCount:    row.FailureCount,
		AnomalyCount:    row.AnomalyCount,
		NextRetryAt:     nullTimePtr(row.NextRetryAt),
		LastErrorCode:   row.LastErrorCode,
		UpdatedAt:       row.UpdatedAt,
	}
}

func usageSourceContextFromGen(row gen.GetUsageSourceWithBindingAndSessionRow) domain.UsageSourceContext {
	return domain.UsageSourceContext{
		Source: domain.UsageSourceRecord{
			ID:              row.SourceID,
			BindingID:       row.BindingID,
			Kind:            row.Kind,
			NativeSessionID: row.NativeSessionID,
			SubagentID:      row.SubagentID,
			ArtifactPath:    row.ArtifactPath,
			FileIdentity:    row.FileIdentity,
			Generation:      row.Generation,
			ByteOffset:      row.ByteOffset,
			ParserStateJSON: row.ParserStateJson,
			State:           row.SourceState,
			FailureCount:    row.FailureCount,
			AnomalyCount:    row.AnomalyCount,
			NextRetryAt:     nullTimePtr(row.NextRetryAt),
			LastErrorCode:   row.SourceLastErrorCode,
			UpdatedAt:       row.SourceUpdatedAt,
		},
		SessionID:      row.SessionID,
		NativeRootID:   row.NativeRootID,
		InitialModelID: row.InitialModelID,
		ProviderHint:   row.ProviderHint,
		BindingState:   row.BindingState,
	}
}

func usageSourceInsertParams(rec domain.UsageSourceRecord) gen.InsertUsageSourceParams {
	return gen.InsertUsageSourceParams{
		BindingID:       rec.BindingID,
		Kind:            rec.Kind,
		NativeSessionID: rec.NativeSessionID,
		SubagentID:      rec.SubagentID,
		ArtifactPath:    rec.ArtifactPath,
		FileIdentity:    rec.FileIdentity,
		Generation:      rec.Generation,
		ByteOffset:      rec.ByteOffset,
		ParserStateJson: stringOrDefault(rec.ParserStateJSON, "{}"),
		State:           usageSourceStateOrDefault(rec.State),
		FailureCount:    rec.FailureCount,
		AnomalyCount:    rec.AnomalyCount,
		NextRetryAt:     ptrTimeToNullTime(rec.NextRetryAt),
		LastErrorCode:   rec.LastErrorCode,
		UpdatedAt:       timeOrNow(rec.UpdatedAt),
	}
}

func usageEventInsertParams(source gen.GetUsageSourceWithBindingAndSessionRow, ev domain.ModelUsageEvent) gen.InsertModelUsageEventParams {
	return gen.InsertModelUsageEventParams{
		BindingID:              source.BindingID,
		UsageSourceID:          source.SourceID,
		ProviderID:             sql.NullString{String: ev.ProviderID, Valid: true},
		ModelID:                ev.ModelID,
		InputTokens:            ev.Tokens.InputTokens,
		UncachedInputTokens:    ev.Tokens.UncachedInputTokens,
		CacheReadTokens:        ev.Tokens.CacheReadTokens,
		CacheWriteTokens:       ev.Tokens.CacheWriteTokens,
		OutputTokens:           ev.Tokens.OutputTokens,
		ReasoningTokens:        ptrInt64ToNull(ev.Tokens.ReasoningTokens),
		CacheWrite5mTokens:     ptrInt64ToNull(ev.CacheWrite5mTokens),
		CacheWrite1hTokens:     ptrInt64ToNull(ev.CacheWrite1hTokens),
		UncachedInputCostNanos: ptrInt64ToNull(ev.UncachedInputCostNanos),
		CacheReadCostNanos:     ptrInt64ToNull(ev.CacheReadCostNanos),
		CacheWriteCostNanos:    ptrInt64ToNull(ev.CacheWriteCostNanos),
		OutputCostNanos:        ptrInt64ToNull(ev.OutputCostNanos),
		EstimatedCostNanos:     ptrInt64ToNull(ev.EstimatedCostNanos),
		PricingVersion:         ev.PricingVersion,
		SourceEventKey:         ev.SourceEventKey,
	}
}

func usageEventMatches(existing gen.GetModelUsageEventByKeyRow, event domain.ModelUsageEvent) bool {
	reasoning := ptrInt64ToNull(event.Tokens.ReasoningTokens)
	genericMatches := existing.ModelID == event.ModelID &&
		existing.InputTokens == event.Tokens.InputTokens &&
		existing.UncachedInputTokens == event.Tokens.UncachedInputTokens &&
		existing.CacheReadTokens == event.Tokens.CacheReadTokens &&
		existing.CacheWriteTokens == event.Tokens.CacheWriteTokens &&
		existing.OutputTokens == event.Tokens.OutputTokens &&
		existing.ReasoningTokens == reasoning
	if !genericMatches || !existing.ProviderID.Valid {
		return genericMatches
	}
	return existing.ProviderID.String == event.ProviderID &&
		existing.CacheWrite5mTokens == ptrInt64ToNull(event.CacheWrite5mTokens) &&
		existing.CacheWrite1hTokens == ptrInt64ToNull(event.CacheWrite1hTokens)
}

func usageAggregateFromGen(row gen.AggregateUsageBySessionHarnessModelRow) domain.UsageModelAggregate {
	return domain.UsageModelAggregate{
		Harness:    row.Harness,
		ProviderID: row.ProviderID,
		ModelID:    row.ModelID,
		Tokens: domain.UsageTokenMetrics{
			InputTokens:         row.InputTokens,
			UncachedInputTokens: row.UncachedInputTokens,
			CacheReadTokens:     row.CacheReadTokens,
			CacheWriteTokens:    row.CacheWriteTokens,
			OutputTokens:        row.OutputTokens,
			ReasoningTokens:     int64PtrWhen(row.ReasoningTokens, row.ReasoningEventCount > 0),
		},
		ReasoningEventCount: row.ReasoningEventCount,
		Cost: domain.UsageCostAggregate{
			EventCount: row.EventCount, PricedEventCount: row.PricedEventCount, PricedTotalNanos: row.PricedTotalNanos,
			KnownUncachedInputCount: row.KnownUncachedInputCount, KnownUncachedInputNanos: row.KnownUncachedInputNanos,
			UnpricedKnownUncachedInputNanos: row.UnpricedKnownUncachedInputNanos,
			KnownCacheReadCount:             row.KnownCacheReadCount, KnownCacheReadNanos: row.KnownCacheReadNanos,
			UnpricedKnownCacheReadNanos: row.UnpricedKnownCacheReadNanos,
			KnownCacheWriteCount:        row.KnownCacheWriteCount, KnownCacheWriteNanos: row.KnownCacheWriteNanos,
			UnpricedKnownCacheWriteNanos: row.UnpricedKnownCacheWriteNanos,
			KnownOutputCount:             row.KnownOutputCount, KnownOutputNanos: row.KnownOutputNanos,
			UnpricedKnownOutputNanos: row.UnpricedKnownOutputNanos,
		},
	}
}

func usageBindingStateOrDefault(state domain.UsageBindingState) domain.UsageBindingState {
	if state == "" {
		return domain.UsageBindingDiscovering
	}
	return state
}

func usageSourceStateOrDefault(state domain.UsageSourceState) domain.UsageSourceState {
	if state == "" {
		return domain.UsageSourcePending
	}
	return state
}

func stringOrDefault(v, fallback string) string {
	if v != "" {
		return v
	}
	return fallback
}

func validateParserStateObject(raw string) error {
	if raw == "" {
		raw = "{}"
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &object); err != nil || object == nil {
		return errors.New("usage parser state must be a JSON object")
	}
	return nil
}

func timeOrNow(t time.Time) time.Time {
	if t.IsZero() {
		return time.Now().UTC()
	}
	return t.UTC()
}

func ptrTimeToNullTime(t *time.Time) sql.NullTime {
	if t == nil || t.IsZero() {
		return sql.NullTime{}
	}
	return sql.NullTime{Time: t.UTC(), Valid: true}
}

func nullTimePtr(t sql.NullTime) *time.Time {
	if !t.Valid {
		return nil
	}
	out := t.Time
	return &out
}

func ptrInt64ToNull(v *int64) sql.NullInt64 {
	if v == nil {
		return sql.NullInt64{}
	}
	return sql.NullInt64{Int64: *v, Valid: true}
}

func nullInt64Ptr(v sql.NullInt64) *int64 {
	if !v.Valid {
		return nil
	}
	value := v.Int64
	return &value
}

func int64PtrWhen(v int64, ok bool) *int64 {
	if !ok {
		return nil
	}
	return &v
}
