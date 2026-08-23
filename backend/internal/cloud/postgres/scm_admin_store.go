package postgres

import (
	"context"
	"errors"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

func (s *Store) withSCMIdentityTx(
	ctx context.Context,
	identity tenant.Identity,
	opts pgx.TxOptions,
	fn func(pgx.Tx) error,
) error {
	if !identity.Valid() {
		return tenant.ErrNoTenant
	}
	return s.withTenantTx(tenant.WithIdentity(ctx, identity), opts, func(tx pgx.Tx, scoped tenant.Identity) error {
		if scoped.OrgID != identity.OrgID || scoped.UserID != identity.UserID {
			return tenant.ErrNoTenant
		}
		return fn(tx)
	})
}

// CreateSCMInstallState stores only the digest of a single-use install state.
func (s *Store) CreateSCMInstallState(ctx context.Context, identity tenant.Identity, stateHash []byte, expiresAt time.Time) error {
	if len(stateHash) != 32 || !expiresAt.After(time.Now()) {
		return ErrInvalid
	}
	return s.withSCMIdentityTx(ctx, identity, pgx.TxOptions{}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO ao_scm_install_states (state_hash, org_id, user_id, provider, expires_at)
			 VALUES ($1, $2, $3, 'github', $4)`,
			stateHash, identity.OrgID, identity.UserID, expiresAt.UTC(),
		)
		return normalizeError(err)
	})
}

// ClaimSCMInstallState binds a validated setup callback to a replaceable OAuth state.
func (s *Store) ClaimSCMInstallState(ctx context.Context, stateHash, oauthHash []byte, externalID int64) (domain.SCMInstallationLink, error) {
	if len(stateHash) != 32 || len(oauthHash) != 32 || externalID <= 0 {
		return domain.SCMInstallationLink{}, ErrInvalid
	}
	var link domain.SCMInstallationLink
	if err := s.pool.QueryRow(ctx,
		`SELECT org_id, user_id FROM ao_scm_claim_install_state($1, $2, $3)`, stateHash, oauthHash, externalID,
	).Scan(&link.OrgID, &link.UserID); err != nil {
		normalized := normalizeError(err)
		if errors.Is(normalized, ErrNotFound) {
			return domain.SCMInstallationLink{}, errors.Join(domain.ErrSCMNotFound, normalized)
		}
		return domain.SCMInstallationLink{}, normalized
	}
	return link, nil
}

// SCMInstallClaim resolves an unexpired OAuth phase without consuming it.
func (s *Store) SCMInstallClaim(ctx context.Context, oauthHash []byte) (domain.SCMInstallationLink, error) {
	if len(oauthHash) != 32 {
		return domain.SCMInstallationLink{}, ErrInvalid
	}
	var link domain.SCMInstallationLink
	if err := s.pool.QueryRow(ctx, `SELECT org_id, user_id, external_installation_id FROM ao_scm_get_install_claim($1)`, oauthHash).
		Scan(&link.OrgID, &link.UserID, &link.ExternalInstallationID); err != nil {
		if errors.Is(normalizeError(err), ErrNotFound) {
			return domain.SCMInstallationLink{}, domain.ErrSCMNotFound
		}
		return domain.SCMInstallationLink{}, normalizeError(err)
	}
	return link, nil
}

// ReleaseSCMInstallClaim makes the original installation state retryable.
func (s *Store) ReleaseSCMInstallClaim(ctx context.Context, oauthHash []byte) error {
	return s.changeSCMInstallClaim(ctx, `SELECT ao_scm_release_install_claim($1)`, oauthHash)
}

// FinalizeSCMInstallState consumes a successfully linked installation state.
func (s *Store) FinalizeSCMInstallState(ctx context.Context, oauthHash []byte) error {
	return s.changeSCMInstallClaim(ctx, `SELECT ao_scm_finalize_install_state($1)`, oauthHash)
}

func (s *Store) changeSCMInstallClaim(ctx context.Context, query string, oauthHash []byte) error {
	if len(oauthHash) != 32 {
		return ErrInvalid
	}
	var changed bool
	if err := s.pool.QueryRow(ctx, query, oauthHash).Scan(&changed); err != nil {
		return normalizeError(err)
	}
	if !changed {
		return domain.ErrSCMNotFound
	}
	return nil
}

// UpsertSCMInstallation links a GitHub installation to exactly one tenant.
func (s *Store) UpsertSCMInstallation(
	ctx context.Context,
	identity tenant.Identity,
	installation domain.SCMInstallation,
) (domain.SCMInstallation, error) {
	var stored domain.SCMInstallation
	err := s.withSCMIdentityTx(ctx, identity, pgx.TxOptions{}, func(tx pgx.Tx) error {
		row := tx.QueryRow(ctx,
			`SELECT id, org_id, provider, external_installation_id, account_login,
				account_type, app_slug, repository_selection, status,
				linked_by_user_id::text, created_at, updated_at
			 FROM ao_scm_upsert_installation($1, $2, $3, $4, $5, $6, $7, $8)`,
			identity.OrgID, identity.UserID, installation.ExternalInstallationID,
			strings.TrimSpace(installation.AccountLogin), installation.AccountType,
			strings.TrimSpace(installation.AppSlug), installation.RepositorySelection,
			installation.Status,
		)
		return normalizeError(scanSCMInstallation(row, &stored))
	})
	if err != nil {
		if errors.Is(err, ErrConflict) {
			return domain.SCMInstallation{}, errors.Join(domain.ErrSCMConflict, err)
		}
		return domain.SCMInstallation{}, err
	}
	return stored, nil
}

type scmRowScanner interface{ Scan(...any) error }

func scanSCMInstallation(row scmRowScanner, installation *domain.SCMInstallation) error {
	return row.Scan(
		&installation.ID, &installation.OrgID, &installation.Provider,
		&installation.ExternalInstallationID, &installation.AccountLogin,
		&installation.AccountType, &installation.AppSlug,
		&installation.RepositorySelection, &installation.Status,
		&installation.LinkedByUserID, &installation.CreatedAt, &installation.UpdatedAt,
	)
}

const scmInstallationColumns = `id, org_id, provider, external_installation_id,
	account_login, account_type, app_slug, repository_selection, status,
	coalesce(linked_by_user_id::text, ''), created_at, updated_at`

// SCMInstallationByID returns one installation visible to the tenant.
func (s *Store) SCMInstallationByID(ctx context.Context, identity tenant.Identity, installationID string) (domain.SCMInstallation, error) {
	var installation domain.SCMInstallation
	err := s.withSCMIdentityTx(ctx, identity, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		return normalizeError(scanSCMInstallation(tx.QueryRow(ctx,
			`SELECT `+scmInstallationColumns+` FROM ao_scm_installations WHERE id = $1`,
			strings.TrimSpace(installationID),
		), &installation))
	})
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return domain.SCMInstallation{}, errors.Join(domain.ErrSCMNotFound, err)
		}
		return domain.SCMInstallation{}, err
	}
	return installation, nil
}

// ListSCMInstallations lists the tenant's linked GitHub installations.
func (s *Store) ListSCMInstallations(ctx context.Context, identity tenant.Identity) ([]domain.SCMInstallation, error) {
	result := make([]domain.SCMInstallation, 0)
	err := s.withSCMIdentityTx(ctx, identity, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT `+scmInstallationColumns+` FROM ao_scm_installations ORDER BY created_at, id`)
		if err != nil {
			return normalizeError(err)
		}
		defer rows.Close()
		for rows.Next() {
			var installation domain.SCMInstallation
			if err := scanSCMInstallation(rows, &installation); err != nil {
				return err
			}
			result = append(result, installation)
		}
		return rows.Err()
	})
	return result, err
}

