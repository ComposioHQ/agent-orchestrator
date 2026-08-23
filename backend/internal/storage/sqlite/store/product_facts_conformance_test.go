package store_test

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/storage/storagetest"
)

func TestSQLiteProductFactsConformance(t *testing.T) {
	store := newTestStore(t)
	seedProject(t, store, "product-facts")
	first, err := store.CreateSession(context.Background(), sampleRecord("product-facts"))
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.CreateSession(context.Background(), sampleRecord("product-facts"))
	if err != nil {
		t.Fatal(err)
	}
	storagetest.RunProductFactsConformance(t, context.Background(), storagetest.ProductFactsFixture{
		Store: store, ProjectID: first.ProjectID, SessionID: first.ID, OtherSessionID: second.ID,
	})
}
