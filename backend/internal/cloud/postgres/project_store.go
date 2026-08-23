package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	storageports "github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// projectColumns is the read projection shared by every project query, so a new
// column cannot be added to one read path and forgotten in another.
const projectColumns = `id, path, repo_origin_url, display_name, kind, config, registered_at, archived_at`

// ListProjects returns the tenant's active projects ordered by id.
func (s *Store) ListProjects(ctx context.Context) ([]domain.ProjectRecord, error) {
	var out []domain.ProjectRecord
	err := s.inTenantRead(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(
			ctx,
			`SELECT `+projectColumns+`
			 FROM ao_projects
			 WHERE archived_at IS NULL
			 ORDER BY id`,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		out, err = collectProjects(rows)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("list projects: %w", normalizeStorageError(err))
	}
	return out, nil
}

// CountProjectsIncludingArchived counts every registry row for the tenant.
func (s *Store) CountProjectsIncludingArchived(ctx context.Context) (int, error) {
	var count int
	if err := s.inTenantRead(ctx, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM ao_projects`).Scan(&count)
	}); err != nil {
		return 0, fmt.Errorf("count projects including archived: %w", normalizeStorageError(err))
	}
	return count, nil
}

// GetProject returns one project, active or archived.
func (s *Store) GetProject(ctx context.Context, id string) (domain.ProjectRecord, bool, error) {
	return s.selectProject(ctx, "get project "+id,
		`SELECT `+projectColumns+` FROM ao_projects WHERE id = $1`, id)
}

// FindProjectByPath returns the tenant's ACTIVE project at path. Archived rows
// stay invisible here so a user can re-register a path they archived.
func (s *Store) FindProjectByPath(ctx context.Context, path string) (domain.ProjectRecord, bool, error) {
	return s.selectProject(ctx, "find project by path "+path,
		`SELECT `+projectColumns+` FROM ao_projects WHERE path = $1 AND archived_at IS NULL`, path)
}

func (s *Store) selectProject(ctx context.Context, what, query string, arg any) (domain.ProjectRecord, bool, error) {
	var rec domain.ProjectRecord
	found := false
	err := s.inTenantRead(ctx, func(tx pgx.Tx) error {
		row, err := scanProject(tx.QueryRow(ctx, query, arg))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		rec, found = row, true
		return nil
	})
	if err != nil {
		return domain.ProjectRecord{}, false, fmt.Errorf("%s: %w", what, normalizeStorageError(err))
	}
	return rec, found, nil
}

// UpsertProject inserts or replaces one project row.
func (s *Store) UpsertProject(ctx context.Context, rec domain.ProjectRecord) error {
	config, err := marshalProjectConfig(rec.Config)
	if err != nil {
		return err
	}
	if err := s.inTenantWrite(ctx, func(tx pgx.Tx) error {
		return upsertProject(ctx, tx, rec, config)
	}); err != nil {
		return fmt.Errorf("upsert project %s: %w", rec.ID, normalizeStorageError(err))
	}
	return nil
}

// UpsertWorkspaceProject writes a workspace project and its child repo registry
// in one transaction. The supplied child set is authoritative: children absent
// from it are deleted, so a half-applied write can never leave a workspace
// pointing at repositories that are no longer registered.
func (s *Store) UpsertWorkspaceProject(
	ctx context.Context,
	rec domain.ProjectRecord,
	repos []domain.WorkspaceRepoRecord,
) error {
	config, err := marshalProjectConfig(rec.Config)
	if err != nil {
		return err
	}
	if err := s.inTenantWrite(ctx, func(tx pgx.Tx) error {
		if err := upsertProject(ctx, tx, rec, config); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM ao_workspace_repos WHERE project_id = $1`, rec.ID); err != nil {
			return err
		}
		return insertWorkspaceRepos(ctx, tx, rec.ID, repos)
	}); err != nil {
		return fmt.Errorf("upsert workspace project %s: %w", rec.ID, normalizeStorageError(err))
	}
	return nil
}

