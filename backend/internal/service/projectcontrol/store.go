package projectcontrol

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// Store is the complete durable surface used by slice-one project control.
type Store interface {
	Get(ctx context.Context, projectID domain.ProjectID) (domain.ProjectControl, bool, error)
	SetOutcome(ctx context.Context, projectID domain.ProjectID, mutation domain.SetOutcomeMutation) (domain.ProjectControl, error)
}
