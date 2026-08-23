package postgres

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

// UpsertGoogleUser records a verified Google identity and creates its personal
// organization on first sign-in. The organization and owner membership are
// committed atomically.
func (s *Store) UpsertGoogleUser(ctx context.Context, principal domain.Principal) (domain.Principal, error) {
	principal.Provider = "google"
	principal.ExternalID = strings.TrimSpace(principal.ExternalID)
	principal.Email = strings.ToLower(strings.TrimSpace(principal.Email))
	principal.DisplayName = strings.TrimSpace(principal.DisplayName)
	if principal.ExternalID == "" || principal.Email == "" {
		return domain.Principal{}, ErrInvalid
	}
	if principal.DisplayName == "" {
		principal.DisplayName = principal.Email
	}

	if err := s.pool.QueryRow(
		ctx,
		`SELECT ao_upsert_google_user($1, $2, $3)`,
		principal.ExternalID,
		principal.Email,
		principal.DisplayName,
	).Scan(&principal.UserID); err != nil {
		return domain.Principal{}, normalizeError(err)
	}
	return principal, nil
}

// PrincipalByID resolves the current user for an already verified AO access
// token. Memberships are loaded separately and never trusted from token claims.
func (s *Store) PrincipalByID(ctx context.Context, userID string) (domain.Principal, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return domain.Principal{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT set_config('ao.user_id', $1, true)`, strings.TrimSpace(userID)); err != nil {
		return domain.Principal{}, err
	}
	var principal domain.Principal
	err = tx.QueryRow(
		ctx,
		`SELECT id, auth_provider, external_user_id, email, display_name
		 FROM ao_users WHERE id = $1`,
		strings.TrimSpace(userID),
	).Scan(
		&principal.UserID,
		&principal.Provider,
		&principal.ExternalID,
		&principal.Email,
		&principal.DisplayName,
	)
	if err != nil {
		return domain.Principal{}, normalizeError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Principal{}, err
	}
	return principal, nil
}

// CreateRefreshSession persists only a refresh-token digest.
func (s *Store) CreateRefreshSession(ctx context.Context, userID string, tokenHash []byte, expiresAt time.Time) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT set_config('ao.user_id', $1, true)`, strings.TrimSpace(userID)); err != nil {
		return err
	}
	_, err = tx.Exec(
		ctx,
		`WITH expired AS (
			DELETE FROM ao_auth_sessions WHERE expires_at <= now()
		)
		INSERT INTO ao_auth_sessions (user_id, token_hash, expires_at)
		VALUES ($1, $2, $3)`,
		userID,
		tokenHash,
		expiresAt,
	)
	if err != nil {
		return normalizeError(err)
	}
	return tx.Commit(ctx)
}

// RotateRefreshSession consumes an old refresh token and inserts its
// replacement in one transaction. The replacement retains the chain's
// original creation time and absolute expiry. Concurrent replay attempts
// cannot both win.
func (s *Store) RotateRefreshSession(
	ctx context.Context,
	oldHash, newHash []byte,
) (domain.Principal, error) {
	var principal domain.Principal
	if err := s.pool.QueryRow(
		ctx,
		`SELECT user_id, auth_provider, external_user_id, email, display_name
		 FROM ao_rotate_refresh_session($1, $2)`,
		oldHash, newHash,
	).Scan(
		&principal.UserID,
		&principal.Provider,
		&principal.ExternalID,
		&principal.Email,
		&principal.DisplayName,
	); err != nil {
		return domain.Principal{}, normalizeError(err)
	}
	return principal, nil
}

// RevokeRefreshSession removes one refresh-token digest. Revocation is
// idempotent so logout does not reveal whether a token existed.
func (s *Store) RevokeRefreshSession(ctx context.Context, tokenHash []byte) error {
	_, err := s.pool.Exec(ctx, `SELECT ao_revoke_refresh_session($1)`, tokenHash)
	return err
}

// ListMemberships returns all active AO organizations for the current user.
func (s *Store) ListMemberships(ctx context.Context, principal domain.Principal) ([]domain.Membership, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT set_config('ao.user_id', $1, true)`, principal.UserID); err != nil {
		return nil, err
	}
	rows, err := tx.Query(
		ctx,
		`SELECT membership.org_id, organization.slug,
		        organization.display_name, membership.role
		 FROM ao_org_memberships membership
		 JOIN ao_organizations organization ON organization.id = membership.org_id
		 WHERE membership.user_id = $1
		   AND membership.status = 'active'
		   AND organization.status = 'active'
		 ORDER BY organization.created_at, organization.id`,
		principal.UserID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	memberships := make([]domain.Membership, 0)
	for rows.Next() {
		var membership domain.Membership
		if err := rows.Scan(
			&membership.OrgID,
			&membership.OrgSlug,
			&membership.DisplayName,
			&membership.Role,
		); err != nil {
			return nil, err
		}
		memberships = append(memberships, membership)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit membership read: %w", err)
	}
	return memberships, nil
}