// DeleteSCMInstallation disconnects a tenant installation and its repositories.
func (s *Store) DeleteSCMInstallation(ctx context.Context, identity tenant.Identity, installationID string) error {
	return s.withSCMIdentityTx(ctx, identity, pgx.TxOptions{}, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM ao_scm_installations WHERE id = $1`, strings.TrimSpace(installationID))
		if err != nil {
			return normalizeError(err)
		}
		if tag.RowsAffected() == 0 {
			return domain.ErrSCMNotFound
		}
		return nil
	})
}

// SyncSCMRepositories reconciles provider visibility without widening access.
func (s *Store) SyncSCMRepositories(
	ctx context.Context,
	identity tenant.Identity,
	installationID string,
	repositories []domain.SCMRepository,
) error {
	visible := make([]int64, 0, len(repositories))
	for _, repository := range repositories {
		if repository.ExternalRepositoryID <= 0 || !validSCMRepositoryName(repository.FullName) {
			return ErrInvalid
		}
		visible = append(visible, repository.ExternalRepositoryID)
	}
	return s.withSCMIdentityTx(ctx, identity, pgx.TxOptions{}, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM ao_scm_installations WHERE id = $1)`, installationID).Scan(&exists); err != nil {
			return normalizeError(err)
		}
		if !exists {
			return domain.ErrSCMNotFound
		}
		for _, repository := range repositories {
			_, err := tx.Exec(ctx,
				`INSERT INTO ao_scm_repositories (
					installation_id, org_id, external_repository_id, full_name, private
				 ) VALUES ($1, $2, $3, $4, $5)
				 ON CONFLICT (installation_id, external_repository_id) DO UPDATE SET
					full_name = EXCLUDED.full_name,
					private = EXCLUDED.private,
					updated_at = clock_timestamp()`,
				installationID, identity.OrgID, repository.ExternalRepositoryID,
				strings.ToLower(strings.TrimSpace(repository.FullName)), repository.Private,
			)
			if err != nil {
				return normalizeError(err)
			}
		}
		_, err := tx.Exec(ctx,
			`DELETE FROM ao_scm_repositories
			 WHERE installation_id = $1
			   AND NOT (external_repository_id = ANY($2::BIGINT[]))`,
			installationID, visible,
		)
		return normalizeError(err)
	})
}

