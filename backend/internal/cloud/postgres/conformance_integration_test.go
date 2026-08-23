package postgres_test

import (
	"context"
	"testing"
	"time"

	clouddomain "github.com/aoagents/agent-orchestrator/backend/internal/cloud/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/postgres/pgtest"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	storageports "github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/conformance"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

// The hosted store is the cloud-mode implementation of the storage ports. These
// assertions fail at compile time if a port method is added without it.
var (
	_ storageports.ProjectStore         = (*postgres.Store)(nil)
	_ storageports.SessionStore         = (*postgres.Store)(nil)
	_ storageports.SessionWorktreeStore = (*postgres.Store)(nil)
	_ storageports.ConversationStore    = (*postgres.Store)(nil)
	_ storageports.ConversationReader   = (*postgres.Store)(nil)
)

// TestPostgresStorageConformance runs the same suite the SQLite store runs. It
// is the only thing that makes "either store, same services" a claim rather
// than an intention.
func TestPostgresStorageConformance(t *testing.T) {
	conformance.Run(t, func(t *testing.T) conformance.Harness {
		store := pgtest.New(t)
		alice := signUp(t, store, "alice")
		bob := signUp(t, store, "bob")
		return conformance.Harness{
			Projects:      store,
			Sessions:      store,
			Worktrees:     store,
			Conversations: store,
			Ctx:           tenant.WithIdentity(context.Background(), alice),
			OtherTenant: &conformance.Harness{
				Projects:      store,
				Sessions:      store,
				Worktrees:     store,
				Conversations: store,
				Ctx:           tenant.WithIdentity(context.Background(), bob),
			},
		}
	})
}

func TestPostgresRejectsStaleConversationGeneration(t *testing.T) {
	store := pgtest.New(t)
	alice := signUp(t, store, "stale-generation")
	ctx := tenant.WithIdentity(context.Background(), alice)
	project := newTenantProject()
	if err := store.UpsertProject(ctx, project); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 3, 14, 15, 9, 26, 0, time.UTC)
	session, err := store.CreateSession(ctx, domain.SessionRecord{
		ProjectID: domain.ProjectID(project.ID), Kind: domain.KindWorker,
		Harness: domain.HarnessClaudeCode, Mode: domain.SessionModeChat,
		Activity:  domain.Activity{State: domain.ActivityIdle, LastActivityAt: now},
		CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.ClaimChatControllerGeneration(ctx, session.ID, "current", now); err != nil {
		t.Fatal(err)
	}
	conversation, err := store.CreateConversation(ctx, "conversation-1", domain.ConversationScopeSession, session.ProjectID, session.ID, now)
	if err != nil {
		t.Fatal(err)
	}
	created, err := store.AppendUserMessage(ctx, conversation.ID, session.ID, "stale", domain.ConversationMessage{
		ID: "message-1", ClientMessageID: "client-1", Origin: domain.MessageOriginHuman, Text: "must not persist",
	}, "turn-1", now)
	if err != nil || created {
		t.Fatalf("stale append = %v, %v", created, err)
	}
	snapshot, err := store.LoadConversationSnapshot(ctx, conversation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Turns) != 0 || len(snapshot.Messages) != 0 {
		t.Fatalf("stale append persisted: %#v", snapshot)
	}
}

// TestPostgresRefusesAnUnscopedContext pins the behaviour that makes the tenant
// boundary safe by construction: a request that lost its tenant fails rather
// than running an unscoped query. Row-level security would return nothing here
// anyway, but a store that silently returns "no projects" for a bug in the auth
// middleware is a store that hides the bug.
func TestPostgresRefusesAnUnscopedContext(t *testing.T) {
	store := pgtest.New(t)
	ctx := context.Background()

	if _, err := store.ListProjects(ctx); !isTenantRequired(err) {
		t.Fatalf("ListProjects without a tenant = %v, want ErrTenantRequired", err)
	}
	if _, err := store.ListAllSessions(ctx); !isTenantRequired(err) {
		t.Fatalf("ListAllSessions without a tenant = %v, want ErrTenantRequired", err)
	}
	if err := store.UpsertProject(ctx, newTenantProject()); !isTenantRequired(err) {
		t.Fatalf("UpsertProject without a tenant = %v, want ErrTenantRequired", err)
	}

	// A half-populated tenant is a bug, not a partial scope: row-level security
	// keys on both halves, so accepting one would query with the other unset.
	half := tenant.WithIdentity(ctx, tenant.Identity{UserID: "not-a-uuid"})
	if _, err := store.ListProjects(half); !isTenantRequired(err) {
		t.Fatalf("ListProjects with half a tenant = %v, want ErrTenantRequired", err)
	}
}

func signUp(t *testing.T, store *postgres.Store, name string) tenant.Identity {
	t.Helper()
	ctx := context.Background()
	principal, err := store.UpsertGoogleUser(ctx, clouddomain.Principal{
		ExternalID:  "google-" + name,
		Email:       name + "@example.com",
		DisplayName: name,
	})
	if err != nil {
		t.Fatalf("sign up %s: %v", name, err)
	}
	memberships, err := store.ListMemberships(ctx, principal)
	if err != nil {
		t.Fatalf("list memberships for %s: %v", name, err)
	}
	if len(memberships) != 1 {
		t.Fatalf("%s has %d memberships, want the personal org", name, len(memberships))
	}
	return tenant.Identity{UserID: principal.UserID, OrgID: memberships[0].OrgID}
}
