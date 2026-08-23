package postgres_test

import (
	"errors"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	storageports "github.com/aoagents/agent-orchestrator/backend/internal/storage/ports"
)

func isTenantRequired(err error) bool {
	return errors.Is(err, storageports.ErrTenantRequired)
}

func newTenantProject() domain.ProjectRecord {
	return domain.ProjectRecord{
		ID:           "acme",
		Path:         "/repos/acme",
		DisplayName:  "Acme",
		RegisteredAt: time.Date(2026, 3, 14, 15, 9, 26, 0, time.UTC),
		Kind:         domain.ProjectKindSingleRepo,
	}
}
