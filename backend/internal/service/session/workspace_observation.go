package session

import (
	"context"
	"fmt"
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

func (o *localWorkspaceObservation) Snapshot(context.Context, ports.WorkspaceInfo) (ports.WorkspaceSnapshot, error) {
	return ports.WorkspaceSnapshot{}, fmt.Errorf("local session content: snapshot is owned by the workspace adapter")
}

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
	events := make(chan ports.WorkspaceEvent)
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
				case <-ctx.Done():
					return
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
	data, err := io.ReadAll(file)
	if err != nil {
		return ports.PreviewFile{}, apierr.NotFound("PREVIEW_FILE_NOT_FOUND", "Preview file not found")
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

func (s *Service) ListWorkspaceFiles(ctx context.Context, id domain.SessionID) (WorkspaceFiles, error) {
	return s.workspaceObserver().ListWorkspaceFiles(ctx, id)
}

func (s *Service) GetWorkspaceFile(ctx context.Context, id domain.SessionID, path string) (WorkspaceFileDetail, error) {
	return s.workspaceObserver().ReadWorkspaceFile(ctx, id, path)
}

func (s *Service) GetWorkspaceFileBlob(ctx context.Context, id domain.SessionID, path string, side WorkspaceFileBlobSide) (WorkspaceFileBlob, error) {
	return s.workspaceObserver().ReadWorkspaceBlob(ctx, id, path, side)
}

func (s *Service) WatchWorkspace(ctx context.Context, id domain.SessionID) (<-chan ports.WorkspaceEvent, error) {
	return s.workspaceObserver().WatchWorkspace(ctx, id)
}

func (s *Service) ReadPreviewFile(ctx context.Context, id domain.SessionID, path string) (ports.PreviewFile, error) {
	return s.workspaceObserver().ReadPreviewFile(ctx, id, path)
}

func (s *Service) DiscoverPreview(ctx context.Context, id domain.SessionID) (string, bool, error) {
	return s.workspaceObserver().DiscoverPreview(ctx, id)
}

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
