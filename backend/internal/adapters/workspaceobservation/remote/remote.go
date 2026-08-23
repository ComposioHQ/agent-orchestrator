package remote

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Observation forwards semantic content operations to the compute plane. It
// intentionally contains no path, os, or process fallback.
type observation struct {
	client ports.WorkspaceObservationClient
}

var _ ports.WorkspaceObservation = (*observation)(nil)

// New constructs a workspace observation adapter that forwards to the compute plane.
func New(client ports.WorkspaceObservationClient) *observation { return &observation{client: client} }

func (o *observation) ListWorkspaceFiles(ctx context.Context, id domain.SessionID) (ports.WorkspaceFiles, error) {
	return o.client.ListWorkspaceFiles(ctx, id)
}

func (o *observation) ReadWorkspaceFile(ctx context.Context, id domain.SessionID, path string) (ports.WorkspaceFile, error) {
	return o.client.ReadWorkspaceFile(ctx, id, path)
}

func (o *observation) ReadWorkspaceBlob(ctx context.Context, id domain.SessionID, path string, side ports.WorkspaceBlobSide) (ports.WorkspaceBlob, error) {
	return o.client.ReadWorkspaceBlob(ctx, id, path, side)
}

func (o *observation) WatchWorkspace(ctx context.Context, id domain.SessionID) (<-chan ports.WorkspaceEvent, error) {
	return o.client.WatchWorkspace(ctx, id)
}

func (o *observation) ReadPreviewFile(ctx context.Context, id domain.SessionID, path string) (ports.PreviewFile, error) {
	return o.client.ReadPreviewFile(ctx, id, path)
}

func (o *observation) DiscoverPreview(ctx context.Context, id domain.SessionID) (string, bool, error) {
	return o.client.DiscoverPreview(ctx, id)
}

func (o *observation) InvalidateWorkspace(id domain.SessionID) { o.client.InvalidateWorkspace(id) }
