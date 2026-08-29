package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

var _ ports.CodexAutomaticProfileSwitchStore = (*Store)(nil)

const resolveAutomaticChainRootSQL = `
WITH RECURSIVE ancestors(session_id, depth) AS (
  SELECT ?, 0
  UNION ALL
  SELECT sw.source_session_id, ancestors.depth + 1
  FROM codex_profile_switches sw
  JOIN ancestors ON sw.target_session_id = ancestors.session_id
  WHERE sw.phase = 'completed'
)
SELECT session_id FROM ancestors ORDER BY depth DESC LIMIT 1`

func resolveAutomaticChainRoot(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, sessionID domain.SessionID) (domain.SessionID, error) {
	var root domain.SessionID
	err := q.QueryRowContext(ctx, `SELECT chain_root_session_id FROM codex_automatic_profile_switch_chain_sessions WHERE session_id = ?`, sessionID).Scan(&root)
	if err == nil {
		return root, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	if err := q.QueryRowContext(ctx, resolveAutomaticChainRootSQL, sessionID).Scan(&root); err != nil {
		return "", err
	}
	return root, nil
}

// GetCodexAutomaticProfileSwitchPolicy returns a synthetic disabled revision-0
// view without creating durable state.
func (s *Store) GetCodexAutomaticProfileSwitchPolicy(ctx context.Context, sessionID domain.SessionID) (domain.CodexAutomaticProfileSwitchPolicy, bool, error) {
	root, err := resolveAutomaticChainRoot(ctx, s.readDB, sessionID)
	if err != nil {
		return domain.CodexAutomaticProfileSwitchPolicy{}, false, fmt.Errorf("resolve automatic profile-switch chain: %w", err)
	}
	policy := domain.CodexAutomaticProfileSwitchPolicy{ChainRootSessionID: root, Profiles: []domain.CodexAutomaticProfileSwitchPolicyEntry{}, ProfileIDs: []string{}}
	var createdAt, updatedAt time.Time
	err = s.readDB.QueryRowContext(ctx, `SELECT enabled, revision, created_at, updated_at FROM codex_automatic_profile_switch_policies WHERE chain_root_session_id = ?`, root).
		Scan(&policy.Enabled, &policy.Revision, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return policy, false, nil
	}
	if err != nil {
		return domain.CodexAutomaticProfileSwitchPolicy{}, false, fmt.Errorf("read automatic profile-switch policy: %w", err)
	}
	policy.CreatedAt, policy.UpdatedAt = &createdAt, &updatedAt
	rows, err := s.readDB.QueryContext(ctx, `SELECT profile_id FROM codex_automatic_profile_switch_policy_profiles WHERE chain_root_session_id = ? ORDER BY position`, root)
	if err != nil {
		return domain.CodexAutomaticProfileSwitchPolicy{}, false, fmt.Errorf("list automatic profile-switch policy profiles: %w", err)
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return domain.CodexAutomaticProfileSwitchPolicy{}, false, err
		}
		policy.ProfileIDs = append(policy.ProfileIDs, id)
	}
	return policy, true, rows.Err()
}

