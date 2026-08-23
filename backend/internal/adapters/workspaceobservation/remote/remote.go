package remote

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Observation forwards semantic content operations to the compute plane. It
// intentionally contains no path, os, or process fallback.
type Observation struct {
	client ports.WorkspaceObservationClient
}

var _ ports.WorkspaceObservation = (*Observation)(nil)

func New(client ports.WorkspaceObservationClient) *Observation { return &Observation{client: client} }

func (o *Observation) Snapshot(ctx context.Context, info ports.WorkspaceInfo) (ports.WorkspaceSnapshot, error) {
	return o.client.Snapshot(ctx, info)
}

func (o *Observation) ListWorkspaceFiles(ctx context.Context, id domain.SessionID) (ports.WorkspaceFiles, error) {
	return o.client.ListWorkspaceFiles(ctx, id)
}

func (o *Observation) ReadWorkspaceFile(ctx context.Context, id domain.SessionID, path string) (ports.WorkspaceFile, error) {
	return o.client.ReadWorkspaceFile(ctx, id, path)
}

func (o *Observation) ReadWorkspaceBlob(ctx context.Context, id domain.SessionID, path string, side ports.WorkspaceBlobSide) (ports.WorkspaceBlob, error) {
	return o.client.ReadWorkspaceBlob(ctx, id, path, side)
}

func (o *Observation) WatchWorkspace(ctx context.Context, id domain.SessionID) (<-chan ports.WorkspaceEvent, error) {
	return o.client.WatchWorkspace(ctx, id)
}

func (o *Observation) ReadPreviewFile(ctx context.Context, id domain.SessionID, path string) (ports.PreviewFile, error) {
	return o.client.ReadPreviewFile(ctx, id, path)
}

func (o *Observation) DiscoverPreview(ctx context.Context, id domain.SessionID) (string, bool, error) {
	return o.client.DiscoverPreview(ctx, id)
}

func (o *Observation) InvalidateWorkspace(id domain.SessionID) { o.client.InvalidateWorkspace(id) }
