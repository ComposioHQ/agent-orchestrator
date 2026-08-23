package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/credentials"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

func beginCredentialTx(ctx context.Context, pool interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}, readOnly bool) (pgx.Tx, tenant.Identity, error) {
	scope, ok := tenant.FromContext(ctx)
	if !ok {
		return nil, tenant.Identity{}, tenant.ErrNoTenant
	}
	options := pgx.TxOptions{}
	if readOnly {
		options.AccessMode = pgx.ReadOnly
	}
	tx, err := pool.BeginTx(ctx, options)
	if err != nil {
		return nil, tenant.Identity{}, err
	}
	if _, err := tx.Exec(ctx,
		`SELECT set_config('ao.user_id', $1, true), set_config('ao.org_id', $2, true)`,
		scope.UserID, scope.OrgID,
	); err != nil {
		_ = tx.Rollback(ctx)
		return nil, tenant.Identity{}, err
	}
	return tx, scope, nil
}

func (s *Store) Put(ctx context.Context, provider, credentialType string, material credentials.EncryptedMaterial) (credentials.Record, error) {
	tx, scope, err := beginCredentialTx(ctx, s.pool, false)
	if err != nil {
		return credentials.Record{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var record credentials.Record
	err = tx.QueryRow(ctx,
		`INSERT INTO ao_harness_credentials (
		    org_id, owner_user_id, provider, credential_type,
		    ciphertext, encrypted_data_key, nonce, key_id
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		ON CONFLICT (org_id, owner_user_id, provider) DO UPDATE SET
		    credential_type = EXCLUDED.credential_type,
		    ciphertext = EXCLUDED.ciphertext,
		    encrypted_data_key = EXCLUDED.encrypted_data_key,
		    nonce = EXCLUDED.nonce,
		    key_id = EXCLUDED.key_id,
		    version = ao_harness_credentials.version + 1,
		    updated_at = now(),
		    rotated_at = now()
		RETURNING id, org_id, owner_user_id, provider, credential_type,
		          ciphertext, encrypted_data_key, nonce, key_id, version,
		          created_at, updated_at, rotated_at`,
		scope.OrgID, scope.UserID, provider, credentialType,
		material.Ciphertext, material.EncryptedDataKey, material.Nonce, material.KeyID,
	).Scan(
		&record.ID, &record.OrgID, &record.OwnerUserID, &record.Provider, &record.CredentialType,
		&record.Material.Ciphertext, &record.Material.EncryptedDataKey, &record.Material.Nonce, &record.Material.KeyID,
		&record.Version, &record.CreatedAt, &record.UpdatedAt, &record.RotatedAt,
	)
	if err != nil {
		return credentials.Record{}, normalizeCredentialError(err)
	}
	if record.Version > 1 {
		rotated := record.UpdatedAt
		record.RotatedAt = &rotated
	}
	event := "credential.created"
	if record.Version > 1 {
		event = "credential.rotated"
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO ao_harness_credential_audit (
		    org_id, owner_user_id, actor_user_id, credential_id, provider, event, credential_version
		 ) VALUES ($1, $2, $2, $3, $4, $5, $6)`,
		scope.OrgID, scope.UserID, record.ID, record.Provider, event, record.Version,
	); err != nil {
		return credentials.Record{}, normalizeCredentialError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return credentials.Record{}, err
	}
	return record, nil
}

func (s *Store) List(ctx context.Context) ([]credentials.Metadata, error) {
	tx, _, err := beginCredentialTx(ctx, s.pool, true)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx,
		`SELECT id, provider, credential_type, version, created_at, updated_at
		 FROM ao_harness_credentials
		 ORDER BY provider`,
	)
	if err != nil {
		return nil, normalizeCredentialError(err)
	}
	defer rows.Close()
	result := make([]credentials.Metadata, 0)
	for rows.Next() {
		var item credentials.Metadata
		if err := rows.Scan(&item.ID, &item.Provider, &item.CredentialType, &item.Version, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *Store) Get(ctx context.Context, provider string) (credentials.Record, error) {
	tx, _, err := beginCredentialTx(ctx, s.pool, true)
	if err != nil {
		return credentials.Record{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var record credentials.Record
	err = tx.QueryRow(ctx,
		`SELECT id, org_id, owner_user_id, provider, credential_type,
		        ciphertext, encrypted_data_key, nonce, key_id, version,
		        created_at, updated_at, rotated_at
		 FROM ao_harness_credentials WHERE provider = $1`,
		strings.TrimSpace(provider),
	).Scan(
		&record.ID, &record.OrgID, &record.OwnerUserID, &record.Provider, &record.CredentialType,
		&record.Material.Ciphertext, &record.Material.EncryptedDataKey, &record.Material.Nonce, &record.Material.KeyID,
		&record.Version, &record.CreatedAt, &record.UpdatedAt, &record.RotatedAt,
	)
	if err != nil {
		return credentials.Record{}, normalizeCredentialError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return credentials.Record{}, err
	}
	return record, nil
}

func (s *Store) GetForWorkspace(ctx context.Context, orgID, workspaceID, provider, sandboxID string) (credentials.Record, error) {
	var record credentials.Record
	err := s.pool.QueryRow(ctx,
		`SELECT id, org_id, owner_user_id, provider, credential_type,
		        ciphertext, encrypted_data_key, nonce, key_id, version,
		        created_at, updated_at, rotated_at
		 FROM ao_harness_credential_for_workspace($1, $2, $3, $4)`,
		strings.TrimSpace(orgID), strings.TrimSpace(workspaceID), strings.TrimSpace(provider), strings.TrimSpace(sandboxID),
	).Scan(
		&record.ID, &record.OrgID, &record.OwnerUserID, &record.Provider, &record.CredentialType,
		&record.Material.Ciphertext, &record.Material.EncryptedDataKey, &record.Material.Nonce, &record.Material.KeyID,
		&record.Version, &record.CreatedAt, &record.UpdatedAt, &record.RotatedAt,
	)
	if err != nil {
		return credentials.Record{}, normalizeCredentialError(err)
	}
	return record, nil
}

func (s *Store) Delete(ctx context.Context, provider string) error {
	tx, scope, err := beginCredentialTx(ctx, s.pool, false)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var credentialID string
	var version int64
	err = tx.QueryRow(ctx,
		`DELETE FROM ao_harness_credentials WHERE provider = $1 RETURNING id, version`,
		strings.TrimSpace(provider),
	).Scan(&credentialID, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return tx.Commit(ctx)
	}
	if err != nil {
		return normalizeCredentialError(err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO ao_harness_credential_audit (
		    org_id, owner_user_id, actor_user_id, credential_id, provider, event, credential_version
		 ) VALUES ($1, $2, $2, $3, $4, 'credential.revoked', $5)`,
		scope.OrgID, scope.UserID, credentialID, strings.TrimSpace(provider), version,
	); err != nil {
		return normalizeCredentialError(err)
	}
	return tx.Commit(ctx)
}

func (s *Store) Audit(ctx context.Context, credentialID, provider, event string, version int64) error {
	tx, scope, err := beginCredentialTx(ctx, s.pool, false)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	_, err = tx.Exec(ctx,
		`INSERT INTO ao_harness_credential_audit (
		    org_id, owner_user_id, actor_user_id, credential_id, provider, event, credential_version
		) VALUES ($1, $2, $2, $3, $4, $5, $6)`,
		scope.OrgID, scope.UserID, credentialID, provider, event, version,
	)
	if err != nil {
		return normalizeCredentialError(err)
	}
	return tx.Commit(ctx)
}

func (s *Store) AuditWorkspace(ctx context.Context, orgID, workspaceID, sandboxID, provider, event string, version int64) error {
	_, err := s.pool.Exec(ctx,
		`SELECT ao_audit_harness_credential_workspace($1, $2, $3, $4, $5, $6)`,
		strings.TrimSpace(orgID), strings.TrimSpace(workspaceID), strings.TrimSpace(provider),
		strings.TrimSpace(sandboxID), strings.TrimSpace(event), version,
	)
	return normalizeCredentialError(err)
}

func normalizeCredentialError(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return credentials.ErrNotFound
	}
	if err == nil {
		return nil
	}
	return fmt.Errorf("credential store: %w", normalizeError(err))
}
