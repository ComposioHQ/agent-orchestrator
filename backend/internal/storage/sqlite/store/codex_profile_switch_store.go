package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

var _ ports.CodexProfileSwitchStore = (*Store)(nil)

// CreateCodexProfileSwitch idempotently admits one assisted continuation.
func (s *Store) CreateCodexProfileSwitch(ctx context.Context, rec domain.CodexProfileSwitch) (domain.CodexProfileSwitch, bool, error) {
	if err := validateCodexProfileSwitch(rec); err != nil {
		return domain.CodexProfileSwitch{}, false, err
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if completed, completedErr := s.qw.GetCompletedCodexProfileSwitch(ctx, rec.SourceSessionID); completedErr == nil {
		return codexProfileSwitchFromGen(completed), false, domain.ErrCodexProfileSwitchTransitionConflict
	} else if !errors.Is(completedErr, sql.ErrNoRows) {
		return domain.CodexProfileSwitch{}, false, fmt.Errorf("read completed Codex profile switch: %w", completedErr)
	}
	if err := s.qw.InsertCodexProfileSwitch(ctx, codexProfileSwitchToInsert(rec)); err == nil {
		return rec, true, nil
	} else if !isSQLiteUnique(err) {
		return domain.CodexProfileSwitch{}, false, fmt.Errorf("create Codex profile switch %s: %w", rec.ID, err)
	}

	row, err := s.qw.GetCodexProfileSwitchByIdempotencyKey(ctx, gen.GetCodexProfileSwitchByIdempotencyKeyParams{
		SourceSessionID: rec.SourceSessionID, IdempotencyKey: rec.IdempotencyKey,
	})
	if err == nil {
		existing := codexProfileSwitchFromGen(row)
		if existing.RequestFingerprint == rec.RequestFingerprint {
			return existing, false, nil
		}
		return existing, false, domain.ErrCodexProfileSwitchIdempotencyConflict
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return domain.CodexProfileSwitch{}, false, fmt.Errorf("read conflicting Codex profile switch: %w", err)
	}
	active, activeErr := s.qw.GetActiveCodexProfileSwitch(ctx, rec.SourceSessionID)
	if activeErr == nil {
		return codexProfileSwitchFromGen(active), false, domain.ErrCodexProfileSwitchInProgress
	}
	if !errors.Is(activeErr, sql.ErrNoRows) {
		return domain.CodexProfileSwitch{}, false, fmt.Errorf("read active Codex profile switch: %w", activeErr)
	}
	return domain.CodexProfileSwitch{}, false, domain.ErrCodexProfileSwitchTransitionConflict
}

// GetCodexProfileSwitch returns one durable operation.
func (s *Store) GetCodexProfileSwitch(ctx context.Context, id domain.CodexProfileSwitchID) (domain.CodexProfileSwitch, bool, error) {
	row, err := s.qr.GetCodexProfileSwitch(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.CodexProfileSwitch{}, false, nil
	}
	if err != nil {
		return domain.CodexProfileSwitch{}, false, fmt.Errorf("get Codex profile switch %s: %w", id, err)
	}
	return codexProfileSwitchFromGen(row), true, nil
}

// GetCodexProfileSwitchByIdempotencyKey resolves one retried request.
func (s *Store) GetCodexProfileSwitchByIdempotencyKey(ctx context.Context, sourceSessionID domain.SessionID, key string) (domain.CodexProfileSwitch, bool, error) {
	row, err := s.qr.GetCodexProfileSwitchByIdempotencyKey(ctx, gen.GetCodexProfileSwitchByIdempotencyKeyParams{SourceSessionID: sourceSessionID, IdempotencyKey: key})
	if errors.Is(err, sql.ErrNoRows) {
		return domain.CodexProfileSwitch{}, false, nil
	}
	if err != nil {
		return domain.CodexProfileSwitch{}, false, fmt.Errorf("get Codex profile switch idempotency key: %w", err)
	}
	return codexProfileSwitchFromGen(row), true, nil
}

// GetActiveCodexProfileSwitch returns the source's sole nonterminal operation.
func (s *Store) GetActiveCodexProfileSwitch(ctx context.Context, sourceSessionID domain.SessionID) (domain.CodexProfileSwitch, bool, error) {
	row, err := s.qr.GetActiveCodexProfileSwitch(ctx, sourceSessionID)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.CodexProfileSwitch{}, false, nil
	}
	if err != nil {
		return domain.CodexProfileSwitch{}, false, fmt.Errorf("get active Codex profile switch: %w", err)
	}
	return codexProfileSwitchFromGen(row), true, nil
}

