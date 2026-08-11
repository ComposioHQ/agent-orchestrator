package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrNotFound            = errors.New("not found")
	ErrForbidden           = errors.New("forbidden")
	ErrConflict            = errors.New("conflict")
	ErrInvalid             = errors.New("invalid")
	ErrIdempotencyMismatch = errors.New("idempotency key belongs to a different operation")
)

type Store struct {
	pool *pgxpool.Pool
}

func Open(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() {
	s.pool.Close()
}

func (s *Store) Ping(ctx context.Context) error {
	return s.pool.Ping(ctx)
}

type tenantFn func(pgx.Tx) error

func (s *Store) withTenant(
	ctx context.Context,
	principal domain.Principal,
	orgID string,
	fn tenantFn,
) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(
		ctx,
		`SELECT set_config('ao.user_id', $1, true), set_config('ao.org_id', $2, true)`,
		principal.UserID,
		orgID,
	); err != nil {
		return err
	}
	var allowed bool
	if err := tx.QueryRow(
		ctx,
		`SELECT EXISTS (
			SELECT 1
			FROM ao_org_memberships membership
			JOIN ao_organizations organization ON organization.id = membership.org_id
			WHERE membership.org_id = $1
			  AND membership.user_id = $2
			  AND membership.status = 'active'
			  AND organization.status = 'active'
			  AND (
				$3 <> 'workos'
				OR (
					$4 <> ''
					AND organization.auth_provider = 'workos'
					AND organization.external_org_id = $4
				)
				OR (
					$4 = ''
					AND organization.external_org_id IS NULL
					AND organization.owner_user_id = $2
				)
			  )
		)`,
		orgID,
		principal.UserID,
		principal.Provider,
		principal.ExternalOrgID,
	).Scan(&allowed); err != nil {
		return err
	}
	if !allowed {
		return ErrForbidden
	}
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit tenant transaction: %w", err)
	}
	return nil
}
