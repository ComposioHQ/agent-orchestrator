package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/placement"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// placementStore is the durable boundary used by the hosted placement worker.
// Project registration is deliberately metadata-only: repository
// materialization belongs to the sandbox compute adapter, not the control
// plane filesystem.
type placementStore interface {
	placement.Store
	ports.ProjectStore
	CompleteWorkspacePlacement(context.Context, string, string, string) (clouddomain.WorkspacePlacement, error)
	FailWorkspacePlacement(context.Context, string, string) (clouddomain.WorkspacePlacement, error)
	RemoveWorkspacePlacement(context.Context, string) error
}

type placementJob struct {
	identity tenant.Identity
	record   clouddomain.WorkspacePlacement
}

// durablePlacementExecutor converts an accepted placement into the shared
// project read model without probing or writing the control-plane filesystem.
// The sandbox compute plane consumes that metadata when a session is started.
type durablePlacementExecutor struct {
	store  placementStore
	logger *slog.Logger
	jobs   chan placementJob
}

func newDurablePlacementExecutor(ctx context.Context, store placementStore, logger *slog.Logger) *durablePlacementExecutor {
	executor := &durablePlacementExecutor{store: store, logger: logger, jobs: make(chan placementJob, 128)}
	go executor.run(ctx)
	return executor
}

func (e *durablePlacementExecutor) Enqueue(ctx context.Context, record clouddomain.WorkspacePlacement) error {
	identity, ok := tenant.FromContext(ctx)
	if !ok {
		return tenant.ErrNoTenant
	}
	select {
	case e.jobs <- placementJob{identity: identity, record: record}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	default:
		return fmt.Errorf("workspace placement queue is full")
	}
}

func (e *durablePlacementExecutor) run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case job := <-e.jobs:
			e.process(tenant.WithIdentity(ctx, job.identity), job.record)
		}
	}
}

func (e *durablePlacementExecutor) process(ctx context.Context, record clouddomain.WorkspacePlacement) {
	var err error
	switch record.Intent {
	case clouddomain.WorkspacePlacementProvision, clouddomain.WorkspacePlacementResume:
		err = e.provision(ctx, record)
	case clouddomain.WorkspacePlacementDelete:
		err = e.remove(ctx, record)
	default:
		err = fmt.Errorf("unsupported placement intent %q", record.Intent)
	}
	if err == nil {
		return
	}
	e.logger.Error("Workspace placement failed", "workspace", record.ID, "intent", record.Intent, "error", err)
	if _, failErr := e.store.FailWorkspacePlacement(ctx, record.ID, "workspace placement failed"); failErr != nil {
		e.logger.Error("Failed to persist workspace placement failure", "workspace", record.ID, "error", failErr)
	}
}

func (e *durablePlacementExecutor) provision(ctx context.Context, record clouddomain.WorkspacePlacement) error {
	config := domain.ProjectConfig{}
	if len(record.Config) > 0 {
		if err := json.Unmarshal(record.Config, &config); err != nil {
			return fmt.Errorf("decode project config: %w", err)
		}
	}
	if branch := strings.TrimSpace(record.DefaultBranch); branch != "" {
		config.DefaultBranch = branch
	}
	if err := config.Validate(); err != nil {
		return fmt.Errorf("validate project config: %w", err)
	}
	project := domain.ProjectRecord{
		ID:            record.ID,
		Path:          "/workspace",
		RepoOriginURL: record.RepositoryURL,
		DisplayName:   record.DisplayName,
		RegisteredAt:  record.CreatedAt,
		Kind:          domain.ProjectKindSingleRepo,
		Config:        config,
	}
	if project.RegisteredAt.IsZero() {
		project.RegisteredAt = time.Now().UTC()
	}
	if err := e.store.UpsertProject(ctx, project); err != nil {
		return err
	}
	_, err := e.store.CompleteWorkspacePlacement(ctx, record.ID, project.ID, "")
	return err
}

func (e *durablePlacementExecutor) remove(ctx context.Context, record clouddomain.WorkspacePlacement) error {
	if record.ProjectID != "" {
		if _, err := e.store.ArchiveProject(ctx, record.ProjectID, time.Now().UTC()); err != nil {
			return err
		}
	}
	return e.store.RemoveWorkspacePlacement(ctx, record.ID)
}
