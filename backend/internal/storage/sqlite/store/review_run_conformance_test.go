package store_test

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/storage/storagetest"
)

func TestSQLiteReviewRunConformance(t *testing.T) {
	store := newTestStore(t)
	seedProject(t, store, "review-conformance")
	session, err := store.CreateSession(context.Background(), sampleRecord("review-conformance"))
	if err != nil {
		t.Fatal(err)
	}
	storagetest.RunReviewRunConformance(t, context.Background(), storagetest.ReviewRunFixture{
		Store: store, ProjectID: session.ProjectID, SessionID: session.ID,
	})
}