// SetSCMRepositoryAllowlist atomically replaces the installation allowlist.
func (s *Store) SetSCMRepositoryAllowlist(
	ctx context.Context,
	identity tenant.Identity,
	installationID string,
	allowedExternalIDs []int64,
) error {
	if allowedExternalIDs == nil {
		allowedExternalIDs = []int64{}
	}
	return s.withSCMIdentityTx(ctx, identity, pgx.TxOptions{}, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM ao_scm_installations WHERE id = $1)`, installationID).Scan(&exists); err != nil {
			return normalizeError(err)
		}
		if !exists {
			return domain.ErrSCMNotFound
		}
		_, err := tx.Exec(ctx,
			`UPDATE ao_scm_repositories SET
				allowed = external_repository_id = ANY($2::BIGINT[]),
				allowed_by_user_id = CASE WHEN external_repository_id = ANY($2::BIGINT[]) THEN $3::UUID ELSE NULL END,
				allowed_at = CASE
					WHEN external_repository_id = ANY($2::BIGINT[]) THEN coalesce(allowed_at, clock_timestamp())
					ELSE NULL
				END,
				updated_at = clock_timestamp()
			 WHERE installation_id = $1`,
			installationID, allowedExternalIDs, identity.UserID,
		)
		return normalizeError(err)
	})
}

// ListSCMRepositories lists visible repositories and their allowlist state.
func (s *Store) ListSCMRepositories(ctx context.Context, identity tenant.Identity, installationID string) ([]domain.SCMRepository, error) {
	result := make([]domain.SCMRepository, 0)
	err := s.withSCMIdentityTx(ctx, identity, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM ao_scm_installations WHERE id = $1)`, installationID).Scan(&exists); err != nil {
			return normalizeError(err)
		}
		if !exists {
			return domain.ErrSCMNotFound
		}
		rows, err := tx.Query(ctx,
			`SELECT id, installation_id, org_id, external_repository_id,
				full_name, private, allowed, created_at, updated_at
			 FROM ao_scm_repositories WHERE installation_id = $1 ORDER BY full_name`,
			installationID,
		)
		if err != nil {
			return normalizeError(err)
		}
		defer rows.Close()
		for rows.Next() {
			var repository domain.SCMRepository
			if err := rows.Scan(
				&repository.ID, &repository.InstallationID, &repository.OrgID,
				&repository.ExternalRepositoryID, &repository.FullName,
				&repository.Private, &repository.Allowed,
				&repository.CreatedAt, &repository.UpdatedAt,
			); err != nil {
				return err
			}
			result = append(result, repository)
		}
		return rows.Err()
	})
	return result, err
}

