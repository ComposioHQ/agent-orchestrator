package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"

	storageports "github.com/aoagents/agent-orchestrator/backend/internal/storage/ports"
)

// tenantScope holds the identities every tenant-scoped statement runs under.
type tenantScope struct {
	userID string
	orgID  string
}

// tenantFrom resolves the acting tenant, refusing to run at all when there is
// none. Falling back to an unscoped query would return another tenant's rows,
// so this is deliberately an error rather than an empty result.
func tenantFrom(ctx context.Context) (tenantScope, error) {
	tenant, ok := storageports.TenantFrom(ctx)
	if !ok {
		return tenantScope{}, storageports.ErrTenantRequired
	}
	return tenantScope{userID: tenant.UserID, orgID: tenant.OrgID}, nil
}

// inTenantTx runs fn inside one transaction whose PostgreSQL session variables
// carry the acting tenant. Row-level security reads those variables, so the
// scope travels with the transaction rather than with a WHERE clause a caller
// could forget: even a bare SELECT * inside fn sees only this tenant's rows.
//
// set_config's third argument is true, making the setting local to the
// transaction. That matters because the pool hands connections to unrelated
// requests: a session-level setting would leak one tenant's scope into the
// next request that happened to get the same connection.
func (s *Store) inTenantTx(ctx context.Context, opts pgx.TxOptions, fn func(pgx.Tx) error) error {
	scope, err := tenantFrom(ctx)
	if err != nil {
		return err
	}
	tx, err := s.pool.BeginTx(ctx, opts)
	if err != nil {
		return fmt.Errorf("begin tenant transaction: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback(ctx)
		}
	}()
	if _, err := tx.Exec(
		ctx,
		`SELECT set_config('ao.user_id', $1, true), set_config('ao.org_id', $2, true)`,
		scope.userID,
		scope.orgID,
	); err != nil {
		return fmt.Errorf("apply tenant scope: %w", normalizeError(err))
	}
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tenant transaction: %w", err)
	}
	committed = true
	return nil
}

// inTenantRead is inTenantTx for statements that only read. The read-only
// access mode makes an accidental write inside a read path fail loudly instead
// of committing.
func (s *Store) inTenantRead(ctx context.Context, fn func(pgx.Tx) error) error {
	return s.inTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, fn)
}

// inTenantWrite is inTenantTx for statements that write.
func (s *Store) inTenantWrite(ctx context.Context, fn func(pgx.Tx) error) error {
	return s.inTenantTx(ctx, pgx.TxOptions{}, fn)
}
