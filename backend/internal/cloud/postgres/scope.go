package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

type tenantTxContextKey struct{}

// inTenantTx runs one operation under transaction-local tenant settings. The
// settings cannot leak through the connection pool, and RLS remains the final
// authority even when a query omits an explicit organization predicate.
//
// This is also the adapter's atomic CDC/outbox seam. A PostgreSQL CDC hook must
// write its durable outbox row with the pgx.Tx passed to fn, after the product
// mutation and before this function commits. The transaction must remain an
// adapter detail: do not expose pgx.Tx through a service or internal/ports
// contract, emit after commit, or add a second manual change-log write path.
// Until the shared hook is wired, product mutations simply commit here.
func (s *Store) inTenantTx(ctx context.Context, opts pgx.TxOptions, fn func(pgx.Tx) error) error {
	if tx, ok := ctx.Value(tenantTxContextKey{}).(pgx.Tx); ok && tx != nil {
		return fn(tx)
	}
	id, ok := tenant.FromContext(ctx)
	if !ok {
		return tenant.ErrNoTenant
	}
	tx, err := s.pool.BeginTx(ctx, opts)
	if err != nil {
		return fmt.Errorf("begin tenant transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx,
		`SELECT set_config('ao.user_id', $1, true), set_config('ao.org_id', $2, true)`,
		id.UserID, id.OrgID,
	); err != nil {
		return fmt.Errorf("apply tenant scope: %w", normalizeError(err))
	}
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tenant transaction: %w", err)
	}
	return nil
}

func (s *Store) inTenantRead(ctx context.Context, fn func(pgx.Tx) error) error {
	return s.inTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, fn)
}

func (s *Store) inTenantWrite(ctx context.Context, fn func(pgx.Tx) error) error {
	return s.inTenantTx(ctx, pgx.TxOptions{}, fn)
}