// PutCodexAutomaticProfileSwitchPolicy performs one ordered CAS update. The
// first write atomically records every existing continuation member.
func (s *Store) PutCodexAutomaticProfileSwitchPolicy(ctx context.Context, sessionID domain.SessionID, enabled bool, profileIDs []string, expectedRevision int64, now time.Time) (domain.CodexAutomaticProfileSwitchPolicy, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return domain.CodexAutomaticProfileSwitchPolicy{}, err
	}
	defer func() { _ = tx.Rollback() }()
	root, err := resolveAutomaticChainRoot(ctx, tx, sessionID)
	if err != nil {
		return domain.CodexAutomaticProfileSwitchPolicy{}, fmt.Errorf("resolve automatic profile-switch chain: %w", err)
	}
	var currentRevision int64
	err = tx.QueryRowContext(ctx, `SELECT revision FROM codex_automatic_profile_switch_policies WHERE chain_root_session_id = ?`, root).Scan(&currentRevision)
	creating := errors.Is(err, sql.ErrNoRows)
	if err != nil && !creating {
		return domain.CodexAutomaticProfileSwitchPolicy{}, err
	}
	if creating {
		if expectedRevision != 0 {
			return domain.CodexAutomaticProfileSwitchPolicy{}, domain.ErrCodexAutomaticProfileSwitchPolicyRevisionConflict
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO codex_automatic_profile_switch_policies(chain_root_session_id, enabled, revision, created_at, updated_at) VALUES (?, 0, 1, ?, ?)`, root, now, now); err != nil {
			return domain.CodexAutomaticProfileSwitchPolicy{}, err
		}
		rows, err := tx.QueryContext(ctx, `WITH RECURSIVE descendants(session_id, depth) AS (
  SELECT ?, 0 UNION ALL SELECT sw.target_session_id, descendants.depth + 1
  FROM codex_profile_switches sw JOIN descendants ON sw.source_session_id = descendants.session_id
  WHERE sw.phase = 'completed' AND sw.target_session_id IS NOT NULL
) SELECT session_id FROM descendants ORDER BY depth, session_id`, root)
		if err != nil {
			return domain.CodexAutomaticProfileSwitchPolicy{}, err
		}
		defer func() { _ = rows.Close() }()
		var members []domain.SessionID
		for rows.Next() {
			var member domain.SessionID
			if err := rows.Scan(&member); err != nil {
				return domain.CodexAutomaticProfileSwitchPolicy{}, err
			}
			members = append(members, member)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return domain.CodexAutomaticProfileSwitchPolicy{}, err
		}
		if err := rows.Close(); err != nil {
			return domain.CodexAutomaticProfileSwitchPolicy{}, err
		}
		for _, member := range members {
			if _, err := tx.ExecContext(ctx, `INSERT INTO codex_automatic_profile_switch_chain_sessions(session_id, chain_root_session_id, joined_at) VALUES (?, ?, ?) ON CONFLICT(session_id) DO NOTHING`, member, root, now); err != nil {
				return domain.CodexAutomaticProfileSwitchPolicy{}, err
			}
		}
		currentRevision = 1
	} else if currentRevision != expectedRevision || expectedRevision == 0 {
		return domain.CodexAutomaticProfileSwitchPolicy{}, domain.ErrCodexAutomaticProfileSwitchPolicyRevisionConflict
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM codex_automatic_profile_switch_policy_profiles WHERE chain_root_session_id = ?`, root); err != nil {
		return domain.CodexAutomaticProfileSwitchPolicy{}, err
	}
	for position, profileID := range profileIDs {
		if _, err := tx.ExecContext(ctx, `INSERT INTO codex_automatic_profile_switch_policy_profiles(chain_root_session_id, position, profile_id) VALUES (?, ?, ?)`, root, position, profileID); err != nil {
			return domain.CodexAutomaticProfileSwitchPolicy{}, err
		}
	}
	nextRevision := int64(1)
	if creating {
		result, err := tx.ExecContext(ctx, `UPDATE codex_automatic_profile_switch_policies SET enabled = ?, updated_at = ? WHERE chain_root_session_id = ? AND revision = 1`, enabled, now, root)
		if err != nil {
			return domain.CodexAutomaticProfileSwitchPolicy{}, err
		}
		if affected, _ := result.RowsAffected(); affected != 1 {
			return domain.CodexAutomaticProfileSwitchPolicy{}, domain.ErrCodexAutomaticProfileSwitchPolicyRevisionConflict
		}
	} else {
		nextRevision = currentRevision + 1
		result, err := tx.ExecContext(ctx, `UPDATE codex_automatic_profile_switch_policies SET enabled = ?, revision = revision + 1, updated_at = ? WHERE chain_root_session_id = ? AND revision = ?`, enabled, now, root, expectedRevision)
		if err != nil {
			return domain.CodexAutomaticProfileSwitchPolicy{}, err
		}
		if affected, _ := result.RowsAffected(); affected != 1 {
			return domain.CodexAutomaticProfileSwitchPolicy{}, domain.ErrCodexAutomaticProfileSwitchPolicyRevisionConflict
		}
	}
	if err := tx.Commit(); err != nil {
		return domain.CodexAutomaticProfileSwitchPolicy{}, err
	}
	created := now
	if !creating {
		created = time.Time{}
	}
	policy := domain.CodexAutomaticProfileSwitchPolicy{ChainRootSessionID: root, Enabled: enabled, Revision: nextRevision, ProfileIDs: append([]string(nil), profileIDs...), Profiles: []domain.CodexAutomaticProfileSwitchPolicyEntry{}, UpdatedAt: &now}
	if creating {
		policy.CreatedAt = &created
	} else if persisted, _, readErr := s.GetCodexAutomaticProfileSwitchPolicy(ctx, sessionID); readErr == nil {
		policy.CreatedAt = persisted.CreatedAt
	}
	return policy, nil
}

