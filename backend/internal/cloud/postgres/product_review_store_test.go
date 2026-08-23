package postgres_test

import (
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	reviewcore "github.com/aoagents/agent-orchestrator/backend/internal/review"
	reviewsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/review"
)

var (
	_ reviewcore.Store = (*postgres.Store)(nil)
	_ reviewsvc.Store  = (*postgres.Store)(nil)
)