// AllowedSCMRepository resolves one active, explicitly allowlisted repository.
func (s *Store) AllowedSCMRepository(
	ctx context.Context,
	identity tenant.Identity,
	fullName string,
) (domain.SCMInstallation, domain.SCMRepository, error) {
	var installation domain.SCMInstallation
	var repository domain.SCMRepository
	err := s.withSCMIdentityTx(ctx, identity, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		return normalizeError(tx.QueryRow(ctx,
			`SELECT installation.id, installation.org_id, installation.provider,
				installation.external_installation_id, installation.account_login,
				installation.account_type, installation.app_slug,
				installation.repository_selection, installation.status,
				coalesce(installation.linked_by_user_id::text, ''),
				installation.created_at, installation.updated_at,
				repository.id, repository.installation_id, repository.org_id,
				repository.external_repository_id, repository.full_name,
				repository.private, repository.allowed,
				repository.created_at, repository.updated_at
			 FROM ao_scm_repositories repository
			 JOIN ao_scm_installations installation ON installation.id = repository.installation_id
			 WHERE repository.full_name = $1
			   AND repository.allowed
			   AND installation.status = 'active'`,
			strings.ToLower(strings.TrimSpace(fullName)),
		).Scan(
			&installation.ID, &installation.OrgID, &installation.Provider,
			&installation.ExternalInstallationID, &installation.AccountLogin,
			&installation.AccountType, &installation.AppSlug,
			&installation.RepositorySelection, &installation.Status,
			&installation.LinkedByUserID, &installation.CreatedAt, &installation.UpdatedAt,
			&repository.ID, &repository.InstallationID, &repository.OrgID,
			&repository.ExternalRepositoryID, &repository.FullName,
			&repository.Private, &repository.Allowed,
			&repository.CreatedAt, &repository.UpdatedAt,
		))
	})
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return domain.SCMInstallation{}, domain.SCMRepository{}, errors.Join(domain.ErrSCMNotFound, err)
		}
		return domain.SCMInstallation{}, domain.SCMRepository{}, err
	}
	return installation, repository, nil
}

// AuthorizeSCMSandbox verifies that a sandbox belongs to the acting tenant and user.
func (s *Store) AuthorizeSCMSandbox(ctx context.Context, identity tenant.Identity, sandboxID string) error {
	var authorized bool
	err := s.withSCMIdentityTx(ctx, identity, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx,
			`SELECT EXISTS (
				SELECT 1 FROM ao_cloud_workspaces workspace
				WHERE workspace.org_id = $1 AND workspace.owner_user_id = $2 AND workspace.sandbox_id = $3
				UNION ALL
				SELECT 1 FROM ao_cloud_session_runtimes runtime
				JOIN ao_cloud_workspaces workspace ON workspace.id = runtime.workspace_id
				WHERE runtime.org_id = $1 AND workspace.owner_user_id = $2 AND runtime.sandbox_id = $3
			)`,
			identity.OrgID, identity.UserID, strings.TrimSpace(sandboxID),
		).Scan(&authorized)
	})
	if err != nil {
		return normalizeError(err)
	}
	if !authorized {
		return errors.New("cloud scm: sandbox is not authorized for this tenant")
	}
	return nil
}

// RecordSCMTokenGrant appends non-secret credential audit metadata.
func (s *Store) RecordSCMTokenGrant(ctx context.Context, identity tenant.Identity, grant domain.SCMTokenGrant) error {
	if grant.OrgID != identity.OrgID || !grant.ExpiresAt.After(time.Now()) {
		return ErrInvalid
	}
	return s.withSCMIdentityTx(ctx, identity, pgx.TxOptions{}, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx,
			`INSERT INTO ao_scm_token_grants (
				org_id, installation_id, repository_id, sandbox_id,
				purpose, requested_by_user_id, expires_at
			 ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			identity.OrgID, grant.InstallationID, grant.RepositoryID,
			strings.TrimSpace(grant.SandboxID), grant.Purpose,
			identity.UserID, grant.ExpiresAt.UTC(),
		)
		return normalizeError(err)
	})
}

// ObserveSCMSignal records one idempotent downstream observation by delivery id.
func (s *Store) ObserveSCMSignal(ctx context.Context, deliveryID string, signal domain.SCMObservationSignal) error {
	var inserted bool
	if err := s.pool.QueryRow(ctx,
		`SELECT ao_scm_record_observation($1, $2, $3, $4, $5, $6, $7, $8)`,
		strings.TrimSpace(deliveryID), signal.ExternalInstallationID,
		strings.ToLower(strings.TrimSpace(signal.Repository)), strings.TrimSpace(signal.Event),
		strings.TrimSpace(signal.Action), signal.PullRequestNumber,
		strings.TrimSpace(signal.PullRequestURL), strings.TrimSpace(signal.HeadSHA),
	).Scan(&inserted); err != nil {
		return normalizeError(err)
	}
	return nil
}

func validSCMRepositoryName(value string) bool {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "" || len(value) > 255 || !utf8.ValidString(value) || strings.Count(value, "/") != 1 {
		return false
	}
	return strings.IndexFunc(value, func(character rune) bool {
		return unicode.IsControl(character) || unicode.IsSpace(character)
	}) < 0
}
