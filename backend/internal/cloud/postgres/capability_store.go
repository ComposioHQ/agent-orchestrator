package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/capability"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// CapabilityStore adapts the shared PostgreSQL pool to capability.Store.
// It is separate from Store because capability and terminal-ticket ports both
// intentionally use Insert/DeleteExpired with different record types.
type CapabilityStore struct{ store *Store }

func NewCapabilityStore(store *Store) *CapabilityStore { return &CapabilityStore{store: store} }

var _ capability.Store = (*CapabilityStore)(nil)

func (s *CapabilityStore) Insert(ctx context.Context, record capability.Record) error {
	normalized, err := record.Scope.Normalize()
	if err != nil {
		return err
	}
	return s.store.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, identity tenant.Identity) error {
		if identity.OrgID != normalized.OrgID {
			return tenant.ErrNoTenant
		}
		operations := make([]string, len(normalized.Operations))
		for i, op := range normalized.Operations {
			operations[i] = string(op)
		}
		_, err := tx.Exec(ctx, `INSERT INTO ao_compute_capabilities
			(id,org_id,owner_user_id,workspace_id,session_id,role,operations,verifier,issued_at,expires_at,revoked_at,rotated_to_id)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULLIF($12,''))`, record.ID, normalized.OrgID, identity.UserID, normalized.WorkspaceID, normalized.SessionID, normalized.Role, operations, record.Verifier, record.IssuedAt.UTC(), record.ExpiresAt.UTC(), nullableTime(record.RevokedAt), record.RotatedToID)
		return normalizeCapabilityError(err)
	})
}

const capabilityColumns = `id,org_id::text,workspace_id::text,session_id,role,operations,verifier,issued_at,expires_at,revoked_at,COALESCE(rotated_to_id,'')`

func scanCapability(row runtimeRowScanner, out *capability.Record) error {
	var operations []string
	var revoked *time.Time
	if err := row.Scan(&out.ID, &out.Scope.OrgID, &out.Scope.WorkspaceID, &out.Scope.SessionID, &out.Scope.Role, &operations, &out.Verifier, &out.IssuedAt, &out.ExpiresAt, &revoked, &out.RotatedToID); err != nil {
		return normalizeCapabilityError(err)
	}
	out.Scope.Operations = make([]capability.Operation, len(operations))
	for i, op := range operations {
		out.Scope.Operations[i] = capability.Operation(op)
	}
	out.IssuedAt = out.IssuedAt.UTC()
	out.ExpiresAt = out.ExpiresAt.UTC()
	if revoked != nil {
		out.RevokedAt = revoked.UTC()
	}
	return nil
}

func (s *CapabilityStore) ByID(ctx context.Context, id string) (out capability.Record, err error) {
	err = s.store.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, _ tenant.Identity) error {
		return scanCapability(tx.QueryRow(ctx, `SELECT `+capabilityColumns+` FROM ao_compute_capabilities WHERE id=$1`, id), &out)
	})
	return out, err
}

func (s *CapabilityStore) Revoke(ctx context.Context, id string, at time.Time, rotatedToID string) error {
	return s.store.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, _ tenant.Identity) error {
		result, err := tx.Exec(ctx, `UPDATE ao_compute_capabilities SET revoked_at=COALESCE(revoked_at,$2),rotated_to_id=COALESCE(rotated_to_id,NULLIF($3,'')) WHERE id=$1`, id, at.UTC(), rotatedToID)
		if err != nil {
			return normalizeCapabilityError(err)
		}
		if result.RowsAffected() == 0 {
			return capability.ErrNotFound
		}
		return nil
	})
}

func (s *CapabilityStore) RevokeScope(ctx context.Context, selector capability.Selector, at time.Time) (changed int, err error) {
	if err = selector.Validate(); err != nil {
		return 0, err
	}
	err = s.store.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, identity tenant.Identity) error {
		if identity.OrgID != selector.OrgID {
			return tenant.ErrNoTenant
		}
		query := `UPDATE ao_compute_capabilities SET revoked_at=$1 WHERE revoked_at IS NULL AND org_id=$2`
		args := []any{at.UTC(), selector.OrgID}
		if selector.WorkspaceID != "" {
			args = append(args, selector.WorkspaceID)
			query += ` AND workspace_id=$3`
		}
		if selector.SessionID != "" {
			args = append(args, selector.SessionID)
			query += ` AND session_id=$4`
		}
		result, e := tx.Exec(ctx, query, args...)
		if e != nil {
			return normalizeCapabilityError(e)
		}
		changed = int(result.RowsAffected())
		return nil
	})
	return changed, err
}

func (s *CapabilityStore) DeleteExpired(ctx context.Context, before time.Time) (deleted int, err error) {
	err = s.store.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, _ tenant.Identity) error {
		result, e := tx.Exec(ctx, `DELETE FROM ao_compute_capabilities WHERE expires_at<$1 OR revoked_at<$1`, before.UTC())
		if e != nil {
			return normalizeCapabilityError(e)
		}
		deleted = int(result.RowsAffected())
		return nil
	})
	return deleted, err
}

func normalizeCapabilityError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return capability.ErrNotFound
	}
	err = normalizeError(err)
	if errors.Is(err, ErrConflict) {
		return capability.ErrConflict
	}
	if errors.Is(err, ErrNotFound) {
		return capability.ErrNotFound
	}
	return err
}
