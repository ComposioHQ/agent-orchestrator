package postgres

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
)

// Tenant is the RLS context every SCM read and write runs under. Both fields
// are required: the SCM policies check organization membership *and* that the
// statement targets the organization the caller declared.
type Tenant struct {
	OrgID  string
	UserID string
}

func (t Tenant) valid() bool {
	return strings.TrimSpace(t.OrgID) != "" && strings.TrimSpace(t.UserID) != ""
}

// withTenant runs fn inside a transaction whose RLS settings are scoped to one
// organization and user. set_config is transaction-local, so a pooled
// connection cannot leak tenant context into the next borrower.
func (s *Store) withTenant(ctx context.Context, tenant Tenant, readOnly bool, fn func(pgx.Tx) error) error {
	if !tenant.valid() {
		return ErrInvalid
	}
	options := pgx.TxOptions{}
	if readOnly {
		options.AccessMode = pgx.ReadOnly
	}
	tx, err := s.pool.BeginTx(ctx, options)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(
		ctx,
		`SELECT set_config('ao.user_id', $1, true), set_config('ao.org_id', $2, true)`,
		strings.TrimSpace(tenant.UserID),
		strings.TrimSpace(tenant.OrgID),
	); err != nil {
		return normalizeError(err)
	}
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// CreateSCMInstallState records the digest of a single-use install-redirect
// state. Only org admins can create one, enforced by RLS.
func (s *Store) CreateSCMInstallState(ctx context.Context, tenant Tenant, stateHash []byte, expiresAt time.Time) error {
	if len(stateHash) != 32 {
		return ErrInvalid
	}
	return s.withTenant(ctx, tenant, false, func(tx pgx.Tx) error {
		if _, err := tx.Exec(
			ctx,
			`INSERT INTO ao_scm_install_states (state_hash, org_id, user_id, provider, expires_at)
			 VALUES ($1, $2, $3, 'github', $4)`,
			stateHash, tenant.OrgID, tenant.UserID, expiresAt,
		); err != nil {
			return normalizeError(err)
		}
		return nil
	})
}

// ConsumeSCMInstallState resolves and destroys a pending install state. It
// runs without a tenant context because the redirect from GitHub carries no
// AO session; the state digest is the only credential presented.
func (s *Store) ConsumeSCMInstallState(ctx context.Context, stateHash []byte) (domain.SCMInstallationLink, error) {
	if len(stateHash) != 32 {
		return domain.SCMInstallationLink{}, ErrInvalid
	}
	var link domain.SCMInstallationLink
	if err := s.pool.QueryRow(
		ctx,
		`SELECT org_id, user_id FROM ao_scm_consume_install_state($1)`,
		stateHash,
	).Scan(&link.OrgID, &link.UserID); err != nil {
		return domain.SCMInstallationLink{}, normalizeError(err)
	}
	return link, nil
}

// UpsertSCMInstallation links an installation to the caller's organization, or
// refreshes an existing link. A unique-constraint failure means the
// installation already belongs to a different organization; RLS hides that row
// so the caller learns only that the claim conflicts.
func (s *Store) UpsertSCMInstallation(
	ctx context.Context,
	tenant Tenant,
	installation domain.SCMInstallation,
) (domain.SCMInstallation, error) {
	var stored domain.SCMInstallation
	err := s.withTenant(ctx, tenant, false, func(tx pgx.Tx) error {
		row := tx.QueryRow(
			ctx,
			`INSERT INTO ao_scm_installations (
				org_id, provider, external_installation_id, account_login,
				account_type, app_slug, repository_selection, status, linked_by_user_id
			 ) VALUES ($1, 'github', $2, $3, $4, $5, $6, $7, $8)
			 ON CONFLICT (provider, external_installation_id) DO UPDATE
			 SET account_login = EXCLUDED.account_login,
			     account_type = EXCLUDED.account_type,
			     app_slug = EXCLUDED.app_slug,
			     repository_selection = EXCLUDED.repository_selection,
			     status = EXCLUDED.status,
			     linked_by_user_id = EXCLUDED.linked_by_user_id,
			     updated_at = now()
			 RETURNING id, org_id, provider, external_installation_id, account_login,
			           account_type, app_slug, repository_selection, status,
			           created_at, updated_at`,
			tenant.OrgID,
			installation.ExternalInstallationID,
			strings.TrimSpace(installation.AccountLogin),
			installation.AccountType,
			installation.AppSlug,
			installation.RepositorySelection,
			installation.Status,
			tenant.UserID,
		)
		if err := scanInstallation(row, &stored); err != nil {
			return normalizeError(err)
		}
		return nil
	})
	if err != nil {
		return domain.SCMInstallation{}, err
	}
	return stored, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanInstallation(row rowScanner, into *domain.SCMInstallation) error {
	return row.Scan(
		&into.ID,
		&into.OrgID,
		&into.Provider,
		&into.ExternalInstallationID,
		&into.AccountLogin,
		&into.AccountType,
		&into.AppSlug,
		&into.RepositorySelection,
		&into.Status,
		&into.CreatedAt,
		&into.UpdatedAt,
	)
}

// ListSCMInstallations returns every installation linked to the tenant.
func (s *Store) ListSCMInstallations(ctx context.Context, tenant Tenant) ([]domain.SCMInstallation, error) {
	installations := make([]domain.SCMInstallation, 0)
	err := s.withTenant(ctx, tenant, true, func(tx pgx.Tx) error {
		rows, err := tx.Query(
			ctx,
			`SELECT id, org_id, provider, external_installation_id, account_login,
			        account_type, app_slug, repository_selection, status,
			        created_at, updated_at
			 FROM ao_scm_installations
			 ORDER BY created_at, id`,
		)
		if err != nil {
			return normalizeError(err)
		}
		defer rows.Close()
		for rows.Next() {
			var installation domain.SCMInstallation
			if err := scanInstallation(rows, &installation); err != nil {
				return err
			}
			installations = append(installations, installation)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return installations, nil
}

// DeleteSCMInstallation unlinks an installation and cascades its repository
// allowlist. Revoking the app on GitHub is a separate, user-side action.
func (s *Store) DeleteSCMInstallation(ctx context.Context, tenant Tenant, installationID string) error {
	return s.withTenant(ctx, tenant, false, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `DELETE FROM ao_scm_installations WHERE id = $1`, installationID)
		if err != nil {
			return normalizeError(err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

// SyncSCMRepositories reconciles the repositories an installation can see.
// Repositories that disappeared are dropped, which also drops any allowlist
// entry for them. An existing allowlist decision is never cleared by a sync,
// and `allowNew` only ever widens for repositories the user explicitly picked
// during installation.
func (s *Store) SyncSCMRepositories(
	ctx context.Context,
	tenant Tenant,
	installationID string,
	repositories []domain.SCMRepository,
	allowNew bool,
) error {
	visible := make([]int64, 0, len(repositories))
	for _, repository := range repositories {
		visible = append(visible, repository.ExternalRepositoryID)
	}
	return s.withTenant(ctx, tenant, false, func(tx pgx.Tx) error {
		for _, repository := range repositories {
			fullName := strings.ToLower(strings.TrimSpace(repository.FullName))
			if fullName == "" || repository.ExternalRepositoryID <= 0 {
				continue
			}
			if _, err := tx.Exec(
				ctx,
				`INSERT INTO ao_scm_repositories (
					installation_id, org_id, external_repository_id, full_name,
					private, allowed, allowed_by_user_id, allowed_at
				 ) VALUES (
					$1, $2, $3, $4, $5, $6,
					CASE WHEN $6 THEN $7::UUID END,
					CASE WHEN $6 THEN now() END
				 )
				 ON CONFLICT (installation_id, external_repository_id) DO UPDATE
				 SET full_name = EXCLUDED.full_name,
				     private = EXCLUDED.private,
				     allowed = ao_scm_repositories.allowed OR EXCLUDED.allowed,
				     allowed_by_user_id = CASE
				         WHEN ao_scm_repositories.allowed THEN ao_scm_repositories.allowed_by_user_id
				         ELSE EXCLUDED.allowed_by_user_id END,
				     allowed_at = CASE
				         WHEN ao_scm_repositories.allowed THEN ao_scm_repositories.allowed_at
				         ELSE EXCLUDED.allowed_at END,
				     updated_at = now()`,
				installationID,
				tenant.OrgID,
				repository.ExternalRepositoryID,
				fullName,
				repository.Private,
				allowNew,
				tenant.UserID,
			); err != nil {
				return normalizeError(err)
			}
		}
		if _, err := tx.Exec(
			ctx,
			`DELETE FROM ao_scm_repositories
			 WHERE installation_id = $1
			   AND NOT (external_repository_id = ANY($2::BIGINT[]))`,
			installationID, visible,
		); err != nil {
			return normalizeError(err)
		}
		return nil
	})
}

// SetSCMRepositoryAllowlist replaces the allowlist for one installation. Every
// repository not named is denied, so the call is a full replacement rather
// than an additive grant.
func (s *Store) SetSCMRepositoryAllowlist(
	ctx context.Context,
	tenant Tenant,
	installationID string,
	allowedExternalIDs []int64,
) error {
	if allowedExternalIDs == nil {
		allowedExternalIDs = []int64{}
	}
	return s.withTenant(ctx, tenant, false, func(tx pgx.Tx) error {
		var installationExists bool
		if err := tx.QueryRow(
			ctx,
			`SELECT EXISTS (SELECT 1 FROM ao_scm_installations WHERE id = $1)`,
			installationID,
		).Scan(&installationExists); err != nil {
			return normalizeError(err)
		}
		if !installationExists {
			return ErrNotFound
		}
		if _, err := tx.Exec(
			ctx,
			`UPDATE ao_scm_repositories
			 SET allowed = external_repository_id = ANY($2::BIGINT[]),
			     allowed_by_user_id = CASE
			         WHEN external_repository_id = ANY($2::BIGINT[]) THEN $3::UUID
			         ELSE NULL END,
			     allowed_at = CASE
			         WHEN external_repository_id = ANY($2::BIGINT[]) THEN coalesce(allowed_at, now())
			         ELSE NULL END,
			     updated_at = now()
			 WHERE installation_id = $1`,
			installationID, allowedExternalIDs, tenant.UserID,
		); err != nil {
			return normalizeError(err)
		}
		return nil
	})
}

// ListSCMRepositories returns every repository known for one installation,
// allowlisted or not, so an admin can see what is available to allow.
func (s *Store) ListSCMRepositories(
	ctx context.Context,
	tenant Tenant,
	installationID string,
) ([]domain.SCMRepository, error) {
	repositories := make([]domain.SCMRepository, 0)
	err := s.withTenant(ctx, tenant, true, func(tx pgx.Tx) error {
		rows, err := tx.Query(
			ctx,
			`SELECT id, installation_id, org_id, external_repository_id, full_name,
			        private, allowed, created_at, updated_at
			 FROM ao_scm_repositories
			 WHERE installation_id = $1
			 ORDER BY full_name`,
			installationID,
		)
		if err != nil {
			return normalizeError(err)
		}
		defer rows.Close()
		for rows.Next() {
			var repository domain.SCMRepository
			if err := rows.Scan(
				&repository.ID,
				&repository.InstallationID,
				&repository.OrgID,
				&repository.ExternalRepositoryID,
				&repository.FullName,
				&repository.Private,
				&repository.Allowed,
				&repository.CreatedAt,
				&repository.UpdatedAt,
			); err != nil {
				return err
			}
			repositories = append(repositories, repository)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return repositories, nil
}

// AllowedSCMRepository resolves one allowlisted repository together with its
// active installation. This is the only lookup the token broker performs, and
// it deliberately returns ErrNotFound for "exists but denied" so a caller
// cannot probe the organization's repository inventory.
func (s *Store) AllowedSCMRepository(
	ctx context.Context,
	tenant Tenant,
	fullName string,
) (domain.SCMInstallation, domain.SCMRepository, error) {
	normalized := strings.ToLower(strings.TrimSpace(fullName))
	var installation domain.SCMInstallation
	var repository domain.SCMRepository
	err := s.withTenant(ctx, tenant, true, func(tx pgx.Tx) error {
		return normalizeError(tx.QueryRow(
			ctx,
			`SELECT installation.id, installation.org_id, installation.provider,
			        installation.external_installation_id, installation.account_login,
			        installation.account_type, installation.app_slug,
			        installation.repository_selection, installation.status,
			        installation.created_at, installation.updated_at,
			        repository.id, repository.external_repository_id,
			        repository.full_name, repository.private
			 FROM ao_scm_repositories repository
			 JOIN ao_scm_installations installation
			   ON installation.id = repository.installation_id
			 WHERE repository.full_name = $1
			   AND repository.allowed
			   AND installation.status = 'active'`,
			normalized,
		).Scan(
			&installation.ID,
			&installation.OrgID,
			&installation.Provider,
			&installation.ExternalInstallationID,
			&installation.AccountLogin,
			&installation.AccountType,
			&installation.AppSlug,
			&installation.RepositorySelection,
			&installation.Status,
			&installation.CreatedAt,
			&installation.UpdatedAt,
			&repository.ID,
			&repository.ExternalRepositoryID,
			&repository.FullName,
			&repository.Private,
		))
	})
	if err != nil {
		return domain.SCMInstallation{}, domain.SCMRepository{}, err
	}
	repository.InstallationID = installation.ID
	repository.OrgID = installation.OrgID
	repository.Allowed = true
	return installation, repository, nil
}

// RecordSCMTokenGrant appends to the brokered-credential audit ledger. No
// token material is written; the row records scope, purpose, and expiry only.
func (s *Store) RecordSCMTokenGrant(ctx context.Context, tenant Tenant, grant domain.SCMTokenGrant) error {
	return s.withTenant(ctx, tenant, false, func(tx pgx.Tx) error {
		var workspaceID any
		if strings.TrimSpace(grant.WorkspaceID) != "" {
			workspaceID = grant.WorkspaceID
		}
		if _, err := tx.Exec(
			ctx,
			`INSERT INTO ao_scm_token_grants (
				org_id, installation_id, repository_id, workspace_id,
				purpose, requested_by_user_id, expires_at
			 ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
			tenant.OrgID,
			grant.InstallationID,
			grant.RepositoryID,
			workspaceID,
			grant.Purpose,
			tenant.UserID,
			grant.ExpiresAt,
		); err != nil {
			return normalizeError(err)
		}
		return nil
	})
}

// RecordSCMWebhookDelivery returns true only the first time a delivery id is
// seen. GitHub retries deliveries, so every side effect must be gated on this.
func (s *Store) RecordSCMWebhookDelivery(
	ctx context.Context,
	deliveryID, event string,
	externalInstallationID int64,
) (bool, error) {
	deliveryID = strings.TrimSpace(deliveryID)
	if deliveryID == "" {
		return false, ErrInvalid
	}
	var first bool
	if err := s.pool.QueryRow(
		ctx,
		`SELECT ao_scm_record_webhook_delivery('github', $1, $2, $3)`,
		deliveryID, strings.TrimSpace(event), externalInstallationID,
	).Scan(&first); err != nil {
		return false, normalizeError(err)
	}
	return first, nil
}

// PruneSCMWebhookDeliveries drops dedup rows older than retain.
func (s *Store) PruneSCMWebhookDeliveries(ctx context.Context, retain time.Duration) (int64, error) {
	if retain <= 0 {
		return 0, ErrInvalid
	}
	var removed int64
	if err := s.pool.QueryRow(
		ctx,
		`SELECT ao_scm_prune_webhook_deliveries(make_interval(secs => $1))`,
		retain.Seconds(),
	).Scan(&removed); err != nil {
		return 0, normalizeError(err)
	}
	return removed, nil
}

// SCMInstallationContext resolves the tenant that owns an installation without
// an authenticated principal. Webhook handling needs it to attribute an event.
func (s *Store) SCMInstallationContext(
	ctx context.Context,
	externalInstallationID int64,
) (domain.SCMInstallation, error) {
	var installation domain.SCMInstallation
	if err := s.pool.QueryRow(
		ctx,
		`SELECT installation_id, org_id, account_login, status
		 FROM ao_scm_installation_context('github', $1)`,
		externalInstallationID,
	).Scan(
		&installation.ID,
		&installation.OrgID,
		&installation.AccountLogin,
		&installation.Status,
	); err != nil {
		return domain.SCMInstallation{}, normalizeError(err)
	}
	installation.Provider = domain.SCMProviderGitHub
	installation.ExternalInstallationID = externalInstallationID
	return installation, nil
}

// SetSCMInstallationStatus applies a webhook-driven lifecycle change.
func (s *Store) SetSCMInstallationStatus(ctx context.Context, externalInstallationID int64, status string) (bool, error) {
	switch status {
	case domain.InstallationStatusActive, domain.InstallationStatusSuspended, domain.InstallationStatusRemoved:
	default:
		return false, ErrInvalid
	}
	var updated bool
	if err := s.pool.QueryRow(
		ctx,
		`SELECT ao_scm_set_installation_status('github', $1, $2)`,
		externalInstallationID, status,
	).Scan(&updated); err != nil {
		return false, normalizeError(err)
	}
	return updated, nil
}

// AddSCMWebhookRepository records a repository a webhook says was added to an
// installation. It always lands denied: only an org admin can allowlist.
func (s *Store) AddSCMWebhookRepository(
	ctx context.Context,
	externalInstallationID, externalRepositoryID int64,
	fullName string,
	private bool,
) (bool, error) {
	var changed bool
	if err := s.pool.QueryRow(
		ctx,
		`SELECT ao_scm_webhook_upsert_repository('github', $1, $2, $3, $4)`,
		externalInstallationID, externalRepositoryID,
		strings.ToLower(strings.TrimSpace(fullName)), private,
	).Scan(&changed); err != nil {
		return false, normalizeError(err)
	}
	return changed, nil
}

// RemoveSCMWebhookRepository drops a repository, and with it any allowlist
// entry, when a webhook reports it left the installation.
func (s *Store) RemoveSCMWebhookRepository(
	ctx context.Context,
	externalInstallationID, externalRepositoryID int64,
) (bool, error) {
	var removed bool
	if err := s.pool.QueryRow(
		ctx,
		`SELECT ao_scm_webhook_remove_repository('github', $1, $2)`,
		externalInstallationID, externalRepositoryID,
	).Scan(&removed); err != nil {
		return false, normalizeError(err)
	}
	return removed, nil
}

// IsConflict reports whether an error is a uniqueness conflict. Callers map it
// to a domain-specific meaning; the constraint name is never surfaced to a
// client.
func IsConflict(err error) bool { return errors.Is(err, ErrConflict) }

// SCMInstallationByID resolves one installation inside the tenant scope.
func (s *Store) SCMInstallationByID(
	ctx context.Context,
	tenant Tenant,
	installationID string,
) (domain.SCMInstallation, error) {
	var installation domain.SCMInstallation
	err := s.withTenant(ctx, tenant, true, func(tx pgx.Tx) error {
		return normalizeError(scanInstallation(tx.QueryRow(
			ctx,
			`SELECT id, org_id, provider, external_installation_id, account_login,
			        account_type, app_slug, repository_selection, status,
			        created_at, updated_at
			 FROM ao_scm_installations
			 WHERE id = $1`,
			installationID,
		), &installation))
	})
	if err != nil {
		return domain.SCMInstallation{}, err
	}
	return installation, nil
}