// GetCodexProfileSwitchForSession returns the active or newest source/target relation.
func (s *Store) GetCodexProfileSwitchForSession(ctx context.Context, sessionID domain.SessionID) (domain.CodexProfileSwitch, bool, error) {
	row, err := s.qr.GetCodexProfileSwitchForSession(ctx, gen.GetCodexProfileSwitchForSessionParams{SourceSessionID: sessionID, TargetSessionID: &sessionID})
	if errors.Is(err, sql.ErrNoRows) {
		return domain.CodexProfileSwitch{}, false, nil
	}
	if err != nil {
		return domain.CodexProfileSwitch{}, false, fmt.Errorf("get Codex profile switch relation for %s: %w", sessionID, err)
	}
	return codexProfileSwitchFromGen(row), true, nil
}

// ListCodexProfileSwitches returns source history newest-first.
func (s *Store) ListCodexProfileSwitches(ctx context.Context, sourceSessionID domain.SessionID) ([]domain.CodexProfileSwitch, error) {
	rows, err := s.qr.ListCodexProfileSwitches(ctx, sourceSessionID)
	if err != nil {
		return nil, fmt.Errorf("list Codex profile switches for %s: %w", sourceSessionID, err)
	}
	out := make([]domain.CodexProfileSwitch, 0, len(rows))
	for _, row := range rows {
		out = append(out, codexProfileSwitchFromGen(row))
	}
	return out, nil
}

// ListActiveCodexProfileSwitches returns startup-reconciliation work.
func (s *Store) ListActiveCodexProfileSwitches(ctx context.Context) ([]domain.CodexProfileSwitch, error) {
	rows, err := s.qr.ListActiveCodexProfileSwitches(ctx)
	if err != nil {
		return nil, fmt.Errorf("list active Codex profile switches: %w", err)
	}
	out := make([]domain.CodexProfileSwitch, 0, len(rows))
	for _, row := range rows {
		out = append(out, codexProfileSwitchFromGen(row))
	}
	return out, nil
}

// UpdateCodexProfileSwitch advances one CAS-fenced durable phase.
func (s *Store) UpdateCodexProfileSwitch(ctx context.Context, rec domain.CodexProfileSwitch, expectedPhase domain.CodexProfileSwitchPhase, expectedSourceGenerationID, expectedTargetGenerationID domain.AgentGenerationID) (bool, error) {
	if !domain.ValidCodexProfileSwitchTransition(expectedPhase, rec.Phase) {
		return false, fmt.Errorf("update Codex profile switch %s: invalid transition %s -> %s", rec.ID, expectedPhase, rec.Phase)
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := s.qw.UpdateCodexProfileSwitch(ctx, codexProfileSwitchToUpdate(rec, expectedPhase, expectedSourceGenerationID, expectedTargetGenerationID))
	if err != nil {
		return false, fmt.Errorf("update Codex profile switch %s: %w", rec.ID, err)
	}
	return n == 1, nil
}

// AcknowledgeCodexProfileSwitchTarget accepts only the exact target generation
// while the immutable handoff delivery boundary is open.
func (s *Store) AcknowledgeCodexProfileSwitchTarget(ctx context.Context, id domain.CodexProfileSwitchID, targetSessionID domain.SessionID, targetGenerationID domain.AgentGenerationID, acknowledgedAt time.Time) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := s.qw.AcknowledgeCodexProfileSwitchTarget(ctx, gen.AcknowledgeCodexProfileSwitchTargetParams{
		TargetAcknowledgedAt: sql.NullTime{Time: acknowledgedAt, Valid: true}, ID: id, TargetSessionID: &targetSessionID, TargetGenerationID: targetGenerationID,
	})
	if err != nil {
		return false, fmt.Errorf("acknowledge Codex profile switch target %s: %w", id, err)
	}
	return n == 1, nil
}

