package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// withProductTenantTx runs one product-store operation with transaction-local
// tenant settings. Product queries additionally predicate on identity.OrgID;
// forced RLS is the final backstop rather than the only tenant boundary.
func (s *Store) withProductTenantTx(
	ctx context.Context,
	options pgx.TxOptions,
	fn func(pgx.Tx, tenant.Identity, ports.ChangeEventRecorder) error,
) error {
	identity, ok := tenant.FromContext(ctx)
	if !ok {
		return tenant.ErrNoTenant
	}
	tx, err := s.pool.BeginTx(ctx, options)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(
		ctx,
		`SELECT set_config('ao.user_id', $1, true), set_config('ao.org_id', $2, true)`,
		identity.UserID,
		identity.OrgID,
	); err != nil {
		return fmt.Errorf("set product tenant context: %w", err)
	}
	recorder := NewChangeEventRecorder(tx, identity.OrgID)
	if err := fn(tx, identity, recorder); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
