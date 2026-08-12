package postgres

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/jackc/pgx/v5"
)

func (s *Store) ListProviderConnections(
	ctx context.Context,
	principal domain.Principal,
	orgID string,
) ([]domain.ProviderConnection, error) {
	connections := make([]domain.ProviderConnection, 0)
	err := s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(
			ctx,
			`SELECT id, org_id, provider, label, config, validation_state,
				validated_at, created_at, updated_at
			FROM ao_provider_connections
			WHERE org_id = $1
			ORDER BY provider, label`,
			orgID,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var connection domain.ProviderConnection
			if err := rows.Scan(
				&connection.ID,
				&connection.OrgID,
				&connection.Provider,
				&connection.Label,
				&connection.Config,
				&connection.ValidationState,
				&connection.ValidatedAt,
				&connection.CreatedAt,
				&connection.UpdatedAt,
			); err != nil {
				return err
			}
			connections = append(connections, connection)
		}
		return rows.Err()
	})
	return connections, err
}

func (s *Store) UpsertProviderConnection(
	ctx context.Context,
	principal domain.Principal,
	orgID, provider, label string,
	encryptedSecret, nonce []byte,
	config json.RawMessage,
) (domain.ProviderConnection, error) {
	var connection domain.ProviderConnection
	err := s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		if err := requireOrgAdmin(ctx, tx, orgID, principal.UserID); err != nil {
			return err
		}
		if err := tx.QueryRow(
			ctx,
			`INSERT INTO ao_provider_connections (
				org_id, provider, label, encrypted_secret, secret_nonce, config,
				validation_state, validated_at
			) VALUES ($1, $2, $3, $4, $5, $6, 'valid', now())
			ON CONFLICT (org_id, provider, label) DO UPDATE
			SET encrypted_secret = EXCLUDED.encrypted_secret,
				secret_nonce = EXCLUDED.secret_nonce,
				config = EXCLUDED.config,
				validation_state = 'valid',
				validated_at = now(),
				updated_at = now()
			RETURNING id, org_id, provider, label, config, validation_state,
				validated_at, created_at, updated_at`,
			orgID,
			provider,
			label,
			encryptedSecret,
			nonce,
			config,
		).Scan(
			&connection.ID,
			&connection.OrgID,
			&connection.Provider,
			&connection.Label,
			&connection.Config,
			&connection.ValidationState,
			&connection.ValidatedAt,
			&connection.CreatedAt,
			&connection.UpdatedAt,
		); err != nil {
			return err
		}
		_, err := tx.Exec(
			ctx,
			`INSERT INTO ao_audit_events (
				org_id, actor_user_id, action, resource_type, resource_id, metadata
			) VALUES (
				$1, $2, 'provider_connection.updated', 'provider_connection', $3,
				jsonb_build_object('provider', $4::text, 'label', $5::text)
			)`,
			orgID,
			principal.UserID,
			connection.ID,
			provider,
			label,
		)
		return err
	})
	return connection, err
}

func (s *Store) DeleteProviderConnection(
	ctx context.Context,
	principal domain.Principal,
	orgID, provider, label string,
) error {
	return s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		if err := requireOrgAdmin(ctx, tx, orgID, principal.UserID); err != nil {
			return err
		}
		command, err := tx.Exec(
			ctx,
			`DELETE FROM ao_provider_connections
			WHERE org_id = $1 AND provider = $2 AND label = $3`,
			orgID,
			provider,
			label,
		)
		if err != nil {
			return err
		}
		if command.RowsAffected() == 0 {
			return ErrNotFound
		}
		_, err = tx.Exec(
			ctx,
			`INSERT INTO ao_audit_events (
				org_id, actor_user_id, action, resource_type, resource_id, metadata
			) VALUES (
				$1, $2, 'provider_connection.deleted', 'provider_connection', $3,
				jsonb_build_object('provider', $3, 'label', $4)
			)`,
			orgID,
			principal.UserID,
			provider,
			label,
		)
		return err
	})
}

func (s *Store) ProviderConnectionSecret(
	ctx context.Context,
	principal domain.Principal,
	orgID, connectionID string,
) (encrypted, nonce []byte, config json.RawMessage, err error) {
	err = s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		scanErr := tx.QueryRow(
			ctx,
			`SELECT encrypted_secret, secret_nonce, config
			FROM ao_provider_connections
			WHERE org_id = $1 AND id = $2 AND validation_state = 'valid'`,
			orgID,
			connectionID,
		).Scan(&encrypted, &nonce, &config)
		if errors.Is(scanErr, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return scanErr
	})
	return encrypted, nonce, config, err
}
