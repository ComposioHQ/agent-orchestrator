package ports

import (
	"context"
	"errors"
	"time"
)

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

type WorkspaceListRequest struct {
	Workspaces []WorkspaceInfo
	MaxEntries int
}

type WorkspaceListResult struct {
	Entries   []WorkspaceEntry
	Truncated bool
}

type WorkspaceEntry struct {
	WorkspacePath string
	Path          string
	Size          int64
	Mode          uint32
	ModTime       time.Time
	Directory     bool
}

type WorkspaceReadRequest struct {
	Workspace WorkspaceInfo
	Path      string
	MaxBytes  int64
}

type WorkspaceReadResult struct {
	Path      string
	Data      []byte
	Size      int64
	ModTime   time.Time
	MediaType string
	Truncated bool
}

type WorkspaceWatchRequest struct {
	Workspaces []WorkspaceInfo
}

type WorkspaceEvent struct{}

type WorkspaceDiffRequest struct {
	Workspace WorkspaceInfo
	Base      string
	Path      string
	MaxBytes  int64
}

type WorkspaceDiffResult struct {
	UnifiedDiff string
	Truncated   bool
}

type WorkspaceBlobRequest struct {
	Workspace WorkspaceInfo
	Path      string
	// Revision is empty for the materialized worktree, or a Git revision for a
	// historical blob (for example the session compare-base SHA).
	Revision string
	MaxBytes int64
}

type WorkspaceBlobResult struct {
	Path      string
	Data      []byte
	MediaType string
	Truncated bool
}
