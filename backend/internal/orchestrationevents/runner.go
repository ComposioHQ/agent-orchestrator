package orchestrationevents

import (
	"context"
	"log/slog"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// RecoveryStore supplies startup and retention maintenance.
type RecoveryStore interface {
	ListProjects(context.Context) ([]domain.ProjectRecord, error)
	ReconcileTerminatedOrchestrationEvents(context.Context, time.Time) (int, error)
	ReclaimOrchestrationEventLeases(context.Context, time.Time) (int64, error)
	MarkOrchestrationRetentionOverflow(context.Context, time.Time) (int64, error)
}

// Recover synchronously reclaims interrupted work and attempts every due
// project. Daemon startup calls this before exposing a healthy HTTP server.
func Recover(ctx context.Context, store RecoveryStore, dispatcher *Dispatcher) error {
	if _, err := store.ReconcileTerminatedOrchestrationEvents(ctx, time.Now().UTC()); err != nil {
		return err
	}
	if _, err := store.ReclaimOrchestrationEventLeases(ctx, time.Now().UTC()); err != nil {
		return err
	}
	if _, err := store.MarkOrchestrationRetentionOverflow(ctx, time.Now().UTC()); err != nil {
		return err
	}
	projects, err := store.ListProjects(ctx)
	if err != nil {
		return err
	}
	for _, p := range projects {
		if err := dispatcher.ReconcileAttention(ctx, domain.ProjectID(p.ID), time.Now().UTC()); err != nil {
			return err
		}
		if err := dispatcher.DispatchProject(ctx, domain.ProjectID(p.ID)); err != nil {
			return err
		}
	}
	return nil
}

// Run owns cancellable daemon recovery timers. It does not depend on SSE,
// Electron, a shell process, or an agent-side polling loop.
func Run(ctx context.Context, store RecoveryStore, dispatcher *Dispatcher, wake <-chan domain.ProjectID, log *slog.Logger) {
	if log == nil {
		log = slog.Default()
	}
	dispatchAll := func() {
		if err := Recover(ctx, store, dispatcher); err != nil {
			log.Warn("orchestration dispatcher recovery scan failed", "error", err)
		}
	}
	timer := time.NewTimer(time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case project := <-wake:
			if err := dispatcher.DispatchProject(ctx, project); err != nil {
				log.Warn("orchestration dispatch failed", "projectID", project, "error", err)
			}
		case <-timer.C:
			dispatchAll()
			timer.Reset(time.Second)
		}
	}
}
