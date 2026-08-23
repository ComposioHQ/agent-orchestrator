package runtimetest

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
)

// StoreFactory builds an empty placement store for one conformance case. The
// returned store must be isolated from every other case.
type StoreFactory func(t *testing.T) runtime.Store

// RunStoreConformance exercises every semantic runtime.Manager and
// runtime.Reaper depend on. It exists so a PostgreSQL placement adapter can
// prove it matches the in-memory reference rather than being reviewed by eye:
// the lifecycle's crash-safety argument rests entirely on generation-checked
// writes and a non-resurrecting Ensure, and either is easy to get subtly wrong
// in SQL.
//
// Call it from the adapter's own test package:
//
//	func TestPostgresPlacementStore(t *testing.T) {
//	    runtimetest.RunStoreConformance(t, func(t *testing.T) runtime.Store { ... })
//	}
func RunStoreConformance(t *testing.T, newStore StoreFactory) {
	t.Helper()
	ctx := context.Background()
	now := time.Date(2026, 8, 22, 9, 0, 0, 0, time.UTC)
	ref := runtime.Ref{OrgID: "org-1", WorkspaceID: "ws-1", SessionID: "sess-1", UserID: "user-1", Role: runtime.RoleWorker}

	t.Run("ensure is idempotent for one placement", func(t *testing.T) {
		store := newStore(t)
		first, created, err := store.Ensure(ctx, ref, now)
		if err != nil || !created {
			t.Fatalf("first Ensure: created=%v err=%v", created, err)
		}
		if first.ID == "" || first.State != runtime.StateProvisioning || first.Generation == 0 {
			t.Fatalf("inserted record = %#v", first)
		}
		second, created, err := store.Ensure(ctx, ref, now.Add(time.Minute))
		if err != nil {
			t.Fatal(err)
		}
		if created {
			t.Fatal("a second Ensure reported an insert; concurrent callers would each get a sandbox")
		}
		if second.ID != first.ID {
			t.Fatalf("second Ensure returned %s, want the existing %s", second.ID, first.ID)
		}
	})

	t.Run("ensure does not resurrect a placement being deleted", func(t *testing.T) {
		store := newStore(t)
		record, _, err := store.Ensure(ctx, ref, now)
		if err != nil {
			t.Fatal(err)
		}
		record.State = runtime.StateDeleting
		if _, err := store.Save(ctx, record); err != nil {
			t.Fatal(err)
		}
		resurrected, created, err := store.Ensure(ctx, ref, now.Add(time.Minute))
		if err != nil {
			t.Fatal(err)
		}
		// Returning created=true here would hand a caller a fresh-looking
		// placement whose sandbox is mid-teardown.
		if created || resurrected.State != runtime.StateDeleting {
			t.Fatalf("created=%v state=%s, want the deleting row returned as-is", created, resurrected.State)
		}
	})

	t.Run("ensure refuses a role change on an existing placement", func(t *testing.T) {
		store := newStore(t)
		if _, _, err := store.Ensure(ctx, ref, now); err != nil {
			t.Fatal(err)
		}
		confused := ref
		confused.Role = runtime.RoleCoordinator
		// Handing back the worker's row would run a coordinator under a
		// worker's capability scope.
		if _, _, err := store.Ensure(ctx, confused, now); !errors.Is(err, runtime.ErrConflict) {
			t.Fatalf("role-changing Ensure err = %v, want ErrConflict", err)
		}
	})

	t.Run("get and getByID agree and report absence", func(t *testing.T) {
		store := newStore(t)
		record, _, err := store.Ensure(ctx, ref, now)
		if err != nil {
			t.Fatal(err)
		}
		byRef, err := store.Get(ctx, ref)
		if err != nil {
			t.Fatal(err)
		}
		byID, err := store.GetByID(ctx, record.ID)
		if err != nil {
			t.Fatal(err)
		}
		if byRef.ID != byID.ID || byRef.Generation != byID.Generation {
			t.Fatalf("byRef = %#v byID = %#v", byRef, byID)
		}
		// A lookup keys on organization, workspace, and session only: a
		// capability-authenticated request carries no user id.
		anonymous := ref
		anonymous.UserID = ""
		if _, err := store.Get(ctx, anonymous); err != nil {
			t.Fatalf("lookup without a user id failed: %v", err)
		}
		missing := ref
		missing.SessionID = "absent"
		if _, err := store.Get(ctx, missing); !errors.Is(err, runtime.ErrNotFound) {
			t.Fatalf("missing Get err = %v, want ErrNotFound", err)
		}
		if _, err := store.GetByID(ctx, "absent"); !errors.Is(err, runtime.ErrNotFound) {
			t.Fatalf("missing GetByID err = %v, want ErrNotFound", err)
		}
	})

	t.Run("save is generation checked", func(t *testing.T) {
		store := newStore(t)
		record, _, err := store.Ensure(ctx, ref, now)
		if err != nil {
			t.Fatal(err)
		}
		saved, err := store.Save(ctx, record)
		if err != nil {
			t.Fatal(err)
		}
		if saved.Generation <= record.Generation {
			t.Fatalf("generation did not advance: %d -> %d", record.Generation, saved.Generation)
		}
		// The stale writer must lose. Without this, two concurrent lifecycle
		// calls silently overwrite each other's provider id.
		if _, err := store.Save(ctx, record); !errors.Is(err, runtime.ErrConflict) {
			t.Fatalf("stale Save err = %v, want ErrConflict", err)
		}
		if _, err := store.Save(ctx, runtime.Record{ID: "absent", Generation: 1}); !errors.Is(err, runtime.ErrNotFound) {
			t.Fatalf("Save of a missing row err = %v, want ErrNotFound", err)
		}
	})

	t.Run("save round-trips every field the lifecycle depends on", func(t *testing.T) {
		store := newStore(t)
		record, _, err := store.Ensure(ctx, ref, now)
		if err != nil {
			t.Fatal(err)
		}
		record.ProviderID = "sbx-1"
		record.State = runtime.StateRunning
		record.DesiredState = runtime.StateStopped
		record.Error = "previous failure"
		record.LastHeartbeatAt = now.Add(time.Minute)
		record.UpdatedAt = now.Add(time.Minute)
		if _, err := store.Save(ctx, record); err != nil {
			t.Fatal(err)
		}
		reloaded, err := store.GetByID(ctx, record.ID)
		if err != nil {
			t.Fatal(err)
		}
		if reloaded.ProviderID != "sbx-1" || reloaded.State != runtime.StateRunning ||
			reloaded.DesiredState != runtime.StateStopped || reloaded.Error != "previous failure" {
			t.Fatalf("reloaded = %#v", reloaded)
		}
		if !reloaded.LastHeartbeatAt.Equal(record.LastHeartbeatAt) {
			t.Fatalf("heartbeat = %s, want %s", reloaded.LastHeartbeatAt, record.LastHeartbeatAt)
		}
		if reloaded.Role != ref.Role || reloaded.UserID != ref.UserID {
			t.Fatalf("role/user not persisted: %#v", reloaded)
		}
	})

	t.Run("delete is generation checked and converges", func(t *testing.T) {
		store := newStore(t)
		record, _, err := store.Ensure(ctx, ref, now)
		if err != nil {
			t.Fatal(err)
		}
		if err := store.Delete(ctx, record.ID, record.Generation-1); !errors.Is(err, runtime.ErrConflict) {
			t.Fatalf("stale Delete err = %v, want ErrConflict", err)
		}
		if err := store.Delete(ctx, record.ID, record.Generation); err != nil {
			t.Fatal(err)
		}
		// A retried cascade must converge, not fail on the row it already
		// removed.
		if err := store.Delete(ctx, record.ID, record.Generation); err != nil {
			t.Fatalf("repeated Delete = %v, want nil", err)
		}
		if _, err := store.Get(ctx, ref); !errors.Is(err, runtime.ErrNotFound) {
			t.Fatalf("Get after Delete err = %v, want ErrNotFound", err)
		}
	})

	t.Run("list and count honour the filter", func(t *testing.T) {
		store := newStore(t)
		refs := []runtime.Ref{
			ref,
			{OrgID: "org-1", WorkspaceID: "ws-1", SessionID: "coord-1", UserID: "user-1", Role: runtime.RoleCoordinator},
			{OrgID: "org-1", WorkspaceID: "ws-2", SessionID: "sess-2", UserID: "user-2", Role: runtime.RoleWorker},
			{OrgID: "org-2", WorkspaceID: "ws-3", SessionID: "sess-3", UserID: "user-1", Role: runtime.RoleWorker},
		}
		created := make([]runtime.Record, 0, len(refs))
		for index, candidate := range refs {
			record, _, err := store.Ensure(ctx, candidate, now.Add(time.Duration(index)*time.Second))
			if err != nil {
				t.Fatal(err)
			}
			created = append(created, record)
		}

		for name, expectation := range map[string]struct {
			filter runtime.Filter
			want   int
		}{
			"everything":           {runtime.Filter{}, 4},
			"one organization":     {runtime.Filter{OrgID: "org-1"}, 3},
			"one workspace":        {runtime.Filter{WorkspaceID: "ws-1"}, 2},
			"workers in workspace": {runtime.Filter{WorkspaceID: "ws-1", Role: runtime.RoleWorker}, 1},
			"one user across orgs": {runtime.Filter{UserID: "user-1"}, 3},
			"one session":          {runtime.Filter{OrgID: "org-1", WorkspaceID: "ws-1", SessionID: "sess-1"}, 1},
			"by state":             {runtime.Filter{States: []runtime.State{runtime.StateProvisioning}}, 4},
			"by absent state":      {runtime.Filter{States: []runtime.State{runtime.StateRunning}}, 0},
		} {
			listed, err := store.List(ctx, expectation.filter)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if len(listed) != expectation.want {
				t.Fatalf("%s: listed %d, want %d", name, len(listed), expectation.want)
			}
			counted, err := store.Count(ctx, expectation.filter)
			if err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			if counted != expectation.want {
				t.Fatalf("%s: counted %d, want %d", name, counted, expectation.want)
			}
		}

		// Quota counting must ignore placements being torn down, or a session
		// stuck mid-delete would block its own replacement forever.
		deleting := created[0]
		deleting.State = runtime.StateDeleting
		if _, err := store.Save(ctx, deleting); err != nil {
			t.Fatal(err)
		}
		live, err := store.Count(ctx, runtime.Filter{OrgID: "org-1", ExcludeTerminal: true})
		if err != nil {
			t.Fatal(err)
		}
		if live != 2 {
			t.Fatalf("live count = %d, want 2", live)
		}

		// The reconciler walks the list in a stable order.
		listed, err := store.List(ctx, runtime.Filter{})
		if err != nil {
			t.Fatal(err)
		}
		for i := 1; i < len(listed); i++ {
			if listed[i].CreatedAt.Before(listed[i-1].CreatedAt) {
				t.Fatalf("List is not oldest-first: %s before %s", listed[i].CreatedAt, listed[i-1].CreatedAt)
			}
		}
	})
}
