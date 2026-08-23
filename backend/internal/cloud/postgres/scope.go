package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// withTenantTx is the single transaction boundary for tenant-scoped product
// persistence. Transaction-local settings cannot leak through the pool, and
// the identity is also passed to the operation so writes can predicate keys
// explicitly while forced RLS remains the final isolation boundary.
func (s *Store) withTenantTx(
	ctx context.Context,
	opts pgx.TxOptions,
	fn func(pgx.Tx, tenant.Identity) error,
) error {
	identity, ok := tenant.FromContext(ctx)
	if !ok {
		return tenant.ErrNoTenant
	}
	tx, err := s.pool.BeginTx(ctx, opts)
	if err != nil {
		return fmt.Errorf("begin tenant transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(
		ctx,
		`SELECT set_config('ao.user_id', $1, true), set_config('ao.org_id', $2, true)`,
		identity.UserID,
		identity.OrgID,
	); err != nil {
		return fmt.Errorf("apply tenant scope: %w", normalizeError(err))
	}
	if err := fn(tx, identity); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tenant transaction: %w", err)
	}
	return nil
}
