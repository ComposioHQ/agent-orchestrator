package ports

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ProjectStore is the durable project registry: what the sidebar's project
// list, the project settings surface, and first-run seeding read.
//
// Removal is an archive, never a delete. A project's sessions, worktrees, and
// PR observations reference it, and a user who unregisters a repository has not
// asked for that history to be destroyed — so ArchiveProject stamps a timestamp
// and the active read paths filter on it.
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
	// archived project stays invisible here even though GetProject still
	// returns it, which is what lets a user re-register a path they archived.
	FindProjectByPath(ctx context.Context, path string) (domain.ProjectRecord, bool, error)
	// UpsertProject inserts or replaces one registry row.
	UpsertProject(ctx context.Context, row domain.ProjectRecord) error
	// UpsertWorkspaceProject writes a workspace project and its child repo
	// registry atomically. The supplied child set is authoritative: children
	// absent from it are removed, so a half-applied write can never leave a
	// workspace pointing at repositories that are no longer registered.
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
