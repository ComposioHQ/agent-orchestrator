package storageports

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ProjectStore is the durable project registry. It is what the sidebar's
// project list, the project settings surface, and first-run seeding read.
//
// It is a superset of the surface service/project.Service requires, by exactly
// one method: ListWorkspaceRepos is on the service's own interface too, and
// GetSessionWorktree-style child reads belong here rather than on the session
// ports because a workspace repo is project registry data.
type ProjectStore interface {
	// ListProjects returns active (non-archived) projects ordered by id.
	ListProjects(ctx context.Context) ([]domain.ProjectRecord, error)
	// CountProjectsIncludingArchived counts every registry row. It is separate
	// from ListProjects so first-run seeding does not recreate a project the
	// user deliberately archived.
	CountProjectsIncludingArchived(ctx context.Context) (int, error)
	// GetProject returns a project by id, active or archived.
	GetProject(ctx context.Context, id string) (domain.ProjectRecord, bool, error)
	// FindProjectByPath returns the ACTIVE project registered at path. An
	// archived project is invisible here even though GetProject still returns
	// it, which is what lets a user re-register a path they archived.
	FindProjectByPath(ctx context.Context, path string) (domain.ProjectRecord, bool, error)
	// UpsertProject inserts or replaces one registry row.
	UpsertProject(ctx context.Context, row domain.ProjectRecord) error
	// UpsertWorkspaceProject writes a workspace project and its child repo
	// registry atomically. The supplied child set is authoritative: children
	// absent from it are removed.
	UpsertWorkspaceProject(ctx context.Context, row domain.ProjectRecord, repos []domain.WorkspaceRepoRecord) error
	// ListWorkspaceRepos returns the registered direct children of a workspace
	// project, ordered by name.
	ListWorkspaceRepos(ctx context.Context, projectID string) ([]domain.WorkspaceRepoRecord, error)
	// UpdateProjectSettings atomically updates the display name and config of
	// an active project. ok is false when the project is missing or archived.
	UpdateProjectSettings(ctx context.Context, id string, displayName string, config domain.ProjectConfig) (bool, error)
	// ArchiveProject soft-deletes a project. ok is false when no active row
	// matched; archiving an already-archived project is not an error.
	ArchiveProject(ctx context.Context, id string, at time.Time) (bool, error)
}
