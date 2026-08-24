package postgres_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/capability"
	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres/pgtest"
	cloudruntime "github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/terminalticket"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

func computeHarness(t *testing.T) (*postgres.Store, context.Context, tenant.Identity, string) {
	t.Helper()
	store := pgtest.New(t)
	identity := signUp(t, store, "compute")
	ctx := tenant.WithIdentity(context.Background(), identity)
	placement, _, err := store.CreateWorkspacePlacement(ctx, clouddomain.CreateWorkspacePlacement{
		RepositoryURL: "https://github.com/example/compute.git", IdempotencyKey: "compute-workspace",
	})
	if err != nil {
		t.Fatal(err)
	}
	return store, ctx, identity, placement.ID
}

func TestPostgresRuntimeReservationIsAtomicAndCASChecked(t *testing.T) {
	store, ctx, identity, workspace := computeHarness(t)
	quotas := cloudruntime.Quotas{MaxSandboxesPerOrg: 1, MaxSandboxesPerUser: 1, MaxWorkersPerWorkspace: 1, MaxCoordinatorsPerWorkspace: 1}
	refs := []cloudruntime.Ref{
		{OrgID: identity.OrgID, UserID: identity.UserID, WorkspaceID: workspace, SessionID: "worker-1", Role: cloudruntime.RoleWorker},
		{OrgID: identity.OrgID, UserID: identity.UserID, WorkspaceID: workspace, SessionID: "worker-2", Role: cloudruntime.RoleWorker},
	}
	var wg sync.WaitGroup
	errs := make(chan error, 2)
	for _, ref := range refs {
		wg.Add(1)
		go func() { defer wg.Done(); _, _, err := store.Reserve(ctx, ref, quotas, time.Now()); errs <- err }()
	}
	wg.Wait()
	close(errs)
	successes, limited := 0, 0
	for err := range errs {
		if err == nil {
			successes++
		} else {
			var quota *cloudruntime.QuotaError
			if errors.As(err, &quota) {
				limited++
			} else {
				t.Fatalf("reserve: %v", err)
			}
		}
	}
	if successes != 1 || limited != 1 {
		t.Fatalf("successes=%d quota failures=%d", successes, limited)
	}
	records, err := store.List(ctx, cloudruntime.Filter{WorkspaceID: workspace})
	if err != nil || len(records) != 1 {
		t.Fatalf("records=%v err=%v", records, err)
	}
	stale := records[0]
	records[0].State = cloudruntime.StateRunning
	records[0].UpdatedAt = time.Now()
	saved, err := store.Save(ctx, records[0])
	if err != nil {
		t.Fatal(err)
	}
	stale.State = cloudruntime.StateDeleting
	stale.UpdatedAt = time.Now()
	if _, err = store.Save(ctx, stale); !errors.Is(err, cloudruntime.ErrConflict) {
		t.Fatalf("stale save=%v", err)
	}
	if err = store.Delete(ctx, saved.ID, saved.Generation-1); !errors.Is(err, cloudruntime.ErrConflict) {
		t.Fatalf("stale delete=%v", err)
	}
}

func TestPostgresCapabilityIssueVerifyAndRevoke(t *testing.T) {
	store, ctx, identity, workspace := computeHarness(t)
	adapter := postgres.NewCapabilityStore(store)
	authority, err := capability.New(adapter, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	scope := capability.Scope{OrgID: identity.OrgID, WorkspaceID: workspace, SessionID: "worker-1", Role: capability.RoleWorker, Operations: []capability.Operation{capability.OpSessionRead}}
	grant, err := authority.Issue(ctx, scope, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = authority.Verify(ctx, grant.Token, capability.OpSessionRead); err != nil {
		t.Fatal(err)
	}
	if _, err = authority.RevokeScope(ctx, capability.Selector{OrgID: identity.OrgID, WorkspaceID: workspace, SessionID: "worker-1"}); err != nil {
		t.Fatal(err)
	}
	if _, err = authority.Verify(ctx, grant.Token, capability.OpSessionRead); !errors.Is(err, capability.ErrRevoked) {
		t.Fatalf("verify revoked=%v", err)
	}
}

func TestPostgresTerminalTicketIsOneTimeAndTupleBound(t *testing.T) {
	store, ctx, identity, workspace := computeHarness(t)
	authority, err := terminalticket.New(postgres.NewTerminalTicketStore(store), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	binding := terminalticket.Binding{OrgID: identity.OrgID, WorkspaceID: workspace, SessionID: "worker-1", SandboxID: "sandbox-1"}
	ticket, err := authority.Issue(ctx, binding, []terminalticket.Scope{terminalticket.ScopeRead, terminalticket.ScopeOperate})
	if err != nil {
		t.Fatal(err)
	}
	wrong := binding
	wrong.SandboxID = "sandbox-2"
	if _, err = authority.Consume(ctx, ticket.Token, wrong); !errors.Is(err, terminalticket.ErrInvalid) {
		t.Fatalf("wrong tuple=%v", err)
	}
	if _, err = authority.Consume(ctx, ticket.Token, binding); err != nil {
		t.Fatal(err)
	}
	if _, err = authority.Consume(ctx, ticket.Token, binding); !errors.Is(err, terminalticket.ErrInvalid) {
		t.Fatalf("second consume=%v", err)
	}
}
