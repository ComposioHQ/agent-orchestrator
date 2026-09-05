package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

var (
	_ ports.ClaudeCodeAccountStateStore  = (*Store)(nil)
	_ ports.ClaudeCodeAccountSwitchStore = (*Store)(nil)
)

// GetClaudeCodeActiveAccount reads the singleton active-account pointer.
func (s *Store) GetClaudeCodeActiveAccount(ctx context.Context) (domain.ClaudeCodeActiveAccount, bool, error) {
	row, err := s.qr.GetClaudeCodeActiveAccount(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ClaudeCodeActiveAccount{}, false, nil
	}
	if err != nil {
		return domain.ClaudeCodeActiveAccount{}, false, fmt.Errorf("get active Claude Code account: %w", err)
	}
	return domain.ClaudeCodeActiveAccount{
		AccountID:   row.AccountID,
		Revision:    row.Revision,
		ActivatedAt: row.ActivatedAt,
		UpdatedAt:   row.UpdatedAt,
	}, true, nil
}

// SetClaudeCodeActiveAccount atomically creates or advances the active-account pointer.
func (s *Store) SetClaudeCodeActiveAccount(ctx context.Context, accountID string, expectedRevision int64, at time.Time) (domain.ClaudeCodeActiveAccount, error) { //nolint:dupl // Claude uses a separate durable contract from Codex.
	if expectedRevision < 0 || (accountID == "" && expectedRevision == 0) {
		return domain.ClaudeCodeActiveAccount{}, ports.ErrClaudeCodeAccountRevisionConflict
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	var active domain.ClaudeCodeActiveAccount
	err := s.inTx(ctx, "set active Claude Code account", func(q *gen.Queries) error {
		var (
			changed int64
			err     error
		)
		if expectedRevision == 0 {
			changed, err = q.InsertClaudeCodeActiveAccount(ctx, gen.InsertClaudeCodeActiveAccountParams{
				AccountID: accountID, ActivatedAt: at.UTC(), UpdatedAt: at.UTC(),
			})
		} else {
			changed, err = q.UpdateClaudeCodeActiveAccount(ctx, gen.UpdateClaudeCodeActiveAccountParams{
				AccountID: accountID, ActivatedAt: at.UTC(), UpdatedAt: at.UTC(), ExpectedRevision: expectedRevision,
			})
		}
		if err != nil {
			return err
		}
		if changed == 0 {
			return ports.ErrClaudeCodeAccountRevisionConflict
		}
		row, err := q.GetClaudeCodeActiveAccount(ctx)
		if err != nil {
			return fmt.Errorf("read activated Claude Code account: %w", err)
		}
		active = domain.ClaudeCodeActiveAccount{
			AccountID: row.AccountID, Revision: row.Revision,
			ActivatedAt: row.ActivatedAt, UpdatedAt: row.UpdatedAt,
		}
		return nil
	})
	if err != nil {
		return domain.ClaudeCodeActiveAccount{}, err
	}
	return active, nil
}

// CreateClaudeCodeAccountSwitch inserts a durable switch or returns its idempotent predecessor.
func (s *Store) CreateClaudeCodeAccountSwitch(ctx context.Context, rec domain.ClaudeCodeAccountSwitch) (domain.ClaudeCodeAccountSwitch, bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	n, err := s.qw.InsertClaudeCodeAccountSwitch(ctx, gen.InsertClaudeCodeAccountSwitchParams{
		ID: rec.ID, SourceAccountID: rec.SourceAccountID, TargetAccountID: rec.TargetAccountID,
		SwitchPolicy: string(rec.Policy), IdempotencyKey: rec.IdempotencyKey,
		RequestFingerprint: rec.RequestFingerprint, ExpectedAccountRevision: rec.ExpectedAccountRevision,
		Phase: string(rec.Phase), CreatedAt: rec.CreatedAt.UTC(), UpdatedAt: rec.UpdatedAt.UTC(),
	})
	if err != nil {
		return domain.ClaudeCodeAccountSwitch{}, false, fmt.Errorf("create Claude Code account switch %s: %w", rec.ID, err)
	}
	if n > 0 {
		return rec, true, nil
	}

	if row, readErr := s.qw.GetClaudeCodeAccountSwitchByIdempotency(ctx, rec.IdempotencyKey); readErr == nil {
		existing := claudeCodeAccountSwitchFromGen(row)
		if existing.RequestFingerprint == rec.RequestFingerprint {
			return existing, false, nil
		}
		return existing, false, ports.ErrClaudeCodeAccountSwitchIdempotencyConflict
	} else if !errors.Is(readErr, sql.ErrNoRows) {
		return domain.ClaudeCodeAccountSwitch{}, false, fmt.Errorf("read Claude Code switch by idempotency key: %w", readErr)
	}

	if row, readErr := s.qw.GetActiveClaudeCodeAccountSwitch(ctx); readErr == nil {
		return claudeCodeAccountSwitchFromGen(row), false, ports.ErrClaudeCodeAccountSwitchInProgress
	} else if !errors.Is(readErr, sql.ErrNoRows) {
		return domain.ClaudeCodeAccountSwitch{}, false, fmt.Errorf("read active Claude Code switch: %w", readErr)
	}
	return domain.ClaudeCodeAccountSwitch{}, false, ports.ErrClaudeCodeAccountSwitchIdempotencyConflict
}

// GetClaudeCodeAccountSwitch reads a switch by ID.
func (s *Store) GetClaudeCodeAccountSwitch(ctx context.Context, id string) (domain.ClaudeCodeAccountSwitch, bool, error) {
	row, err := s.qr.GetClaudeCodeAccountSwitch(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ClaudeCodeAccountSwitch{}, false, nil
	}
	if err != nil {
		return domain.ClaudeCodeAccountSwitch{}, false, fmt.Errorf("get Claude Code account switch %s: %w", id, err)
	}
	return claudeCodeAccountSwitchFromGen(row), true, nil
}

// GetClaudeCodeAccountSwitchByIdempotency reads a switch by idempotency key.
func (s *Store) GetClaudeCodeAccountSwitchByIdempotency(ctx context.Context, key string) (domain.ClaudeCodeAccountSwitch, bool, error) {
	row, err := s.qr.GetClaudeCodeAccountSwitchByIdempotency(ctx, key)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ClaudeCodeAccountSwitch{}, false, nil
	}
	if err != nil {
		return domain.ClaudeCodeAccountSwitch{}, false, fmt.Errorf("get Claude Code account switch by idempotency key: %w", err)
	}
	return claudeCodeAccountSwitchFromGen(row), true, nil
}

