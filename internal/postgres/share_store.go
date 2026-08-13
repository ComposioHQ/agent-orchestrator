package postgres

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
	"github.com/jackc/pgx/v5"
)

// newShareToken mints a fresh bearer token for a share link. Only its hash
// is ever persisted (see CreateProjectShareLink); the raw value is returned
// exactly once, to be embedded in the link the creator shares out-of-band.
func newShareToken() (token string, hash []byte, err error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", nil, err
	}
	token = base64.RawURLEncoding.EncodeToString(value)
	sum := sha256.Sum256([]byte(token))
	return token, sum[:], nil
}

const shareLinkColumns = `
	id, org_id, project_id, COALESCE(session_id::text, ''), created_by_user_id,
	role, status, access_scope, recipients, interaction, COALESCE(mode_cap, ''),
	COALESCE(denied_commands, ARRAY[]::text[]), expires_at, created_at, updated_at`

func scanShareLink(row pgx.Row, link *domain.ShareLink) error {
	var recipients []byte
	if err := row.Scan(
		&link.ID, &link.OrgID, &link.ProjectID, &link.SessionID, &link.CreatedByUserID,
		&link.Role, &link.Status, &link.AccessScope, &recipients, &link.Interaction, &link.ModeCap,
		&link.DeniedCommands, &link.ExpiresAt, &link.CreatedAt, &link.UpdatedAt,
	); err != nil {
		return err
	}
	if len(recipients) > 0 {
		if err := json.Unmarshal(recipients, &link.Recipients); err != nil {
			return err
		}
	}
	if link.Recipients == nil {
		link.Recipients = []string{}
	}
	if link.DeniedCommands == nil {
		link.DeniedCommands = []string{}
	}
	return nil
}

// CreateProjectShareLink mints a redeemable link for a project (or, if
// input.SessionID is set, for just one session in it). Any active member of
// the project's org may create one — see the reference implementation this
// mirrors, where sharing is a "member", not an "admin", capability. Returns
// the link and the one-time raw token; only its hash is stored.
func (s *Store) CreateProjectShareLink(
	ctx context.Context,
	principal domain.Principal,
	orgID, projectID string,
	input domain.CreateShareLink,
) (domain.ShareLink, string, error) {
	token, tokenHash, err := newShareToken()
	if err != nil {
		return domain.ShareLink{}, "", err
	}
	recipients, err := json.Marshal(nonNilStrings(input.Recipients))
	if err != nil {
		return domain.ShareLink{}, "", err
	}
	role := input.Role
	if role == "" {
		role = "viewer"
	}
	accessScope := input.AccessScope
	if accessScope == "" {
		accessScope = "anyone"
	}
	interaction := input.Interaction
	if interaction == "" {
		interaction = "view"
	}
	var link domain.ShareLink
	err = s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		return scanShareLink(tx.QueryRow(
			ctx,
			`INSERT INTO ao_project_share_links (
				org_id, project_id, session_id, created_by_user_id, token_hash,
				role, access_scope, recipients, interaction, mode_cap,
				denied_commands, expires_at
			) VALUES (
				$1, $2, NULLIF($3, '')::uuid, $4, $5, $6, $7, $8, $9, NULLIF($10, ''), $11, $12
			)
			RETURNING `+shareLinkColumns,
			orgID, projectID, input.SessionID, principal.UserID, tokenHash,
			role, accessScope, recipients, interaction, input.ModeCap,
			input.DeniedCommands, input.ExpiresAt,
		), &link)
	})
	if err != nil {
		return domain.ShareLink{}, "", fmt.Errorf("create project share link: %w", err)
	}
	return link, token, nil
}

