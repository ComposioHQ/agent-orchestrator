package ports

import (
	"context"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// WorkspaceObservation is the single content seam for a materialized session
// workspace. Implementations execute where the workspace lives; callers must
// not interpret workspace paths as control-plane filesystem paths.
type WorkspaceObservation interface {
	ListWorkspaceFiles(ctx context.Context, id domain.SessionID) (WorkspaceFiles, error)
	ReadWorkspaceFile(ctx context.Context, id domain.SessionID, path string) (WorkspaceFile, error)
	ReadWorkspaceBlob(ctx context.Context, id domain.SessionID, path string, side WorkspaceBlobSide) (WorkspaceBlob, error)
	WatchWorkspace(ctx context.Context, id domain.SessionID) (<-chan WorkspaceEvent, error)
	ReadPreviewFile(ctx context.Context, id domain.SessionID, path string) (PreviewFile, error)
	DiscoverPreview(ctx context.Context, id domain.SessionID) (string, bool, error)
	InvalidateWorkspace(id domain.SessionID)
}

// WorkspaceObservationClient is the provider-neutral compute-plane contract.
// A hosted adapter forwards these operations without exposing sandbox paths.
type WorkspaceObservationClient interface {
	WorkspaceObservation
}

type WorkspaceFileStatus string

const (
	WorkspaceFileUnmodified WorkspaceFileStatus = "unmodified"
	WorkspaceFileModified   WorkspaceFileStatus = "modified"
	WorkspaceFileAdded      WorkspaceFileStatus = "added"
	WorkspaceFileDeleted    WorkspaceFileStatus = "deleted"
	WorkspaceFileRenamed    WorkspaceFileStatus = "renamed"
)

type WorkspaceCompareMode string

const (
	WorkspaceCompareBase         WorkspaceCompareMode = "base"
	WorkspaceCompareHeadFallback WorkspaceCompareMode = "head_fallback"
)

type WorkspaceFiles struct {
	SessionID      domain.SessionID
	CompareBaseSHA string
	CompareBaseRef string
	CompareMode    WorkspaceCompareMode
	Files          []WorkspaceFileSummary
	Truncated      bool
}

type WorkspaceFileSummary struct {
	Path         string
	PreviousPath string
	Status       WorkspaceFileStatus
	Additions    int
	Deletions    int
	Size         int64
	Binary       bool
}

// WorkspaceFile contains current text and its semantic diff. Diff is included
// in the read operation so providers can compute both against one consistent
// workspace observation.
type WorkspaceFile struct {
	SessionID          domain.SessionID
	Path               string
	PreviousPath       string
	Status             WorkspaceFileStatus
	Additions          int
	Deletions          int
	Size               int64
	Binary             bool
	Deleted            bool
	ImageMediaType     string
	Content            string
	ContentTruncated   bool
	Diff               string
	DiffTruncated      bool
	WorkspaceTruncated bool
	CompareBaseSHA     string
	CompareBaseRef     string
	CompareMode        WorkspaceCompareMode
}

type WorkspaceBlobSide string

const (
	WorkspaceBlobBefore WorkspaceBlobSide = "before"
	WorkspaceBlobAfter  WorkspaceBlobSide = "after"
)

type WorkspaceBlob struct {
	Path      string
	Side      WorkspaceBlobSide
	MediaType string
	Data      []byte
}

// WorkspaceEvent is deliberately coalesced: consumers must re-read semantic
// content after an event instead of treating the event as a durable diff.
type WorkspaceEvent struct{}

// MaxPreviewFileBytes bounds preview reads across local and hosted adapters.
const MaxPreviewFileBytes int64 = 10 << 20

// PreviewFile is a bounded file read suitable for HTTP preview serving.
type PreviewFile struct {
	Path      string
	Name      string
	Data      []byte
	Size      int64
	ModTime   time.Time
	MediaType string
}
