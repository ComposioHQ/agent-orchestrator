package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/terminalticket"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// TerminalTicketStore persists one-time terminal ticket verifiers.
type TerminalTicketStore struct{ store *Store }

// NewTerminalTicketStore binds terminal ticket persistence to the cloud store.
func NewTerminalTicketStore(store *Store) *TerminalTicketStore {
	return &TerminalTicketStore{store: store}
}

var _ terminalticket.Store = (*TerminalTicketStore)(nil)

// Insert persists a terminal ticket verifier.
func (s *TerminalTicketStore) Insert(ctx context.Context, record terminalticket.Record) error {
	return s.store.withRuntimeTx(ctx, record.Binding.WorkspaceID, func(tx pgx.Tx, identity tenant.Identity) error {
		if identity.OrgID != record.Binding.OrgID {
			return tenant.ErrNoTenant
		}
		scopes := make([]string, len(record.Scopes))
		for i, scope := range record.Scopes {
			scopes[i] = string(scope)
		}
		_, err := tx.Exec(ctx, `INSERT INTO ao_terminal_tickets(id,org_id,owner_user_id,workspace_id,session_id,sandbox_id,scopes,verifier,issued_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, record.ID, record.Binding.OrgID, identity.UserID, record.Binding.WorkspaceID, record.Binding.SessionID, record.Binding.SandboxID, scopes, record.Verifier, record.IssuedAt.UTC(), record.ExpiresAt.UTC())
		return normalizeTicketError(err)
	})
}

// Consume atomically redeems one unexpired ticket for its exact binding.
func (s *TerminalTicketStore) Consume(ctx context.Context, verifier string, binding terminalticket.Binding, now time.Time) (out terminalticket.Record, err error) {
	err = s.store.withRuntimeTx(ctx, binding.WorkspaceID, func(tx pgx.Tx, identity tenant.Identity) error {
		if identity.OrgID != binding.OrgID {
			return tenant.ErrNoTenant
		}
		var scopes []string
		row := tx.QueryRow(ctx, `UPDATE ao_terminal_tickets SET consumed_at=$1 WHERE verifier=$2 AND org_id=$3 AND owner_user_id=$4 AND workspace_id=$5 AND session_id=$6 AND sandbox_id=$7 AND consumed_at IS NULL AND expires_at>$1 RETURNING id,org_id::text,workspace_id::text,session_id,sandbox_id,scopes,verifier,issued_at,expires_at,consumed_at`, now.UTC(), verifier, binding.OrgID, identity.UserID, binding.WorkspaceID, binding.SessionID, binding.SandboxID)
		if e := row.Scan(&out.ID, &out.Binding.OrgID, &out.Binding.WorkspaceID, &out.Binding.SessionID, &out.Binding.SandboxID, &scopes, &out.Verifier, &out.IssuedAt, &out.ExpiresAt, &out.ConsumedAt); e != nil {
			if errors.Is(e, pgx.ErrNoRows) {
				return terminalticket.ErrInvalid
			}
			return normalizeTicketError(e)
		}
		out.Scopes = make([]terminalticket.Scope, len(scopes))
		for i, scope := range scopes {
			out.Scopes[i] = terminalticket.Scope(scope)
		}
		return nil
	})
	return out, err
}

// DeleteExpired removes expired or previously consumed tickets.
func (s *TerminalTicketStore) DeleteExpired(ctx context.Context, before time.Time) (deleted int, err error) {
	err = s.store.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, _ tenant.Identity) error {
		result, e := tx.Exec(ctx, `DELETE FROM ao_terminal_tickets WHERE expires_at<$1 OR consumed_at<$1`, before.UTC())
		if e != nil {
			return normalizeTicketError(e)
		}
		deleted = int(result.RowsAffected())
		return nil
	})
	return deleted, err
}

func normalizeTicketError(err error) error {
	err = normalizeError(err)
	if errors.Is(err, ErrConflict) {
		return terminalticket.ErrConflict
	}
	return err
}
