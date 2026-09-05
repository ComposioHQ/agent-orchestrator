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
	ReclaimOrchestrationEventLeases(context.Context, time.Time) (int64, error)
	MarkOrchestrationRetentionOverflow(context.Context, time.Time) (int64, error)
}

// Run owns restart recovery and cancellable daemon timers. It does not depend
// on SSE, Electron, a shell process, or an agent-side polling loop.
func Run(ctx context.Context, store RecoveryStore, dispatcher *Dispatcher, wake <-chan domain.ProjectID, log *slog.Logger) {
	if log == nil {
		log = slog.Default()
	}
	if _, err := store.ReclaimOrchestrationEventLeases(ctx, time.Now().UTC()); err != nil {
		log.Error("orchestration dispatcher lease recovery failed", "error", err)
	}
	dispatchAll := func() {
		if _, err := store.MarkOrchestrationRetentionOverflow(ctx, time.Now().UTC()); err != nil {
			log.Warn("orchestration retention maintenance failed", "error", err)
		}
		projects, err := store.ListProjects(ctx)
		if err != nil {
			log.Error("orchestration dispatcher project scan failed", "error", err)
			return
		}
		for _, p := range projects {
			if err := dispatcher.DispatchProject(ctx, domain.ProjectID(p.ID)); err != nil {
				log.Warn("orchestration dispatch failed", "projectID", p.ID, "error", err)
			}
		}
	}
	dispatchAll()
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
