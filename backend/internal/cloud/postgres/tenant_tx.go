package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// withTenantTx is the shared tenant transaction boundary used by hosted
// product adapters. inTenantTx owns transaction-local RLS configuration and
// nested transaction reuse; this wrapper also provides the resolved identity
// needed by tenant-keyed SQL without duplicating transaction setup.
func (s *Store) withTenantTx(
	ctx context.Context,
	opts pgx.TxOptions,
	fn func(pgx.Tx, tenant.Identity) error,
) error {
	identity, ok := tenant.FromContext(ctx)
	if !ok {
		return tenant.ErrNoTenant
	}
	return s.inTenantTx(ctx, opts, func(tx pgx.Tx) error {
		return fn(tx, identity)
	})
}
