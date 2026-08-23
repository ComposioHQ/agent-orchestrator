package store_test

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/storage/storagetest"
)

func TestSQLiteProductPreferenceConformance(t *testing.T) {
	storagetest.RunPreferenceConformance(t, context.Background(), newTestStore(t))
}