// ListWorkspaceRepos returns a workspace project's registered children.
func (s *Store) ListWorkspaceRepos(ctx context.Context, projectID string) ([]domain.WorkspaceRepoRecord, error) {
	out := make([]domain.WorkspaceRepoRecord, 0)
	err := s.inTenantRead(ctx, func(tx pgx.Tx) error {
		rows, err := tx.Query(
			ctx,
			`SELECT project_id, name, relative_path, repo_origin_url,
			        default_branch, registered_at, git_status
			 FROM ao_workspace_repos
			 WHERE project_id = $1
			 ORDER BY name`,
			projectID,
		)
		if err != nil {
			return err
		}
		defer rows.Close()
		out = out[:0]
		for rows.Next() {
			var repo domain.WorkspaceRepoRecord
			var gitStatus string
			if err := rows.Scan(
				&repo.ProjectID, &repo.Name, &repo.RelativePath, &repo.RepoOriginURL,
				&repo.DefaultBranch, &repo.RegisteredAt, &gitStatus,
			); err != nil {
				return err
			}
			repo.RegisteredAt = repo.RegisteredAt.UTC()
			repo.GitStatus = domain.GitStatus(gitStatus)
			out = append(out, repo)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, fmt.Errorf("list workspace repos for %s: %w", projectID, normalizeStorageError(err))
	}
	return out, nil
}

// UpdateProjectSettings updates the display name and config of an ACTIVE
// project. ok is false when the project is missing or archived.
func (s *Store) UpdateProjectSettings(
	ctx context.Context,
	id, displayName string,
	config domain.ProjectConfig,
) (bool, error) {
	encoded, err := marshalProjectConfig(config)
	if err != nil {
		return false, err
	}
	var updated int64
	if err := s.inTenantWrite(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(
			ctx,
			`UPDATE ao_projects
			 SET display_name = $2, config = $3, updated_at = now()
			 WHERE id = $1 AND archived_at IS NULL`,
			id, displayName, encoded,
		)
		updated = tag.RowsAffected()
		return err
	}); err != nil {
		return false, fmt.Errorf("update project settings %s: %w", id, normalizeStorageError(err))
	}
	return updated > 0, nil
}

// ArchiveProject soft-deletes an active project. ok is false when nothing
// matched, which covers both a missing project and an already-archived one.
func (s *Store) ArchiveProject(ctx context.Context, id string, at time.Time) (bool, error) {
	var updated int64
	if err := s.inTenantWrite(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(
			ctx,
			`UPDATE ao_projects
			 SET archived_at = $2, updated_at = now()
			 WHERE id = $1 AND archived_at IS NULL`,
			id, at.UTC(),
		)
		updated = tag.RowsAffected()
		return err
	}); err != nil {
		return false, fmt.Errorf("archive project %s: %w", id, normalizeStorageError(err))
	}
	return updated > 0, nil
}

func upsertProject(ctx context.Context, tx pgx.Tx, rec domain.ProjectRecord, config []byte) error {
	_, err := tx.Exec(
		ctx,
		`INSERT INTO ao_projects (
			org_id, id, owner_user_id, path, repo_origin_url, display_name,
			kind, config, registered_at, archived_at
		) VALUES (
			ao_current_org_id(), $1, ao_current_user_id(), $2, $3, $4, $5, $6, $7, $8
		)
		ON CONFLICT (org_id, owner_user_id, id) DO UPDATE SET
			path = EXCLUDED.path,
			repo_origin_url = EXCLUDED.repo_origin_url,
			display_name = EXCLUDED.display_name,
			kind = EXCLUDED.kind,
			config = EXCLUDED.config,
			registered_at = EXCLUDED.registered_at,
			archived_at = EXCLUDED.archived_at,
			updated_at = now()`,
		rec.ID,
		rec.Path,
		rec.RepoOriginURL,
		rec.DisplayName,
		string(rec.Kind.WithDefault()),
		config,
		rec.RegisteredAt.UTC(),
		nullTime(rec.ArchivedAt),
	)
	return err
}

