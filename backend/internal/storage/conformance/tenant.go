package conformance

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// runTenantIsolation asserts what a tenant-scoped store must guarantee: one
// tenant's rows are not readable, writable, or even countable by another, and
// the two tenants may use identical AO identifiers without colliding. Project
// and session ids ("acme", "acme-1") are user-chosen and per-tenant unique, not
// globally unique, so a store that keys on them alone silently merges tenants.
//
// Implementations with no tenancy leave Harness.OtherTenant nil and skip.
func runTenantIsolation(t *testing.T, newHarness Factory) {
	t.Helper()

	h := newHarness(t)
	if h.OtherTenant == nil {
		t.Skip("implementation is not tenant-scoped")
	}
	other := *h.OtherTenant
	ctx, otherCtx := h.ctx(), other.ctx()

	t.Run("both tenants may register the same project id and path", func(t *testing.T) {
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		mine, ok, err := h.Projects.GetProject(ctx, "acme")
		if err != nil || !ok {
			t.Fatalf("GetProject(mine) = %v, %v", ok, err)
		}
		if got, ok, err := other.Projects.GetProject(otherCtx, "acme"); ok || err != nil {
			t.Fatalf("the other tenant can see project %q: %#v, %v, %v", mine.ID, got, ok, err)
		}

		theirs := newProject("acme", "/repos/acme")
		theirs.DisplayName = "Their Acme"
		if err := other.Projects.UpsertProject(otherCtx, theirs); err != nil {
			t.Fatalf("the other tenant cannot register the same project id: %v", err)
		}
		mine, _, err = h.Projects.GetProject(ctx, "acme")
		if err != nil {
			t.Fatalf("GetProject: %v", err)
		}
		if mine.DisplayName == "Their Acme" {
			t.Fatal("the other tenant's write landed on this tenant's row")
		}
	})

	t.Run("lists and counts never span tenants", func(t *testing.T) {
		list, err := h.Projects.ListProjects(ctx)
		if err != nil {
			t.Fatalf("ListProjects: %v", err)
		}
		if len(list) != 1 {
			t.Fatalf("ListProjects returned %d rows, want only this tenant's 1: %v", len(list), projectIDs(list))
		}
		count, err := h.Projects.CountProjectsIncludingArchived(ctx)
		if err != nil || count != 1 {
			t.Fatalf("CountProjectsIncludingArchived = %d, %v, want 1", count, err)
		}
	})

	t.Run("a cross-tenant write reports a miss rather than mutating", func(t *testing.T) {
		if ok, err := other.Projects.ArchiveProject(otherCtx, "acme", registeredAt); err == nil && ok {
			// Archiving their own project of the same id is legitimate; only a
			// change to this tenant's row is a leak.
			mine, _, err := h.Projects.GetProject(ctx, "acme")
			if err != nil {
				t.Fatalf("GetProject: %v", err)
			}
			if !mine.ArchivedAt.IsZero() {
				t.Fatal("the other tenant archived this tenant's project")
			}
		}
	})

	t.Run("session numbering and lookups are per tenant", func(t *testing.T) {
		mine := mustCreateSession(t, h, newSession("acme"))
		theirs, err := other.Sessions.CreateSession(otherCtx, newSession("acme"))
		if err != nil {
			t.Fatalf("the other tenant cannot create a session: %v", err)
		}
		if mine.ID != theirs.ID {
			t.Fatalf("per-tenant numbering diverged: %q vs %q", mine.ID, theirs.ID)
		}
		if _, err := other.Sessions.RenameSession(otherCtx, mine.ID, "hijacked", updatedAt); err != nil {
			t.Fatalf("RenameSession across tenants: %v", err)
		}
		got, ok, err := h.Sessions.GetSession(ctx, mine.ID)
		if err != nil || !ok {
			t.Fatalf("GetSession = %v, %v", ok, err)
		}
		if got.DisplayName == "hijacked" {
			t.Fatal("the other tenant renamed this tenant's session")
		}
		all, err := h.Sessions.ListAllSessions(ctx)
		if err != nil || len(all) != 1 {
			t.Fatalf("ListAllSessions = %v, %v, want only this tenant's session", sessionIDs(all), err)
		}
	})

	t.Run("worktrees are per tenant", func(t *testing.T) {
		const session = domain.SessionID("acme-1")
		if err := h.Worktrees.UpsertSessionWorktree(ctx, newWorktree(session, domain.RootWorkspaceRepoName, "/work/mine")); err != nil {
			t.Fatalf("UpsertSessionWorktree: %v", err)
		}
		if err := other.Worktrees.UpsertSessionWorktree(otherCtx, newWorktree(session, domain.RootWorkspaceRepoName, "/work/theirs")); err != nil {
			t.Fatalf("the other tenant cannot register the same session worktree: %v", err)
		}
		got, ok, err := h.Worktrees.GetSessionWorktree(ctx, session, domain.RootWorkspaceRepoName)
		if err != nil || !ok {
			t.Fatalf("GetSessionWorktree = %v, %v", ok, err)
		}
		if got.WorktreePath != "/work/mine" {
			t.Fatalf("worktree path = %q, want /work/mine", got.WorktreePath)
		}
		if err := other.Worktrees.DeleteSessionWorktrees(otherCtx, session); err != nil {
			t.Fatalf("DeleteSessionWorktrees: %v", err)
		}
		if rows, err := h.Worktrees.ListSessionWorktrees(ctx, session); err != nil || len(rows) != 1 {
			t.Fatalf("the other tenant deleted this tenant's worktrees: %#v, %v", rows, err)
		}
	})
}
