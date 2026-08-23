package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/credentials"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

type credentialScanner interface{ Scan(...any) error }

func beginCredentialTx(ctx context.Context, pool interface {
	BeginTx(context.Context, pgx.TxOptions) (pgx.Tx, error)
}, readOnly bool) (pgx.Tx, error) {
	identity, ok := tenant.FromContext(ctx)
	if !ok {
		return nil, tenant.ErrNoTenant
	}
	options := pgx.TxOptions{}
	if readOnly {
		options.AccessMode = pgx.ReadOnly
	}
	tx, err := pool.BeginTx(ctx, options)
	if err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx,
		`SELECT set_config('ao.user_id', $1, true), set_config('ao.org_id', $2, true)`,
		identity.UserID, identity.OrgID,
	); err != nil {
		_ = tx.Rollback(ctx)
		return nil, err
	}
	return tx, nil
}

// PutCredential creates or optimistically rotates one tenant-owned ciphertext record.
func (s *Store) PutCredential(ctx context.Context, put credentials.PutCredential) (credentials.CredentialRecord, error) {
	tx, err := beginCredentialTx(ctx, s.pool, false)
	if err != nil {
		return credentials.CredentialRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	row := tx.QueryRow(ctx,
		`SELECT * FROM ao_put_harness_credential(
		    $1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12, $13
		)`,
		put.Record.ID, put.Record.Name, string(put.Record.Provider), []byte(put.Record.Metadata),
		put.Record.Material.Ciphertext, put.Record.Material.EncryptedDataKey, put.Record.Material.Nonce,
		put.Record.Material.KeyID, put.Record.PlaintextBytes, put.Record.Version, put.ExpectedVersion,
		credentials.MaxStoredBytesPerUser, credentials.MaxStoredBytesPerOrg,
	)
	record, err := scanCredential(row)
	if err != nil {
		normalized := normalizeCredentialError(err)
		if errors.Is(normalized, credentials.ErrDeliveryInFlight) {
			normalized = credentials.ErrConflict
		}
		return credentials.CredentialRecord{}, normalized
	}
	if err := tx.Commit(ctx); err != nil {
		return credentials.CredentialRecord{}, normalizeCredentialError(err)
	}
	return record, nil
}

// ListCredentials returns only RLS-visible redacted metadata.
func (s *Store) ListCredentials(ctx context.Context) ([]credentials.Metadata, error) {
	tx, err := beginCredentialTx(ctx, s.pool, true)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	rows, err := tx.Query(ctx,
		`SELECT id, name, provider, metadata, version, created_at, updated_at, revoked_at
		   FROM ao_harness_credentials ORDER BY provider`,
	)
	if err != nil {
		return nil, normalizeCredentialError(err)
	}
	defer rows.Close()
	result := make([]credentials.Metadata, 0)
	for rows.Next() {
		var item credentials.Metadata
		var provider string
		var metadata []byte
		var revokedAt *time.Time
		if err := rows.Scan(&item.ID, &item.Name, &provider, &metadata, &item.Version, &item.CreatedAt, &item.UpdatedAt, &revokedAt); err != nil {
			return nil, normalizeCredentialError(err)
		}
		item.Provider = credentials.Provider(provider)
		item.Metadata = append(json.RawMessage(nil), metadata...)
		if revokedAt != nil {
			item.RevokedAt = *revokedAt
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, normalizeCredentialError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, normalizeCredentialError(err)
	}
	return result, nil
}

// GetCredential returns one RLS-visible ciphertext record for internal rotation.
func (s *Store) GetCredential(ctx context.Context, provider credentials.Provider) (credentials.CredentialRecord, error) {
	tx, err := beginCredentialTx(ctx, s.pool, true)
	if err != nil {
		return credentials.CredentialRecord{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	record, err := scanCredential(tx.QueryRow(ctx,
		`SELECT id, org_id, owner_user_id, name, provider, metadata, ciphertext,
		        encrypted_data_key, nonce, key_id, plaintext_bytes, version,
		        created_at, updated_at, revoked_at
		   FROM ao_harness_credentials WHERE provider = $1`, string(provider)))
	if err != nil {
		return credentials.CredentialRecord{}, normalizeCredentialError(err)
	}
	if err := tx.Commit(ctx); err != nil {
		return credentials.CredentialRecord{}, normalizeCredentialError(err)
	}
	return record, nil
}

// RevokeCredential idempotently revokes a provider credential and audits the transition.
func (s *Store) RevokeCredential(ctx context.Context, provider credentials.Provider) error {
	tx, err := beginCredentialTx(ctx, s.pool, false)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT ao_revoke_harness_credential($1)`, string(provider)); err != nil {
		return normalizeCredentialError(err)
	}
	return normalizeCredentialError(tx.Commit(ctx))
}

// ClaimDelivery performs the durable capability/runtime/workspace authorization join.
func (s *Store) ClaimDelivery(ctx context.Context, lookup credentials.DeliveryLookup, limits credentials.DeliveryLimits) (credentials.DeliveryClaim, error) {
	row := s.pool.QueryRow(ctx,
		`SELECT * FROM ao_claim_harness_credential_delivery(
		    $1, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10, $11
		)`,
		lookup.GrantID(), lookup.OrgID(), lookup.WorkspaceID(), lookup.SessionID(), lookup.Role(),
		string(lookup.Provider()), lookup.IdempotencyKey(), limits.MaxInflightSandbox,
		limits.MaxInflightUser, limits.MaxInflightOrg, credentials.MaxStoredBytesPerSandbox,
	)
	var claim credentials.DeliveryClaim
	var state, provider string
	var metadata []byte
	var revokedAt, acknowledgedAt *time.Time
	var receipt *string
	err := row.Scan(
		&claim.ID, &state, &claim.SandboxID,
		&claim.Credential.ID, &claim.Credential.OrgID, &claim.Credential.OwnerUserID,
		&claim.Credential.Name, &provider, &metadata,
		&claim.Credential.Material.Ciphertext, &claim.Credential.Material.EncryptedDataKey,
		&claim.Credential.Material.Nonce, &claim.Credential.Material.KeyID,
		&claim.Credential.PlaintextBytes, &claim.Credential.Version,
		&claim.Credential.CreatedAt, &claim.Credential.UpdatedAt, &revokedAt,
		&acknowledgedAt, &receipt,
	)
	if err != nil {
		return credentials.DeliveryClaim{}, normalizeCredentialError(err)
	}
	claim.Lookup = lookup
	claim.State = credentials.DeliveryState(state)
	claim.Credential.Provider = credentials.Provider(provider)
	claim.Credential.Metadata = append(json.RawMessage(nil), metadata...)
	if revokedAt != nil {
		claim.Credential.RevokedAt = *revokedAt
	}
	if acknowledgedAt != nil && receipt != nil {
		claim.Acknowledgement = credentials.LoadAcknowledgement{
			IdempotencyKey: lookup.IdempotencyKey(), Provider: lookup.Provider(), Loaded: true,
			LoadedAt: *acknowledgedAt, HarnessReceipt: *receipt,
		}
	}
	return claim, nil
}

// AcknowledgeDelivery records exactly one explicit harness-loaded acknowledgement.
func (s *Store) AcknowledgeDelivery(ctx context.Context, deliveryID string, ack credentials.LoadAcknowledgement) error {
	_, err := s.pool.Exec(ctx,
		`SELECT ao_acknowledge_harness_credential_delivery($1::uuid, $2, $3, $4, $5)`,
		deliveryID, ack.IdempotencyKey, string(ack.Provider), ack.LoadedAt, ack.HarnessReceipt,
	)
	return normalizeCredentialError(err)
}

// RecordDeliveryPurge idempotently records remote purge after acknowledgement.
func (s *Store) RecordDeliveryPurge(ctx context.Context, deliveryID string) error {
	_, err := s.pool.Exec(ctx, `SELECT ao_record_harness_credential_purge($1::uuid)`, deliveryID)
	return normalizeCredentialError(err)
}

// RecordDeliveryFailure records a bounded redacted failure category.
func (s *Store) RecordDeliveryFailure(ctx context.Context, deliveryID string, code credentials.FailureCode) error {
	_, err := s.pool.Exec(ctx, `SELECT ao_record_harness_credential_failure($1::uuid, $2)`, deliveryID, string(code))
	return normalizeCredentialError(err)
}

func scanCredential(row credentialScanner) (credentials.CredentialRecord, error) {
	var record credentials.CredentialRecord
	var provider string
	var metadata []byte
	var revokedAt *time.Time
	err := row.Scan(
		&record.ID, &record.OrgID, &record.OwnerUserID, &record.Name, &provider, &metadata,
		&record.Material.Ciphertext, &record.Material.EncryptedDataKey, &record.Material.Nonce,
		&record.Material.KeyID, &record.PlaintextBytes, &record.Version,
		&record.CreatedAt, &record.UpdatedAt, &revokedAt,
	)
	if err != nil {
		return credentials.CredentialRecord{}, err
	}
	record.Provider = credentials.Provider(provider)
	record.Metadata = append(json.RawMessage(nil), metadata...)
	if revokedAt != nil {
		record.RevokedAt = *revokedAt
	}
	return record, nil
}

func normalizeCredentialError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return credentials.ErrNotFound
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "AO401":
			return credentials.ErrNotAuthorized
		case "AO409":
			return credentials.ErrDeliveryInFlight
		case "AO429":
			return credentials.ErrLimitExceeded
		case "23505":
			return credentials.ErrConflict
		case "23502", "23503", "23514", "22P02":
			return credentials.ErrInvalid
		}
	}
	return fmt.Errorf("credential store operation failed")
}

var (
	_ credentials.CustodyStore  = (*Store)(nil)
	_ credentials.DeliveryStore = (*Store)(nil)
)