// InheritCodexAutomaticProfileSwitchChain attaches only a successful continuation target.
func (s *Store) InheritCodexAutomaticProfileSwitchChain(ctx context.Context, sourceSessionID, targetSessionID domain.SessionID, now time.Time) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.writeDB.ExecContext(ctx, `INSERT INTO codex_automatic_profile_switch_chain_sessions(session_id, chain_root_session_id, joined_at)
SELECT ?, chain_root_session_id, ? FROM codex_automatic_profile_switch_chain_sessions WHERE session_id = ?
ON CONFLICT(session_id) DO NOTHING`, targetSessionID, now, sourceSessionID)
	return err
}

const automaticAttemptColumns = `id, chain_root_session_id, source_session_id, source_profile_id, source_generation_id, source_episode_id, trigger_kind, exhaustion_fingerprint, policy_revision, selected_profile_id, selected_profile_position, profile_switch_id, state, outcome_code, created_at, updated_at, completed_at`

type rowScanner interface{ Scan(...any) error }

func scanAutomaticAttempt(row rowScanner) (domain.CodexAutomaticProfileSwitchAttempt, error) {
	var attempt domain.CodexAutomaticProfileSwitchAttempt
	var selectedID, switchID sql.NullString
	var selectedPosition sql.NullInt64
	var completedAt sql.NullTime
	err := row.Scan(&attempt.ID, &attempt.ChainRootSessionID, &attempt.SourceSessionID, &attempt.SourceProfileID,
		&attempt.SourceGenerationID, &attempt.SourceEpisodeID, &attempt.Trigger, &attempt.ExhaustionFingerprint,
		&attempt.PolicyRevision, &selectedID, &selectedPosition, &switchID, &attempt.State, &attempt.OutcomeCode,
		&attempt.CreatedAt, &attempt.UpdatedAt, &completedAt)
	if err != nil {
		return attempt, err
	}
	if selectedID.Valid {
		attempt.SelectedProfileID = &selectedID.String
	}
	if selectedPosition.Valid {
		attempt.SelectedProfilePosition = &selectedPosition.Int64
	}
	if switchID.Valid {
		id := domain.CodexProfileSwitchID(switchID.String)
		attempt.ProfileSwitchID = &id
	}
	if completedAt.Valid {
		attempt.CompletedAt = &completedAt.Time
	}
	attempt.Candidates = []domain.CodexAutomaticProfileSwitchAttemptCandidate{}
	return attempt, nil
}

func (s *Store) loadAutomaticAttemptCandidates(ctx context.Context, attempt *domain.CodexAutomaticProfileSwitchAttempt) error {
	rows, err := s.readDB.QueryContext(ctx, `SELECT position, profile_id, reason_code, evaluated_at FROM codex_automatic_profile_switch_attempt_candidates WHERE attempt_id = ? ORDER BY position`, attempt.ID)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var candidate domain.CodexAutomaticProfileSwitchAttemptCandidate
		if err := rows.Scan(&candidate.Position, &candidate.ProfileID, &candidate.ReasonCode, &candidate.EvaluatedAt); err != nil {
			return err
		}
		attempt.Candidates = append(attempt.Candidates, candidate)
	}
	return rows.Err()
}

// CreateCodexAutomaticProfileSwitchAttempt idempotently admits one exhaustion episode.
func (s *Store) CreateCodexAutomaticProfileSwitchAttempt(ctx context.Context, attempt domain.CodexAutomaticProfileSwitchAttempt) (domain.CodexAutomaticProfileSwitchAttempt, bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.writeDB.ExecContext(ctx, `INSERT INTO codex_automatic_profile_switch_attempts(`+automaticAttemptColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		attempt.ID, attempt.ChainRootSessionID, attempt.SourceSessionID, attempt.SourceProfileID, attempt.SourceGenerationID,
		attempt.SourceEpisodeID, attempt.Trigger, attempt.ExhaustionFingerprint, attempt.PolicyRevision,
		attempt.SelectedProfileID, attempt.SelectedProfilePosition, attempt.ProfileSwitchID, attempt.State, attempt.OutcomeCode,
		attempt.CreatedAt, attempt.UpdatedAt, attempt.CompletedAt)
	if err == nil {
		return attempt, true, nil
	}
	if !isSQLiteUnique(err) {
		return domain.CodexAutomaticProfileSwitchAttempt{}, false, err
	}
	row := s.writeDB.QueryRowContext(ctx, `SELECT `+automaticAttemptColumns+` FROM codex_automatic_profile_switch_attempts WHERE exhaustion_fingerprint = ?`, attempt.ExhaustionFingerprint)
	existing, scanErr := scanAutomaticAttempt(row)
	if scanErr == nil {
		return existing, false, nil
	}
	row = s.writeDB.QueryRowContext(ctx, `SELECT `+automaticAttemptColumns+` FROM codex_automatic_profile_switch_attempts WHERE source_session_id = ? AND state IN ('evaluating','delegated_to_phase5')`, attempt.SourceSessionID)
	existing, scanErr = scanAutomaticAttempt(row)
	if scanErr == nil {
		return existing, false, domain.ErrCodexAutomaticProfileSwitchAttemptConflict
	}
	return domain.CodexAutomaticProfileSwitchAttempt{}, false, err
}