// ListProjectShareLinks returns every share link ever created for a
// project, most recent first, for its owning org's management UI.
func (s *Store) ListProjectShareLinks(
	ctx context.Context,
	principal domain.Principal,
	orgID, projectID string,
) ([]domain.ShareLink, error) {
	var links []domain.ShareLink
	err := s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		rows, err := tx.Query(
			ctx,
			`SELECT `+shareLinkColumns+`
			FROM ao_project_share_links
			WHERE org_id = $1 AND project_id = $2
			ORDER BY created_at DESC`,
			orgID, projectID,
		)
		if err != nil {
			return fmt.Errorf("list project share links: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var link domain.ShareLink
			if err := scanShareLink(rows, &link); err != nil {
				return err
			}
			links = append(links, link)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return links, nil
}

// RevokeProjectShareLink deactivates a link. It does not affect grants
// already redeemed from it — only future redemptions.
func (s *Store) RevokeProjectShareLink(
	ctx context.Context,
	principal domain.Principal,
	orgID, projectID, linkID string,
) error {
	return s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		tag, err := tx.Exec(
			ctx,
			`UPDATE ao_project_share_links
			SET status = 'revoked', updated_at = now()
			WHERE id = $1 AND org_id = $2 AND project_id = $3 AND status = 'active'`,
			linkID, orgID, projectID,
		)
		if err != nil {
			return fmt.Errorf("revoke project share link: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

// RevokeProjectShareGrant revokes a previously redeemed grant, immediately
// cutting off the recipient's access.
func (s *Store) RevokeProjectShareGrant(
	ctx context.Context,
	principal domain.Principal,
	orgID, projectID, grantID string,
) error {
	return s.withTenant(ctx, principal, orgID, func(tx pgx.Tx) error {
		tag, err := tx.Exec(
			ctx,
			`UPDATE ao_project_share_grants
			SET status = 'revoked', updated_at = now()
			WHERE id = $1 AND org_id = $2 AND project_id = $3 AND status = 'active'`,
			grantID, orgID, projectID,
		)
		if err != nil {
			return fmt.Errorf("revoke project share grant: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		return nil
	})
}

const sharedProjectColumns = `
	grant_row.id, grant_row.org_id, grant_row.project_id, COALESCE(grant_row.session_id::text, ''),
	grant_row.user_id, grant_row.shared_by_user_id, grant_row.role, grant_row.status,
	grant_row.redeemed_at, grant_row.updated_at,
	project.id, project.org_id, project.display_name, project.repository_url, project.default_branch,
	project.github_repository_id, project.config, project.created_at, project.updated_at,
	COALESCE(session_row.display_name, ''),
	COALESCE(sharer.email, ''), COALESCE(sharer.display_name, '')`

const sharedProjectFrom = `
	FROM ao_project_share_grants grant_row
	JOIN ao_projects project
		ON project.org_id = grant_row.org_id AND project.id = grant_row.project_id
	LEFT JOIN ao_sessions session_row
		ON session_row.org_id = grant_row.org_id AND session_row.id = grant_row.session_id
	JOIN ao_users sharer ON sharer.id = grant_row.shared_by_user_id`

func scanSharedProject(row pgx.Row) (domain.SharedProject, error) {
	var shared domain.SharedProject
	var githubRepoID *int64
	var config []byte
	if err := row.Scan(
		&shared.Grant.ID, &shared.Grant.OrgID, &shared.Grant.ProjectID, &shared.Grant.SessionID,
		&shared.Grant.UserID, &shared.Grant.SharedByUserID, &shared.Grant.Role, &shared.Grant.Status,
		&shared.Grant.RedeemedAt, &shared.Grant.UpdatedAt,
		&shared.Project.ID, &shared.Project.OrgID, &shared.Project.DisplayName, &shared.Project.RepositoryURL,
		&shared.Project.DefaultBranch, &githubRepoID, &config, &shared.Project.CreatedAt, &shared.Project.UpdatedAt,
		&shared.SessionName,
		&shared.SharedByEmail, &shared.SharedByName,
	); err != nil {
		return domain.SharedProject{}, err
	}
	shared.Project.GitHubRepositoryID = githubRepoID
	shared.Project.Config = config
	shared.SessionID = shared.Grant.SessionID
	return shared, nil
}

// RedeemProjectShareLink activates a share link's token for the calling
// user, creating (or refreshing) their grant. orgID is required because
// tokens are looked up under row-level security scoped to one org at a
// time — the link the client follows always carries its org alongside the
// token for exactly this reason.
func (s *Store) RedeemProjectShareLink(
	ctx context.Context,
	principal domain.Principal,
	orgID, token string,
) (domain.SharedProject, error) {
	sum := sha256.Sum256([]byte(token))
	tokenHash := sum[:]

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return domain.SharedProject{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(
		ctx,
		`SELECT set_config('ao.user_id', $1, true), set_config('ao.org_id', $2, true)`,
		principal.UserID, orgID,
	); err != nil {
		return domain.SharedProject{}, err
	}

	var link domain.ShareLink
	err = scanShareLink(tx.QueryRow(
		ctx,
		`SELECT `+shareLinkColumns+`
		FROM ao_project_share_links
		WHERE token_hash = $1
		  AND org_id = $2
		  AND status = 'active'
		  AND (expires_at IS NULL OR expires_at > now())`,
		tokenHash, orgID,
	), &link)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.SharedProject{}, ErrNotFound
	}
	if err != nil {
		return domain.SharedProject{}, fmt.Errorf("look up share link: %w", err)
	}
	if link.CreatedByUserID == principal.UserID {
		return domain.SharedProject{}, ErrForbidden
	}
	if link.AccessScope == "restricted" && !recipientsAllow(link.Recipients, principal.Email) {
		return domain.SharedProject{}, ErrForbidden
	}

	if _, err := tx.Exec(
		ctx,
		`INSERT INTO ao_project_share_grants (
			share_link_id, org_id, project_id, session_id, user_id, shared_by_user_id, role
		) VALUES (
			$1, $2, $3, NULLIF($4, '')::uuid, $5, $6, $7
		)
		ON CONFLICT (user_id, org_id, project_id, COALESCE(session_id, '00000000-0000-0000-0000-000000000000'::uuid))
			WHERE status = 'active'
		DO UPDATE SET
			share_link_id = EXCLUDED.share_link_id,
			role = EXCLUDED.role,
			shared_by_user_id = EXCLUDED.shared_by_user_id,
			status = 'active',
			redeemed_at = now(),
			updated_at = now()`,
		link.ID, orgID, link.ProjectID, link.SessionID, principal.UserID, link.CreatedByUserID, link.Role,
	); err != nil {
		return domain.SharedProject{}, fmt.Errorf("create project share grant: %w", err)
	}

	shared, err := scanSharedProject(tx.QueryRow(
		ctx,
		`SELECT `+sharedProjectColumns+sharedProjectFrom+`
		WHERE grant_row.org_id = $1 AND grant_row.project_id = $2 AND grant_row.user_id = $3 AND grant_row.status = 'active'
		  AND grant_row.session_id `+nullEqualsClause("$4"),
		orgID, link.ProjectID, principal.UserID, link.SessionID,
	))
	if err != nil {
		return domain.SharedProject{}, fmt.Errorf("load redeemed share grant: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.SharedProject{}, fmt.Errorf("commit redeem project share link: %w", err)
	}
	return shared, nil
}

// nullEqualsClause returns a predicate that matches a nullable UUID column
// against a possibly-empty string parameter: empty means "IS NULL", non-empty
// means "= param::uuid". Postgres has no single operator for that, so this
// builds the two-armed SQL fragment once rather than duplicating it inline.
func nullEqualsClause(param string) string {
	return "IS NOT DISTINCT FROM NULLIF(" + param + ", '')::uuid"
}

func recipientsAllow(recipients []string, email string) bool {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return false
	}
	for _, recipient := range recipients {
		if strings.ToLower(strings.TrimSpace(recipient)) == email {
			return true
		}
	}
	return false
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// ListSharedProjects returns every project (or single session) actively
// shared with the calling user, across every org — including orgs they are
// not a member of. This is the "shared with me" view; it relies on
// ao_project_share_grants' row-level security policy allowing a row to be
// read either by its org or by the user it names (see migration 00021).
func (s *Store) ListSharedProjects(
	ctx context.Context,
	principal domain.Principal,
) ([]domain.SharedProject, error) {
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
		`SELECT `+sharedProjectColumns+sharedProjectFrom+`
		WHERE grant_row.user_id = $1 AND grant_row.status = 'active'
		ORDER BY grant_row.redeemed_at DESC`,
		principal.UserID,
	)
	if err != nil {
		return nil, fmt.Errorf("list shared projects: %w", err)
	}
	defer rows.Close()
	shared := make([]domain.SharedProject, 0)
	for rows.Next() {
		item, err := scanSharedProject(rows)
		if err != nil {
			return nil, err
		}
		shared = append(shared, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return shared, nil
}

// ListSharedProjectSessions lists every session in a project for a caller
// holding a whole-project grant (session_id IS NULL) — a session-scoped
// grant only ever gives access to that one session, never a listing of its
// siblings, so it does not qualify here.
func (s *Store) ListSharedProjectSessions(
	ctx context.Context,
	principal domain.Principal,
	orgID, projectID string,
) ([]domain.Session, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(
		ctx,
		`SELECT set_config('ao.user_id', $1, true), set_config('ao.org_id', $2, true)`,
		principal.UserID, orgID,
	); err != nil {
		return nil, err
	}
	var allowed bool
	if err := tx.QueryRow(
		ctx,
		`SELECT EXISTS (
			SELECT 1 FROM ao_project_share_grants
			WHERE org_id = $1 AND project_id = $2 AND user_id = $3
			  AND status = 'active' AND session_id IS NULL
		)`,
		orgID, projectID, principal.UserID,
	).Scan(&allowed); err != nil {
		return nil, err
	}
	if !allowed {
		return nil, ErrForbidden
	}
	rows, err := tx.Query(
		ctx,
		sessionSelect+` WHERE session.org_id = $1 AND session.project_id = $2 ORDER BY session.updated_at DESC`,
		orgID, projectID,
	)
	if err != nil {
		return nil, fmt.Errorf("list shared project sessions: %w", err)
	}
	defer rows.Close()
	sessions := make([]domain.Session, 0)
	for rows.Next() {
		var session domain.Session
		if err := scanSession(rows, &session); err != nil {
			return nil, err
		}
		sessions = append(sessions, session)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return sessions, nil
}

// withSessionAccess authorizes a session-scoped operation for either an
// active org member (any role — identical to withTenant's own check) or,
// failing that, the holder of an active share grant covering this exact
// session or its whole project. fn receives the resolved access role:
// "member" for an org member, or the grant's "viewer"/"editor" role for a
// shared collaborator, so callers can gate write operations accordingly.
func (s *Store) withSessionAccess(
	ctx context.Context,
	principal domain.Principal,
	orgID, sessionID string,
	fn func(tx pgx.Tx, role string) error,
) error {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if _, err := tx.Exec(
		ctx,
		`SELECT set_config('ao.user_id', $1, true), set_config('ao.org_id', $2, true)`,
		principal.UserID, orgID,
	); err != nil {
		return err
	}

	var isMember bool
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
		orgID, principal.UserID, principal.Provider, principal.ExternalOrgID,
	).Scan(&isMember); err != nil {
		return err
	}

	role := "member"
	if !isMember {
		var projectID string
		err := tx.QueryRow(
			ctx,
			`SELECT project_id FROM ao_sessions WHERE org_id = $1 AND id = $2`,
			orgID, sessionID,
		).Scan(&projectID)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
		err = tx.QueryRow(
			ctx,
			`SELECT role FROM ao_project_share_grants
			WHERE org_id = $1 AND project_id = $2 AND user_id = $3 AND status = 'active'
			  AND (session_id = $4 OR session_id IS NULL)
			ORDER BY (session_id IS NULL)
			LIMIT 1`,
			orgID, projectID, principal.UserID, sessionID,
		).Scan(&role)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrForbidden
		}
		if err != nil {
			return err
		}
	}

	if err := fn(tx, role); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
