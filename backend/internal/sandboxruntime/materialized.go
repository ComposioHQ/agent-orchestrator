package sandboxruntime

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/workspace/gitworktree"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	sessionsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/session"
)

// MaterializedConfig is non-secret launch configuration for the workspace
// already mounted in this sandbox. The listener self-binds every content call
// to SessionID and Root; neither value is accepted from a control-plane path.
type MaterializedConfig struct {
	SessionID   domain.SessionID
	Root        string
	Branch      string
	DiffBaseSHA string
	DiffBaseRef string
	Project     domain.ProjectRecord
	Worktrees   []domain.SessionWorktreeRecord
	Scratch     bool
}

// MaterializedObservation adapts the existing semantic session-content logic
// to one sandbox-local checkout without constructing a daemon or opening a
// product database. Its tiny static store contains launch configuration only.
type MaterializedObservation struct {
	config      MaterializedConfig
	service     *sessionsvc.Service
	snapshotter ports.WorkspaceSnapshotter
}

var _ ports.WorkspaceObservation = (*MaterializedObservation)(nil)

func NewMaterializedObservation(config MaterializedConfig) (*MaterializedObservation, error) {
	if strings.TrimSpace(string(config.SessionID)) == "" {
		return nil, errors.New("materialized workspace requires a session id")
	}
	root, err := filepath.Abs(strings.TrimSpace(config.Root))
	if err != nil || strings.TrimSpace(config.Root) == "" {
		return nil, errors.New("materialized workspace requires an absolute root")
	}
	root, err = filepath.EvalSymlinks(root)
	if err != nil {
		return nil, fmt.Errorf("resolve materialized workspace root: %w", err)
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return nil, errors.New("materialized workspace root is not a directory")
	}
	config.Root = root
	if config.Project.ID == "" {
		config.Project.ID = "sandbox-project"
	}
	if config.Scratch {
		config.Project.Kind = domain.ProjectKindScratch
	}

	record := domain.SessionRecord{
		ID:        config.SessionID,
		ProjectID: domain.ProjectID(config.Project.ID),
		Metadata: domain.SessionMetadata{
			Branch:        config.Branch,
			WorkspacePath: root,
			DiffBaseSHA:   config.DiffBaseSHA,
			DiffBaseRef:   config.DiffBaseRef,
		},
	}
	store := &materializedStore{record: record, project: config.Project, worktrees: append([]domain.SessionWorktreeRecord(nil), config.Worktrees...)}
	observation := &MaterializedObservation{
		config:  config,
		service: sessionsvc.NewWithDeps(sessionsvc.Deps{Store: store}),
	}
	if !config.Scratch {
		workspace, err := gitworktree.New(gitworktree.Options{
			ManagedRoot:  filepath.Dir(root),
			RepoResolver: gitworktree.StaticRepoResolver{domain.ProjectID(config.Project.ID): root},
		})
		if err != nil {
			return nil, fmt.Errorf("construct workspace snapshotter: %w", err)
		}
		observation.snapshotter = workspace
	}
	return observation, nil
}

// materializedStore satisfies the session read-model service with one static,
// non-durable placement. Embedding the port makes accidental calls outside the
// four content methods panic in tests rather than silently introducing a
// database into ao-sandbox.
type materializedStore struct {
	sessionsvc.Store
	record    domain.SessionRecord
	project   domain.ProjectRecord
	worktrees []domain.SessionWorktreeRecord
}

func (s *materializedStore) GetSession(_ context.Context, id domain.SessionID) (domain.SessionRecord, bool, error) {
	return s.record, id == s.record.ID, nil
}
func (s *materializedStore) GetProject(_ context.Context, id string) (domain.ProjectRecord, bool, error) {
	return s.project, id == s.project.ID, nil
}
func (s *materializedStore) ListPRsBySession(context.Context, domain.SessionID) ([]domain.PullRequest, error) {
	return nil, nil
}
func (s *materializedStore) ListSessionWorktrees(_ context.Context, id domain.SessionID) ([]domain.SessionWorktreeRecord, error) {
	if id != s.record.ID {
		return nil, nil
	}
	return append([]domain.SessionWorktreeRecord(nil), s.worktrees...), nil
}

func (o *MaterializedObservation) Snapshot(ctx context.Context, _ ports.WorkspaceInfo) (ports.WorkspaceSnapshot, error) {
	if o.snapshotter == nil {
		return ports.WorkspaceSnapshot{Path: o.config.Root, Branch: o.config.Branch}, nil
	}
	return o.snapshotter.ObserveWorkspace(ctx, ports.WorkspaceInfo{Path: o.config.Root, Branch: o.config.Branch})
}

func (o *MaterializedObservation) ListWorkspaceFiles(ctx context.Context, id domain.SessionID) (ports.WorkspaceFiles, error) {
	if err := o.bound(id); err != nil {
		return ports.WorkspaceFiles{}, err
	}
	return o.service.ListWorkspaceFiles(ctx, id)
}

func (o *MaterializedObservation) ReadWorkspaceFile(ctx context.Context, id domain.SessionID, path string) (ports.WorkspaceFile, error) {
	if err := o.bound(id); err != nil {
		return ports.WorkspaceFile{}, err
	}
	return o.service.GetWorkspaceFile(ctx, id, path)
}

func (o *MaterializedObservation) ReadWorkspaceBlob(ctx context.Context, id domain.SessionID, path string, side ports.WorkspaceBlobSide) (ports.WorkspaceBlob, error) {
	if err := o.bound(id); err != nil {
		return ports.WorkspaceBlob{}, err
	}
	return o.service.GetWorkspaceFileBlob(ctx, id, path, side)
}

func (o *MaterializedObservation) WatchWorkspace(ctx context.Context, id domain.SessionID) (<-chan ports.WorkspaceEvent, error) {
	if err := o.bound(id); err != nil {
		return nil, err
	}
	return o.service.WatchWorkspace(ctx, id)
}

func (o *MaterializedObservation) ReadPreviewFile(ctx context.Context, id domain.SessionID, path string) (ports.PreviewFile, error) {
	if err := o.bound(id); err != nil {
		return ports.PreviewFile{}, err
	}
	return o.service.ReadPreviewFile(ctx, id, path)
}

func (o *MaterializedObservation) DiscoverPreview(ctx context.Context, id domain.SessionID) (string, bool, error) {
	if err := o.bound(id); err != nil {
		return "", false, err
	}
	return o.service.DiscoverPreview(ctx, id)
}

func (o *MaterializedObservation) InvalidateWorkspace(id domain.SessionID) {
	if o.bound(id) == nil {
		o.service.InvalidateWorkspaceCache(id)
	}
}

func (o *MaterializedObservation) bound(id domain.SessionID) error {
	if id != o.config.SessionID {
		return errors.New("workspace observation is not authorized for this session")
	}
	return nil
}