func (s *Store) getAutomaticAttempt(ctx context.Context, where string, arg any) (domain.CodexAutomaticProfileSwitchAttempt, bool, error) {
	attempt, err := scanAutomaticAttempt(s.readDB.QueryRowContext(ctx, `SELECT `+automaticAttemptColumns+` FROM codex_automatic_profile_switch_attempts WHERE `+where, arg))
	if errors.Is(err, sql.ErrNoRows) {
		return attempt, false, nil
	}
	if err != nil {
		return attempt, false, err
	}
	if err := s.loadAutomaticAttemptCandidates(ctx, &attempt); err != nil {
		return attempt, false, err
	}
	return attempt, true, nil
}

// GetCodexAutomaticProfileSwitchAttempt reads one durable attempt.
func (s *Store) GetCodexAutomaticProfileSwitchAttempt(ctx context.Context, attemptID string) (domain.CodexAutomaticProfileSwitchAttempt, bool, error) {
	return s.getAutomaticAttempt(ctx, `id = ?`, attemptID)
}

// GetActiveCodexAutomaticProfileSwitchAttempt reads the source's sole active attempt.
func (s *Store) GetActiveCodexAutomaticProfileSwitchAttempt(ctx context.Context, sourceSessionID domain.SessionID) (domain.CodexAutomaticProfileSwitchAttempt, bool, error) {
	return s.getAutomaticAttempt(ctx, `source_session_id = ? AND state IN ('evaluating','delegated_to_phase5')`, sourceSessionID)
}

// GetLatestCodexAutomaticProfileSwitchAttempt reads the newest source attempt.
func (s *Store) GetLatestCodexAutomaticProfileSwitchAttempt(ctx context.Context, sourceSessionID domain.SessionID) (domain.CodexAutomaticProfileSwitchAttempt, bool, error) {
	return s.getAutomaticAttempt(ctx, `source_session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`, sourceSessionID)
}

