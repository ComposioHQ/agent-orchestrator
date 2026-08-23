package runtimetest

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
)

// RunStoreConformance exercises the durable semantics every compute placement
// adapter must reproduce. PostgreSQL adapter tests should call this function
// with a fresh transaction/schema-backed store factory.
func RunStoreConformance(t *testing.T, factory func() runtime.Store) {
	t.Helper()
	now := time.Date(2026, 8, 23, 20, 0, 0, 0, time.UTC)
	ref := func(session string) runtime.Ref {
		return runtime.Ref{OrgID: "org", WorkspaceID: "workspace", SessionID: session, UserID: "user", Role: runtime.RoleWorker}
	}

	t.Run("idempotent ensure and non-resurrection", func(t *testing.T) {
		store := factory()
		first, created, err := store.Ensure(context.Background(), ref("one"), runtime.DefaultQuotas(), now)
		if err != nil || !created {
			t.Fatalf("first Ensure = %#v, %v", first, err)
		}
		second, created, err := store.Ensure(context.Background(), ref("one"), runtime.DefaultQuotas(), now.Add(time.Minute))
		if err != nil || created || second.ID != first.ID {
			t.Fatalf("second Ensure = %#v created=%v err=%v", second, created, err)
		}
		second.State = runtime.StateDeleting
		second.DesiredState = runtime.StateDeleting
		deleting, err := store.Save(context.Background(), second)
		if err != nil {
			t.Fatal(err)
		}
		after, created, err := store.Ensure(context.Background(), ref("one"), runtime.DefaultQuotas(), now.Add(2*time.Minute))
		if err != nil || created || after.ID != deleting.ID || after.State != runtime.StateDeleting {
			t.Fatalf("Ensure resurrected deleting row: %#v created=%v err=%v", after, created, err)
		}
	})

	t.Run("generation compare and swap", func(t *testing.T) {
		store := factory()
		original, _, err := store.Ensure(context.Background(), ref("cas"), runtime.DefaultQuotas(), now)
		if err != nil {
			t.Fatal(err)
		}
		stale := original
		original.Error = "winner"
		if _, err := store.Save(context.Background(), original); err != nil {
			t.Fatal(err)
		}
		stale.Error = "loser"
		if _, err := store.Save(context.Background(), stale); !errors.Is(err, runtime.ErrConflict) {
			t.Fatalf("stale Save error = %v, want ErrConflict", err)
		}
	})

	t.Run("atomic quota reservation", func(t *testing.T) {
		store := factory()
		quotas := runtime.Quotas{MaxWorkersPerWorkspace: 1}
		start := make(chan struct{})
		errs := make(chan error, 2)
		var ready sync.WaitGroup
		ready.Add(2)
		for index := range 2 {
			candidate := ref(fmt.Sprintf("quota-%d", index))
			go func() {
				ready.Done()
				<-start
				_, _, err := store.Ensure(context.Background(), candidate, quotas, now)
				errs <- err
			}()
		}
		ready.Wait()
		close(start)
		var succeeded, rejected int
		for range 2 {
			err := <-errs
			if err == nil {
				succeeded++
			} else if errors.Is(err, runtime.ErrQuotaExceeded) {
				rejected++
			} else {
				t.Fatalf("Ensure error = %v", err)
			}
		}
		if succeeded != 1 || rejected != 1 {
			t.Fatalf("succeeded=%d rejected=%d, want one each", succeeded, rejected)
		}
	})
}