// CreateCodexProfileSwitchTarget atomically creates the continuation seed and
// immutable profile binding, attaches it to the switch, and moves worktree rows.
func (s *Store) CreateCodexProfileSwitchTarget(ctx context.Context, sw domain.CodexProfileSwitch, seed domain.SessionRecord, binding domain.CodexSessionBinding, now time.Time) (domain.SessionRecord, domain.CodexProfileSwitch, error) {
	if sw.Phase != domain.CodexProfileSwitchSourceStopped || sw.TargetSessionID != nil || seed.ProjectID == "" || binding.ProfileID != sw.TargetProfileID {
		return domain.SessionRecord{}, sw, domain.ErrCodexProfileSwitchTransitionConflict
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return domain.SessionRecord{}, sw, fmt.Errorf("begin create profile-switch target: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	q := s.qw.WithTx(tx)
	currentRow, err := q.GetCodexProfileSwitch(ctx, sw.ID)
	if err != nil {
		return domain.SessionRecord{}, sw, fmt.Errorf("read profile switch before target allocation: %w", err)
	}
	current := codexProfileSwitchFromGen(currentRow)
	if current.Phase != sw.Phase || current.TargetSessionID != nil || current.SourceGenerationID != sw.SourceGenerationID {
		return domain.SessionRecord{}, current, domain.ErrCodexProfileSwitchTransitionConflict
	}
	num, err := q.NextSessionNum(ctx, seed.ProjectID)
	if err != nil {
		return domain.SessionRecord{}, current, fmt.Errorf("next continuation session number: %w", err)
	}
	seed.ID = domain.SessionID(fmt.Sprintf("%s-%d", seed.ProjectID, num))
	seed.CreatedAt, seed.UpdatedAt, seed.ArchivedAt = now, now, nil
	if err := q.InsertSession(ctx, recordToInsert(seed, num)); err != nil {
		return domain.SessionRecord{}, current, fmt.Errorf("insert continuation session: %w", err)
	}
	binding.SessionID, binding.CreatedAt = seed.ID, now
	if err := q.InsertCodexSessionBinding(ctx, bindingToInsert(binding)); err != nil {
		return domain.SessionRecord{}, current, fmt.Errorf("insert continuation binding: %w", err)
	}
	if _, err := q.MoveSessionWorktrees(ctx, gen.MoveSessionWorktreesParams{TargetSessionID: seed.ID, SourceSessionID: sw.SourceSessionID}); err != nil {
		return domain.SessionRecord{}, current, fmt.Errorf("move continuation worktree ownership: %w", err)
	}
	seed.CodexProfileBinding = &binding
	current.TargetSessionID = &seed.ID
	current.Phase = domain.CodexProfileSwitchStartingTarget
	current.UpdatedAt = now
	n, err := q.UpdateCodexProfileSwitch(ctx, codexProfileSwitchToUpdate(current, sw.Phase, sw.SourceGenerationID, sw.TargetGenerationID))
	if err != nil || n != 1 {
		if err == nil {
			err = domain.ErrCodexProfileSwitchTransitionConflict
		}
		return domain.SessionRecord{}, current, fmt.Errorf("attach continuation target: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return domain.SessionRecord{}, current, fmt.Errorf("commit continuation target: %w", err)
	}
	return seed, current, nil
}

// CompleteCodexProfileSwitch atomically archives the predecessor and transfers
// the logical workspace owner after exact target acknowledgement.
func (s *Store) CompleteCodexProfileSwitch(ctx context.Context, sw domain.CodexProfileSwitch, acknowledgedAt time.Time) (domain.CodexProfileSwitch, bool, error) {
	if sw.Phase != domain.CodexProfileSwitchDeliveringHandoff || sw.TargetSessionID == nil || sw.TargetGenerationID == "" {
		return sw, false, domain.ErrCodexProfileSwitchTransitionConflict
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return sw, false, fmt.Errorf("begin complete Codex profile switch: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	q := s.qw.WithTx(tx)
	currentRow, err := q.GetCodexProfileSwitch(ctx, sw.ID)
	if err != nil {
		return sw, false, fmt.Errorf("read Codex profile switch before completion: %w", err)
	}
	current := codexProfileSwitchFromGen(currentRow)
	if current.Phase != domain.CodexProfileSwitchDeliveringHandoff || current.TargetSessionID == nil ||
		current.TargetAcknowledgedAt == nil || !current.TargetAcknowledgedAt.Equal(acknowledgedAt) ||
		current.SourceGenerationID != sw.SourceGenerationID || current.TargetGenerationID != sw.TargetGenerationID ||
		*current.TargetSessionID != *sw.TargetSessionID {
		return current, false, domain.ErrCodexProfileSwitchTransitionConflict
	}
	n, err := q.ArchiveSessionForCodexProfileSwitch(ctx, gen.ArchiveSessionForCodexProfileSwitchParams{ArchivedAt: sql.NullTime{Time: acknowledgedAt, Valid: true}, UpdatedAt: acknowledgedAt, ID: current.SourceSessionID})
	if err != nil || n != 1 {
		if err == nil {
			err = domain.ErrCodexProfileSwitchTransitionConflict
		}
		return sw, false, fmt.Errorf("archive profile-switch predecessor: %w", err)
	}
	current.Phase = domain.CodexProfileSwitchCompleted
	current.WorkspaceOwner = domain.CodexProfileSwitchOwnerTarget
	current.TargetAcknowledgedAt = &acknowledgedAt
	current.SourceArchivedAt = &acknowledgedAt
	current.CompletedAt = &acknowledgedAt
	current.UpdatedAt = acknowledgedAt
	n, err = q.UpdateCodexProfileSwitch(ctx, codexProfileSwitchToUpdate(current, domain.CodexProfileSwitchDeliveringHandoff, current.SourceGenerationID, current.TargetGenerationID))
	if err != nil || n != 1 {
		if err == nil {
			err = domain.ErrCodexProfileSwitchTransitionConflict
		}
		return sw, false, fmt.Errorf("complete profile switch: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return sw, false, fmt.Errorf("commit profile switch completion: %w", err)
	}
	return current, true, nil
}

// RestoreCodexProfileSwitchSource moves the same worktree rows back and leaves
// the failed target seed archived; it never selects another profile.
func (s *Store) RestoreCodexProfileSwitchSource(ctx context.Context, sw domain.CodexProfileSwitch, restoredAt time.Time) (domain.CodexProfileSwitch, bool, error) {
	if sw.Phase != domain.CodexProfileSwitchRecoveryRequired {
		return sw, false, domain.ErrCodexProfileSwitchTransitionConflict
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return sw, false, fmt.Errorf("begin restore profile-switch source: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	q := s.qw.WithTx(tx)
	if sw.TargetSessionID != nil {
		if _, err := q.MoveSessionWorktrees(ctx, gen.MoveSessionWorktreesParams{TargetSessionID: sw.SourceSessionID, SourceSessionID: *sw.TargetSessionID}); err != nil {
			return sw, false, fmt.Errorf("restore source worktree ownership: %w", err)
		}
		if _, err := q.ArchiveSessionForCodexProfileSwitch(ctx, gen.ArchiveSessionForCodexProfileSwitchParams{ArchivedAt: sql.NullTime{Time: restoredAt, Valid: true}, UpdatedAt: restoredAt, ID: *sw.TargetSessionID}); err != nil {
			return sw, false, fmt.Errorf("archive unused continuation target: %w", err)
		}
	}
	if _, err := q.UnarchiveSessionForCodexProfileSwitch(ctx, gen.UnarchiveSessionForCodexProfileSwitchParams{UpdatedAt: restoredAt, ID: sw.SourceSessionID}); err != nil {
		return sw, false, fmt.Errorf("unarchive restored source: %w", err)
	}
	current := sw
	current.WorkspaceOwner = domain.CodexProfileSwitchOwnerRecovery
	current.ErrorCode = domain.CodexProfileSwitchErrorSourceRestoreUnconfirmed
	current.UpdatedAt = restoredAt
	n, err := q.UpdateCodexProfileSwitch(ctx, codexProfileSwitchToUpdate(current, sw.Phase, sw.SourceGenerationID, sw.TargetGenerationID))
	if err != nil || n != 1 {
		if err == nil {
			err = domain.ErrCodexProfileSwitchTransitionConflict
		}
		return sw, false, fmt.Errorf("finish source restoration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return sw, false, fmt.Errorf("commit source restoration: %w", err)
	}
	return current, true, nil
}

func validateCodexProfileSwitch(rec domain.CodexProfileSwitch) error {
	if rec.ID == "" || rec.SourceSessionID == "" || strings.TrimSpace(rec.SourceProfileID) == "" ||
		strings.TrimSpace(rec.TargetProfileID) == "" || rec.SourceProfileID == rec.TargetProfileID ||
		strings.TrimSpace(rec.IdempotencyKey) == "" || !rec.RequestFingerprint.Valid() ||
		!rec.Trigger.Valid() || !rec.Phase.Valid() || rec.RequestedAt.IsZero() || rec.UpdatedAt.Before(rec.RequestedAt) {
		return fmt.Errorf("invalid Codex profile switch %s", rec.ID)
	}
	return nil
}

func codexProfileSwitchToInsert(rec domain.CodexProfileSwitch) gen.InsertCodexProfileSwitchParams {
	return gen.InsertCodexProfileSwitchParams{
		ID: rec.ID, SourceSessionID: rec.SourceSessionID, TargetSessionID: rec.TargetSessionID,
		SourceProfileID: rec.SourceProfileID, TargetProfileID: rec.TargetProfileID,
		IdempotencyKey: rec.IdempotencyKey, RequestFingerprint: rec.RequestFingerprint,
		TriggerKind: rec.Trigger, Phase: rec.Phase, RecoveryOriginPhase: rec.RecoveryOriginPhase,
		WorkspaceOwner: rec.WorkspaceOwner, SourceGenerationID: rec.SourceGenerationID,
		TargetGenerationID: rec.TargetGenerationID, TargetRuntimeHandleID: rec.TargetRuntimeHandleID,
		TargetControllerGeneration: rec.TargetControllerGeneration, TargetProviderThreadID: rec.TargetProviderThreadID,
		SemanticHandoffStatus: rec.SemanticHandoffStatus, HandoffClassification: rec.HandoffClassification,
		FinalHandoffPath: rec.FinalHandoffPath, FinalHandoffHash: rec.FinalHandoffHash,
		AcknowledgeUnknownCapacity: rec.AcknowledgeUnknownCapacity,
		TargetAcknowledgedAt:       timePtrToNull(rec.TargetAcknowledgedAt), SourceArchivedAt: timePtrToNull(rec.SourceArchivedAt),
		RequestedAt: rec.RequestedAt, UpdatedAt: rec.UpdatedAt, CompletedAt: timePtrToNull(rec.CompletedAt), ErrorCode: string(rec.ErrorCode),
	}
}

func codexProfileSwitchToUpdate(rec domain.CodexProfileSwitch, expectedPhase domain.CodexProfileSwitchPhase, expectedSourceGenerationID, expectedTargetGenerationID domain.AgentGenerationID) gen.UpdateCodexProfileSwitchParams {
	return gen.UpdateCodexProfileSwitchParams{
		TargetSessionID: rec.TargetSessionID, NextPhase: rec.Phase, RecoveryOriginPhase: rec.RecoveryOriginPhase,
		WorkspaceOwner: rec.WorkspaceOwner, TargetGenerationID: rec.TargetGenerationID,
		TargetRuntimeHandleID: rec.TargetRuntimeHandleID, TargetControllerGeneration: rec.TargetControllerGeneration,
		TargetProviderThreadID: rec.TargetProviderThreadID, SemanticHandoffStatus: rec.SemanticHandoffStatus,
		HandoffClassification: rec.HandoffClassification, FinalHandoffPath: rec.FinalHandoffPath,
		FinalHandoffHash: rec.FinalHandoffHash, TargetAcknowledgedAt: timePtrToNull(rec.TargetAcknowledgedAt),
		SourceArchivedAt: timePtrToNull(rec.SourceArchivedAt), UpdatedAt: rec.UpdatedAt,
		CompletedAt: timePtrToNull(rec.CompletedAt), ErrorCode: string(rec.ErrorCode),
		ID: rec.ID, SourceSessionID: rec.SourceSessionID, ExpectedPhase: expectedPhase,
		ExpectedSourceGenerationID: expectedSourceGenerationID, ExpectedTargetGenerationID: expectedTargetGenerationID,
	}
}

func codexProfileSwitchFromGen(row gen.CodexProfileSwitch) domain.CodexProfileSwitch {
	return domain.CodexProfileSwitch{
		ID: row.ID, SourceSessionID: row.SourceSessionID, TargetSessionID: row.TargetSessionID,
		SourceProfileID: row.SourceProfileID, TargetProfileID: row.TargetProfileID,
		IdempotencyKey: row.IdempotencyKey, RequestFingerprint: row.RequestFingerprint,
		Trigger: row.TriggerKind, Phase: row.Phase, RecoveryOriginPhase: row.RecoveryOriginPhase,
		WorkspaceOwner: row.WorkspaceOwner, SourceGenerationID: row.SourceGenerationID,
		TargetGenerationID: row.TargetGenerationID, TargetRuntimeHandleID: row.TargetRuntimeHandleID,
		TargetControllerGeneration: row.TargetControllerGeneration, TargetProviderThreadID: row.TargetProviderThreadID,
		SemanticHandoffStatus: row.SemanticHandoffStatus, HandoffClassification: row.HandoffClassification,
		FinalHandoffPath: row.FinalHandoffPath, FinalHandoffHash: row.FinalHandoffHash,
		AcknowledgeUnknownCapacity: row.AcknowledgeUnknownCapacity,
		TargetAcknowledgedAt:       nullTimeToPtr(row.TargetAcknowledgedAt), SourceArchivedAt: nullTimeToPtr(row.SourceArchivedAt),
		RequestedAt: row.RequestedAt, UpdatedAt: row.UpdatedAt, CompletedAt: nullTimeToPtr(row.CompletedAt),
		ErrorCode: domain.CodexProfileSwitchErrorCode(row.ErrorCode),
	}
}
