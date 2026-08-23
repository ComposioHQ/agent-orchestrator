package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	storageports "github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// projectColumns is the read projection shared by every project query, so a new
// column cannot be added to one read path and forgotten in another.
const projectColumns = `id, path, repo_origin_url, display_name, kind, config, registered_at, archived_at`

// ListProjects returns the tenant's active projects ordered by id.
func (s *Store) ListProjects(ctx context.Context) ([]domain.ProjectRecord, error) {
	var out []domain.ProjectRecord
	err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, _ tenant.Identity) error {
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
		return nil, fmt.Errorf("list projects: %w", normalizeError(err))
	}
	return out, nil
}

// CountProjectsIncludingArchived counts every registry row for the tenant.
func (s *Store) CountProjectsIncludingArchived(ctx context.Context) (int, error) {
	var count int
	if err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, _ tenant.Identity) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM ao_projects`).Scan(&count)
	}); err != nil {
		return 0, fmt.Errorf("count projects including archived: %w", normalizeError(err))
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
	err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, _ tenant.Identity) error {
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
		return domain.ProjectRecord{}, false, fmt.Errorf("%s: %w", what, normalizeError(err))
	}
	return rec, found, nil
}

// UpsertProject inserts or replaces one project row.
func (s *Store) UpsertProject(ctx context.Context, rec domain.ProjectRecord) error {
	config, err := marshalProjectConfig(rec.Config)
	if err != nil {
		return err
	}
	if err := s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, _ tenant.Identity) error {
		return upsertProject(ctx, tx, rec, config)
	}); err != nil {
		return fmt.Errorf("upsert project %s: %w", rec.ID, normalizeError(err))
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
	encodedRepos, err := marshalWorkspaceRepos(repos)
	if err != nil {
		return err
	}
	if err := s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, _ tenant.Identity) error {
		if err := upsertProject(ctx, tx, rec, config); err != nil {
			return err
		}
		_, err := tx.Exec(ctx,
			`UPDATE ao_projects SET workspace_repos = $2, updated_at = now() WHERE id = $1`,
			rec.ID, encodedRepos,
		)
		return err
	}); err != nil {
		return fmt.Errorf("upsert workspace project %s: %w", rec.ID, normalizeError(err))
	}
	return nil
}

// ListWorkspaceRepos returns a workspace project's registered children.
func (s *Store) ListWorkspaceRepos(ctx context.Context, projectID string) ([]domain.WorkspaceRepoRecord, error) {
	out := make([]domain.WorkspaceRepoRecord, 0)
	err := s.withTenantTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly}, func(tx pgx.Tx, _ tenant.Identity) error {
		var encoded []byte
		err := tx.QueryRow(ctx,
			`SELECT workspace_repos FROM ao_projects WHERE id = $1`, projectID,
		).Scan(&encoded)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		out, err = unmarshalWorkspaceRepos(encoded)
		return err
	})
	if err != nil {
		return nil, fmt.Errorf("list workspace repos for %s: %w", projectID, normalizeError(err))
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
	if err := s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, _ tenant.Identity) error {
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
		return false, fmt.Errorf("update project settings %s: %w", id, normalizeError(err))
	}
	return updated > 0, nil
}

// ArchiveProject soft-deletes an active project. ok is false when nothing
// matched, which covers both a missing project and an already-archived one.
func (s *Store) ArchiveProject(ctx context.Context, id string, at time.Time) (bool, error) {
	var updated int64
	if err := s.withTenantTx(ctx, pgx.TxOptions{}, func(tx pgx.Tx, _ tenant.Identity) error {
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
		return false, fmt.Errorf("archive project %s: %w", id, normalizeError(err))
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

func marshalWorkspaceRepos(repos []domain.WorkspaceRepoRecord) ([]byte, error) {
	normalized := make([]domain.WorkspaceRepoRecord, len(repos))
	copy(normalized, repos)
	for i := range normalized {
		normalized[i].GitStatus = normalized[i].GitStatus.WithDefault()
		normalized[i].RegisteredAt = normalized[i].RegisteredAt.UTC()
	}
	data, err := json.Marshal(normalized)
	if err != nil {
		return nil, fmt.Errorf("marshal workspace repos: %w", storageports.ErrStorageInvalid)
	}
	return data, nil
}

func unmarshalWorkspaceRepos(data []byte) ([]domain.WorkspaceRepoRecord, error) {
	if len(data) == 0 {
		return []domain.WorkspaceRepoRecord{}, nil
	}
	var repos []domain.WorkspaceRepoRecord
	if err := json.Unmarshal(data, &repos); err != nil {
		return nil, fmt.Errorf("unmarshal workspace repos: %w", storageports.ErrStorageInvalid)
	}
	sort.Slice(repos, func(i, j int) bool { return repos[i].Name < repos[j].Name })
	if repos == nil {
		repos = []domain.WorkspaceRepoRecord{}
	}
	return repos, nil
}

func nullTime(t time.Time) *time.Time {
	if t.IsZero() {
		return nil
	}
	utc := t.UTC()
	return &utc
}
