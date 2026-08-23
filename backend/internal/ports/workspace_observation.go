package ports

import (
	"context"
	"errors"
	"time"
)

// ErrWorkspaceObservationUnsupported reports an unavailable observation capability.
var ErrWorkspaceObservationUnsupported = errors.New("workspace observation: operation unsupported")

// WorkspaceObservation is the sole read-only port for materialized workspace
// data. It is deliberately semantic: hosted callers never receive a sandbox
// path and then attempt to read it from the control-plane filesystem.
type WorkspaceObservation interface {
	Snapshot(ctx context.Context, info WorkspaceInfo) (WorkspaceSnapshot, error)
	List(ctx context.Context, request WorkspaceListRequest) (WorkspaceListResult, error)
	Read(ctx context.Context, request WorkspaceReadRequest) (WorkspaceReadResult, error)
	Watch(ctx context.Context, request WorkspaceWatchRequest) (<-chan WorkspaceEvent, error)
	Diff(ctx context.Context, request WorkspaceDiffRequest) (WorkspaceDiffResult, error)
	Blob(ctx context.Context, request WorkspaceBlobRequest) (WorkspaceBlobResult, error)
}

// WorkspaceListRequest selects workspace roots and an optional result limit.
type WorkspaceListRequest struct {
	Workspaces []WorkspaceInfo
	MaxEntries int
}

// WorkspaceListResult is a bounded recursive workspace listing.
type WorkspaceListResult struct {
	Entries   []WorkspaceEntry
	Truncated bool
}

// WorkspaceEntry describes one path relative to a workspace root.
type WorkspaceEntry struct {
	WorkspacePath string
	Path          string
	Size          int64
	Mode          uint32
	ModTime       time.Time
	Directory     bool
}

// WorkspaceReadRequest selects a materialized file and optional byte limit.
type WorkspaceReadRequest struct {
	Workspace WorkspaceInfo
	Path      string
	MaxBytes  int64
}

// WorkspaceReadResult contains materialized file metadata and bytes.
type WorkspaceReadResult struct {
	Path      string
	Data      []byte
	Size      int64
	ModTime   time.Time
	MediaType string
	Truncated bool
}

// WorkspaceWatchRequest selects workspace roots to observe for changes.
type WorkspaceWatchRequest struct {
	Workspaces []WorkspaceInfo
}

// WorkspaceEvent signals that at least one selected workspace changed.
type WorkspaceEvent struct{}

// WorkspaceDiffRequest selects a bounded Git diff for a workspace or path.
type WorkspaceDiffRequest struct {
	Workspace WorkspaceInfo
	Base      string
	Path      string
	MaxBytes  int64
}

// WorkspaceDiffResult contains a unified diff and truncation state.
type WorkspaceDiffResult struct {
	UnifiedDiff string
	Truncated   bool
}

// WorkspaceBlobRequest selects current or historical file content.
type WorkspaceBlobRequest struct {
	Workspace WorkspaceInfo
	Path      string
	// Revision is empty for the materialized worktree, or a Git revision for a
	// historical blob (for example the session compare-base SHA).
	Revision string
	MaxBytes int64
}

// WorkspaceBlobResult contains file bytes and presentation metadata.
type WorkspaceBlobResult struct {
	Path      string
	Data      []byte
	MediaType string
	Truncated bool
}