// ListActiveCodexAutomaticProfileSwitchAttempts returns startup reconciliation work.
func (s *Store) ListActiveCodexAutomaticProfileSwitchAttempts(ctx context.Context) ([]domain.CodexAutomaticProfileSwitchAttempt, error) {
	rows, err := s.readDB.QueryContext(ctx, `SELECT `+automaticAttemptColumns+` FROM codex_automatic_profile_switch_attempts WHERE state IN ('evaluating','delegated_to_phase5') ORDER BY created_at, id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var attempts []domain.CodexAutomaticProfileSwitchAttempt
	for rows.Next() {
		attempt, err := scanAutomaticAttempt(rows)
		if err != nil {
			return nil, err
		}
		attempts = append(attempts, attempt)
	}
	return attempts, rows.Err()
}

// ReplaceCodexAutomaticProfileSwitchAttemptCandidates atomically stores safe decisions.
func (s *Store) ReplaceCodexAutomaticProfileSwitchAttemptCandidates(ctx context.Context, attemptID string, candidates []domain.CodexAutomaticProfileSwitchAttemptCandidate) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `DELETE FROM codex_automatic_profile_switch_attempt_candidates WHERE attempt_id = ?`, attemptID); err != nil {
		return err
	}
	for _, candidate := range candidates {
		if _, err := tx.ExecContext(ctx, `INSERT INTO codex_automatic_profile_switch_attempt_candidates(attempt_id, position, profile_id, reason_code, evaluated_at) VALUES (?, ?, ?, ?, ?)`, attemptID, candidate.Position, candidate.ProfileID, candidate.ReasonCode, candidate.EvaluatedAt); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// UpdateCodexAutomaticProfileSwitchAttempt advances one state-and-revision CAS.
func (s *Store) UpdateCodexAutomaticProfileSwitchAttempt(ctx context.Context, next domain.CodexAutomaticProfileSwitchAttempt, expectedState domain.CodexAutomaticProfileSwitchState, expectedPolicyRevision int64) (bool, error) {
	if !domain.ValidCodexAutomaticProfileSwitchTransition(expectedState, next.State) {
		return false, domain.ErrCodexAutomaticProfileSwitchAttemptConflict
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	result, err := s.writeDB.ExecContext(ctx, `UPDATE codex_automatic_profile_switch_attempts SET policy_revision=?, selected_profile_id=?, selected_profile_position=?, profile_switch_id=?, state=?, outcome_code=?, updated_at=?, completed_at=? WHERE id=? AND state=? AND policy_revision=?`,
		next.PolicyRevision, next.SelectedProfileID, next.SelectedProfilePosition, next.ProfileSwitchID, next.State, next.OutcomeCode, next.UpdatedAt, next.CompletedAt, next.ID, expectedState, expectedPolicyRevision)
	if err != nil {
		return false, err
	}
	n, _ := result.RowsAffected()
	return n == 1, nil
}

// LinkAutomaticAttemptToCodexProfileSwitch delegates exactly one target transactionally.
func (s *Store) LinkAutomaticAttemptToCodexProfileSwitch(ctx context.Context, attempt domain.CodexAutomaticProfileSwitchAttempt, sw domain.CodexProfileSwitch) (domain.CodexAutomaticProfileSwitchAttempt, domain.CodexProfileSwitch, error) {
	if attempt.State != domain.CodexAutomaticProfileSwitchEvaluating || sw.Initiator != domain.CodexProfileSwitchInitiatorAutomatic || sw.AutomaticAttemptID != attempt.ID {
		return attempt, sw, domain.ErrCodexAutomaticProfileSwitchAttemptConflict
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return attempt, sw, err
	}
	defer func() { _ = tx.Rollback() }()
	_, err = tx.ExecContext(ctx, `INSERT INTO codex_profile_switches (
id, source_session_id, target_session_id, source_profile_id, target_profile_id, idempotency_key, request_fingerprint,
trigger_kind, phase, recovery_origin_phase, workspace_owner, source_generation_id, target_generation_id,
target_runtime_handle_id, target_controller_generation, target_provider_thread_id, semantic_handoff_status,
handoff_classification, final_handoff_path, final_handoff_hash, acknowledge_unknown_capacity,
target_acknowledged_at, source_archived_at, requested_at, updated_at, completed_at, error_code,
initiator, automatic_attempt_id, automatic_policy_revision) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		sw.ID, sw.SourceSessionID, sw.TargetSessionID, sw.SourceProfileID, sw.TargetProfileID, sw.IdempotencyKey, sw.RequestFingerprint,
		sw.Trigger, sw.Phase, sw.RecoveryOriginPhase, sw.WorkspaceOwner, sw.SourceGenerationID, sw.TargetGenerationID,
		sw.TargetRuntimeHandleID, sw.TargetControllerGeneration, sw.TargetProviderThreadID, sw.SemanticHandoffStatus,
		sw.HandoffClassification, sw.FinalHandoffPath, sw.FinalHandoffHash, sw.AcknowledgeUnknownCapacity,
		sw.TargetAcknowledgedAt, sw.SourceArchivedAt, sw.RequestedAt, sw.UpdatedAt, sw.CompletedAt, sw.ErrorCode,
		sw.Initiator, sw.AutomaticAttemptID, sw.AutomaticPolicyRevision)
	if err != nil {
		return attempt, sw, err
	}
	nextState := domain.CodexAutomaticProfileSwitchDelegatedToPhase5
	now := sw.UpdatedAt
	result, err := tx.ExecContext(ctx, `UPDATE codex_automatic_profile_switch_attempts SET selected_profile_id=?, selected_profile_position=?, profile_switch_id=?, state=?, outcome_code=?, updated_at=? WHERE id=? AND state='evaluating' AND policy_revision=?`,
		attempt.SelectedProfileID, attempt.SelectedProfilePosition, sw.ID, nextState, domain.CodexAutomaticSwitchOutcomeDelegated, now, attempt.ID, attempt.PolicyRevision)
	if err != nil {
		return attempt, sw, err
	}
	if n, _ := result.RowsAffected(); n != 1 {
		return attempt, sw, domain.ErrCodexAutomaticProfileSwitchAttemptConflict
	}
	if err := tx.Commit(); err != nil {
		return attempt, sw, err
	}
	attempt.ProfileSwitchID = &sw.ID
	attempt.State, attempt.OutcomeCode, attempt.UpdatedAt = nextState, domain.CodexAutomaticSwitchOutcomeDelegated, now
	return attempt, sw, nil
}