// GetActiveClaudeCodeAccountSwitch reads the sole nonterminal switch.
func (s *Store) GetActiveClaudeCodeAccountSwitch(ctx context.Context) (domain.ClaudeCodeAccountSwitch, bool, error) {
	row, err := s.qr.GetActiveClaudeCodeAccountSwitch(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.ClaudeCodeAccountSwitch{}, false, nil
	}
	if err != nil {
		return domain.ClaudeCodeAccountSwitch{}, false, fmt.Errorf("get active Claude Code account switch: %w", err)
	}
	return claudeCodeAccountSwitchFromGen(row), true, nil
}

// UpdateClaudeCodeAccountSwitch applies a compare-and-swap phase transition.
func (s *Store) UpdateClaudeCodeAccountSwitch(ctx context.Context, rec domain.ClaudeCodeAccountSwitch, expected domain.ClaudeCodeAccountSwitchPhase) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	n, err := s.qw.UpdateClaudeCodeAccountSwitchPhase(ctx, gen.UpdateClaudeCodeAccountSwitchPhaseParams{
		NextPhase: string(rec.Phase), FailureCode: rec.FailureCode,
		CredentialsCommittedAt:    timePtrToNull(rec.CredentialsCommittedAt),
		PropagationUncertainUntil: timePtrToNull(rec.PropagationUncertainUntil),
		UpdatedAt:                 rec.UpdatedAt.UTC(), CompletedAt: timePtrToNull(rec.CompletedAt),
		ID: rec.ID, ExpectedPhase: string(expected),
	})
	if err != nil {
		return false, fmt.Errorf("update Claude Code account switch %s: %w", rec.ID, err)
	}
	return n > 0, nil
}

func claudeCodeAccountSwitchFromGen(row gen.ClaudeCodeAccountSwitch) domain.ClaudeCodeAccountSwitch {
	phase := domain.ClaudeCodeAccountSwitchPhase(row.Phase)
	return domain.ClaudeCodeAccountSwitch{
		ID: row.ID, SourceAccountID: row.SourceAccountID, TargetAccountID: row.TargetAccountID,
		Policy: domain.ClaudeCodeAccountSwitchPolicy(row.SwitchPolicy), Phase: phase,
		FailureCode: row.FailureCode, CanRecover: phase == domain.ClaudeCodeAccountSwitchRecoveryRequired,
		CredentialsCommittedAt:    nullTimeToPtr(row.CredentialsCommittedAt),
		PropagationUncertainUntil: nullTimeToPtr(row.PropagationUncertainUntil),
		CreatedAt:                 row.CreatedAt, UpdatedAt: row.UpdatedAt, CompletedAt: nullTimeToPtr(row.CompletedAt),
		IdempotencyKey: row.IdempotencyKey, RequestFingerprint: row.RequestFingerprint,
		ExpectedAccountRevision: row.ExpectedAccountRevision,
	}
}
