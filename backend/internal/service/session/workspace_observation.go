package session

import (
	"context"
	"io"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	previewutil "github.com/aoagents/agent-orchestrator/backend/internal/preview"
	"github.com/aoagents/agent-orchestrator/backend/internal/workspacewatch"
)

// localWorkspaceObservation is the local placement adapter. Keeping all
// legacy filesystem/Git entry points behind it makes the injected remote port
// a hard boundary: public service methods never inspect a workspace path.
type localWorkspaceObservation struct {
	service *Service
}

var _ ports.WorkspaceObservation = (*localWorkspaceObservation)(nil)

func (o *localWorkspaceObservation) ListWorkspaceFiles(ctx context.Context, id domain.SessionID) (ports.WorkspaceFiles, error) {
	return o.service.localListWorkspaceFiles(ctx, id)
}

func (o *localWorkspaceObservation) ReadWorkspaceFile(ctx context.Context, id domain.SessionID, path string) (ports.WorkspaceFile, error) {
	return o.service.localGetWorkspaceFile(ctx, id, path)
}

func (o *localWorkspaceObservation) ReadWorkspaceBlob(ctx context.Context, id domain.SessionID, path string, side ports.WorkspaceBlobSide) (ports.WorkspaceBlob, error) {
	return o.service.localGetWorkspaceFileBlob(ctx, id, path, side)
}

func (o *localWorkspaceObservation) WatchWorkspace(ctx context.Context, id domain.SessionID) (<-chan ports.WorkspaceEvent, error) {
	paths, err := o.service.localWorkspaceWatchPaths(ctx, id)
	if err != nil {
		return nil, err
	}
	changes, err := workspacewatch.Watch(ctx, paths...)
	if err != nil {
		return nil, err
	}
	events := make(chan ports.WorkspaceEvent, 1)
	go func() {
		defer close(events)
		for {
			select {
			case <-ctx.Done():
				return
			case _, ok := <-changes:
				if !ok {
					return
				}
				select {
				case events <- ports.WorkspaceEvent{}:
				default:
					// Coalesce bursts. Consumers re-read semantic workspace state.
				}
			}
		}
	}()
	return events, nil
}

func (o *localWorkspaceObservation) ReadPreviewFile(ctx context.Context, id domain.SessionID, path string) (ports.PreviewFile, error) {
	rec, err := o.service.sessionWorkspaceRecord(ctx, id)
	if err != nil {
		return ports.PreviewFile{}, err
	}
	file, info, clean, err := previewutil.OpenWorkspaceFile(rec.Metadata.WorkspacePath, path)
	if err != nil {
		return ports.PreviewFile{}, apierr.NotFound("PREVIEW_FILE_NOT_FOUND", "Preview file not found")
	}
	defer func() { _ = file.Close() }()
	if info.Size() > ports.MaxPreviewFileBytes {
		return ports.PreviewFile{}, apierr.Invalid("PREVIEW_FILE_TOO_LARGE", "Preview file exceeds the supported size", map[string]any{"maxBytes": ports.MaxPreviewFileBytes})
	}
	if err := ctx.Err(); err != nil {
		return ports.PreviewFile{}, err
	}
	data, err := io.ReadAll(io.LimitReader(previewContextReader{ctx: ctx, reader: file}, ports.MaxPreviewFileBytes+1))
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ports.PreviewFile{}, ctxErr
		}
		return ports.PreviewFile{}, apierr.NotFound("PREVIEW_FILE_NOT_FOUND", "Preview file not found")
	}
	if int64(len(data)) > ports.MaxPreviewFileBytes {
		return ports.PreviewFile{}, apierr.Invalid("PREVIEW_FILE_TOO_LARGE", "Preview file exceeds the supported size", map[string]any{"maxBytes": ports.MaxPreviewFileBytes})
	}
	return ports.PreviewFile{Path: clean, Name: info.Name(), Data: data, Size: info.Size(), ModTime: info.ModTime()}, nil
}

func (o *localWorkspaceObservation) DiscoverPreview(ctx context.Context, id domain.SessionID) (string, bool, error) {
	rec, err := o.service.sessionWorkspaceRecord(ctx, id)
	if err != nil {
		return "", false, err
	}
	entry, ok := previewutil.DiscoverEntry(rec.Metadata.WorkspacePath)
	return entry.Path, ok, nil
}

func (o *localWorkspaceObservation) InvalidateWorkspace(id domain.SessionID) {
	o.service.localInvalidateWorkspaceCache(id)
}

// ListWorkspaceFiles returns the semantic file listing from the selected workspace observation adapter.
func (s *Service) ListWorkspaceFiles(ctx context.Context, id domain.SessionID) (WorkspaceFiles, error) {
	return s.workspaceObserver().ListWorkspaceFiles(ctx, id)
}

// GetWorkspaceFile returns one semantic workspace file and its diff.
func (s *Service) GetWorkspaceFile(ctx context.Context, id domain.SessionID, path string) (WorkspaceFileDetail, error) {
	return s.workspaceObserver().ReadWorkspaceFile(ctx, id, path)
}

// GetWorkspaceFileBlob returns one bounded binary side of a workspace file.
func (s *Service) GetWorkspaceFileBlob(ctx context.Context, id domain.SessionID, path string, side WorkspaceFileBlobSide) (WorkspaceFileBlob, error) {
	return s.workspaceObserver().ReadWorkspaceBlob(ctx, id, path, side)
}

// WatchWorkspace reports coalesced workspace changes until the context ends.
func (s *Service) WatchWorkspace(ctx context.Context, id domain.SessionID) (<-chan ports.WorkspaceEvent, error) {
	return s.workspaceObserver().WatchWorkspace(ctx, id)
}

// ReadPreviewFile returns a bounded, workspace-confined preview asset.
func (s *Service) ReadPreviewFile(ctx context.Context, id domain.SessionID, path string) (ports.PreviewFile, error) {
	return s.workspaceObserver().ReadPreviewFile(ctx, id, path)
}

// DiscoverPreview locates the current preview entry within the selected workspace.
func (s *Service) DiscoverPreview(ctx context.Context, id domain.SessionID) (string, bool, error) {
	return s.workspaceObserver().DiscoverPreview(ctx, id)
}

// InvalidateWorkspaceCache clears cached semantic workspace observations for a session.
func (s *Service) InvalidateWorkspaceCache(id domain.SessionID) {
	s.workspaceObserver().InvalidateWorkspace(id)
}

func (s *Service) workspaceObserver() ports.WorkspaceObservation {
	if s.workspaceObservation != nil {
		return s.workspaceObservation
	}
	return &localWorkspaceObservation{service: s}
}

// UsesLocalWorkspaceObservation lets the HTTP adapter preserve the canonical
// local attachment-store fallback without ever probing control-plane storage
// for a remotely observed session.
func (s *Service) UsesLocalWorkspaceObservation() bool {
	_, ok := s.workspaceObserver().(*localWorkspaceObservation)
	return ok
}

// previewContextReader makes cancellation observable during bounded local reads.
type previewContextReader struct {
	ctx    context.Context
	reader io.Reader
}

func (r previewContextReader) Read(p []byte) (int, error) {
	select {
	case <-r.ctx.Done():
		return 0, r.ctx.Err()
	default:
		return r.reader.Read(p)
	}
}