// insertWorkspaceRepos writes the whole child set in one statement. A loop of
// single-row inserts would make registering a large monorepo cost one network
// round trip per repository.
func insertWorkspaceRepos(ctx context.Context, tx pgx.Tx, projectID string, repos []domain.WorkspaceRepoRecord) error {
	if len(repos) == 0 {
		return nil
	}
	names := make([]string, len(repos))
	relativePaths := make([]string, len(repos))
	originURLs := make([]string, len(repos))
	defaultBranches := make([]string, len(repos))
	gitStatuses := make([]string, len(repos))
	registeredAt := make([]time.Time, len(repos))
	for i, repo := range repos {
		names[i] = repo.Name
		relativePaths[i] = repo.RelativePath
		originURLs[i] = repo.RepoOriginURL
		defaultBranches[i] = repo.DefaultBranch
		gitStatuses[i] = string(repo.GitStatus.WithDefault())
		registeredAt[i] = repo.RegisteredAt.UTC()
	}
	_, err := tx.Exec(
		ctx,
		`INSERT INTO ao_workspace_repos (
			org_id, owner_user_id, project_id, name, relative_path, repo_origin_url,
			default_branch, git_status, registered_at
		)
		SELECT ao_current_org_id(), ao_current_user_id(), $1, child.name, child.relative_path,
		       child.repo_origin_url, child.default_branch, child.git_status,
		       child.registered_at
		FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::timestamptz[])
			AS child(name, relative_path, repo_origin_url, default_branch, git_status, registered_at)`,
		projectID, names, relativePaths, originURLs, defaultBranches, gitStatuses, registeredAt,
	)
	return err
}

func collectProjects(rows pgx.Rows) ([]domain.ProjectRecord, error) {
	out := make([]domain.ProjectRecord, 0)
	for rows.Next() {
		rec, err := scanProject(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

// scannable is satisfied by both pgx.Row and pgx.Rows, so a single-row lookup
// and a list row decode through exactly the same code.
type scannable interface {
	Scan(dest ...any) error
}

func scanProject(row scannable) (domain.ProjectRecord, error) {
	var (
		rec        domain.ProjectRecord
		kind       string
		config     []byte
		archivedAt *time.Time
	)
	if err := row.Scan(
		&rec.ID, &rec.Path, &rec.RepoOriginURL, &rec.DisplayName,
		&kind, &config, &rec.RegisteredAt, &archivedAt,
	); err != nil {
		return domain.ProjectRecord{}, err
	}
	rec.Kind = domain.ProjectKind(kind).WithDefault()
	rec.RegisteredAt = rec.RegisteredAt.UTC()
	if archivedAt != nil {
		rec.ArchivedAt = archivedAt.UTC()
	}
	rec.Config = unmarshalProjectConfig(config)
	return rec, nil
}

// marshalProjectConfig stores an unset config as SQL NULL. An empty JSON object
// would read back as a config that had been explicitly cleared, which is not
// the same thing as one that was never set.
func marshalProjectConfig(cfg domain.ProjectConfig) ([]byte, error) {
	if cfg.IsZero() {
		return nil, nil
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		return nil, fmt.Errorf("marshal project config: %w", storageports.ErrStorageInvalid)
	}
	return data, nil
}

// unmarshalProjectConfig degrades a damaged config to a zero value rather than
// failing the read. A config corrupted by a direct database edit must not make
// the project unreachable, nor fail an entire ListProjects.
func unmarshalProjectConfig(data []byte) domain.ProjectConfig {
	if len(data) == 0 {
		return domain.ProjectConfig{}
	}
	var cfg domain.ProjectConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return domain.ProjectConfig{}
	}
	return cfg
}

func nullTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	utc := t.UTC()
	return &utc
}
