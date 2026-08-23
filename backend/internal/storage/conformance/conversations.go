package conformance

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func runConversations(t *testing.T, newHarness Factory) {
	t.Helper()

	t.Run("durable timeline and idempotent client messages", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		session, err := createChatSession(ctx, t, h)
		if err != nil {
			t.Fatal(err)
		}
		if err := h.Sessions.ClaimChatControllerGeneration(ctx, session.ID, "gen-1", updatedAt); err != nil {
			t.Fatal(err)
		}
		conversation, err := h.Conversations.CreateConversation(ctx, "conversation-1", domain.ConversationScopeSession, session.ProjectID, session.ID, createdAt)
		if err != nil {
			t.Fatal(err)
		}
		if conversation.ActiveBranchID != "conversation-1:root" {
			t.Fatalf("active branch = %q", conversation.ActiveBranchID)
		}

		message := domain.ConversationMessage{ID: "message-1", ClientMessageID: "client-1", Origin: domain.MessageOriginHuman, Text: "hello"}
		created, err := h.Conversations.AppendUserMessage(ctx, conversation.ID, session.ID, "gen-1", message, "turn-1", updatedAt)
		if err != nil || !created {
			t.Fatalf("append user = %v, %v", created, err)
		}
		created, err = h.Conversations.AppendUserMessage(ctx, conversation.ID, session.ID, "gen-1", message, "turn-duplicate", updatedAt)
		if err != nil || created {
			t.Fatalf("duplicate append = %v, %v", created, err)
		}
		if err := h.Conversations.BindTurnToProvider(ctx, "turn-1", "provider-turn-1", updatedAt); err != nil {
			t.Fatal(err)
		}
		if err := h.Conversations.AppendAssistantDelta(ctx, conversation.ID, "item-1", "provider-turn-1", "world", "message-2", updatedAt); err != nil {
			t.Fatal(err)
		}
		if err := h.Conversations.SettleAssistantMessage(ctx, conversation.ID, "item-1", "provider-turn-1", "world!", "message-2", updatedAt); err != nil {
			t.Fatal(err)
		}

		snapshot, err := h.Conversations.LoadConversationSnapshot(ctx, conversation.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(snapshot.Turns) != 1 || len(snapshot.Messages) != 2 {
			t.Fatalf("snapshot = %d turns, %d messages", len(snapshot.Turns), len(snapshot.Messages))
		}
		if snapshot.Messages[1].Text != "world!" || snapshot.Messages[1].Streaming {
			t.Fatalf("assistant = %#v", snapshot.Messages[1])
		}
	})

	t.Run("turn order is monotonic when timestamps tie", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		session, err := createChatSession(ctx, t, h)
		if err != nil {
			t.Fatal(err)
		}
		if err := h.Sessions.ClaimChatControllerGeneration(ctx, session.ID, "gen-1", updatedAt); err != nil {
			t.Fatal(err)
		}
		conversation, err := h.Conversations.CreateConversation(ctx, "conversation-1", domain.ConversationScopeSession, session.ProjectID, session.ID, createdAt)
		if err != nil {
			t.Fatal(err)
		}
		for i, id := range []string{"turn-z", "turn-a"} {
			_, err := h.Conversations.AppendUserMessage(ctx, conversation.ID, session.ID, "gen-1", domain.ConversationMessage{
				ID: "message-" + id, ClientMessageID: "client-" + id,
				Origin: domain.MessageOriginHuman, Text: id,
			}, id, updatedAt)
			if err != nil {
				t.Fatalf("append turn %d: %v", i, err)
			}
		}
		snapshot, err := h.Conversations.LoadConversationSnapshot(ctx, conversation.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(snapshot.Turns) != 2 || snapshot.Turns[0].ID != "turn-z" || snapshot.Turns[1].ID != "turn-a" {
			t.Fatalf("turn order = %#v", snapshot.Turns)
		}
		if _, err := h.Conversations.LoadConversationSnapshot(ctx, "missing"); !errors.Is(err, domain.ErrNoConversation) {
			t.Fatalf("missing conversation = %v", err)
		}
	})

	t.Run("provider archive and projection commit atomically", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		session, err := createChatSession(ctx, t, h)
		if err != nil {
			t.Fatal(err)
		}
		if err := h.Sessions.ClaimChatControllerGeneration(ctx, session.ID, "gen-1", updatedAt); err != nil {
			t.Fatal(err)
		}
		conversation, err := h.Conversations.CreateConversation(ctx, "conversation-1", domain.ConversationScopeSession, session.ProjectID, session.ID, createdAt)
		if err != nil {
			t.Fatal(err)
		}
		project := func(projectCtx context.Context) error {
			return h.Conversations.AppendAssistantDelta(projectCtx, conversation.ID, "item-1", "", "hello", "message-1", updatedAt)
		}
		applied, err := h.Conversations.ProjectProviderEvent(ctx, conversation.ID, session.ID, "gen-1", "event-1", "item.delta", `{}`, updatedAt, project)
		if err != nil || !applied {
			t.Fatalf("project = %v, %v", applied, err)
		}
		applied, err = h.Conversations.ProjectProviderEvent(ctx, conversation.ID, session.ID, "gen-1", "event-1", "item.delta", `{}`, updatedAt, project)
		if err != nil || applied {
			t.Fatalf("redelivery = %v, %v", applied, err)
		}
		snapshot, err := h.Conversations.LoadConversationSnapshot(ctx, conversation.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(snapshot.Messages) != 1 || snapshot.Messages[0].Text != "hello" {
			t.Fatalf("dedupe snapshot = %#v", snapshot.Messages)
		}

		rollback := errors.New("projection failed")
		_, err = h.Conversations.ProjectProviderEvent(ctx, conversation.ID, session.ID, "gen-1", "event-2", "item.delta", `{}`, time.Now(), func(projectCtx context.Context) error {
			if err := h.Conversations.AppendAssistantDelta(projectCtx, conversation.ID, "item-2", "", "must rollback", "message-2", updatedAt); err != nil {
				return err
			}
			return rollback
		})
		if !errors.Is(err, rollback) {
			t.Fatalf("rollback error = %v", err)
		}
		snapshot, err = h.Conversations.LoadConversationSnapshot(ctx, conversation.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(snapshot.Messages) != 1 {
			t.Fatalf("failed projection committed: %#v", snapshot.Messages)
		}
	})

	t.Run("project conversation rebind and reset are durable", func(t *testing.T) {
		h := newHarness(t)
		ctx := h.ctx()
		mustUpsertProject(t, h, newProject("acme", "/repos/acme"))
		first, err := createChatSession(ctx, t, h)
		if err != nil {
			t.Fatal(err)
		}
		if err := h.Sessions.ClaimChatControllerGeneration(ctx, first.ID, "gen-1", updatedAt); err != nil {
			t.Fatal(err)
		}
		conversation, err := h.Conversations.CreateConversation(ctx, "project-conversation", domain.ConversationScopeProject, first.ProjectID, first.ID, createdAt)
		if err != nil {
			t.Fatal(err)
		}
		_, err = h.Conversations.AppendUserMessage(ctx, conversation.ID, first.ID, "gen-1", domain.ConversationMessage{ID: "message-1", ClientMessageID: "client-1", Origin: domain.MessageOriginHuman, Text: "old context"}, "turn-1", updatedAt)
		if err != nil {
			t.Fatal(err)
		}
		second, err := createChatSession(ctx, t, h)
		if err != nil {
			t.Fatal(err)
		}
		reset := domain.ConversationActivity{ID: "reset-1", ProviderItemID: "context-reset-1", Kind: domain.ActivityKindSystem, Status: domain.ActivityStatusCompleted, Summary: "Fresh orchestrator context"}
		rebound, err := h.Conversations.CreateProjectConversationWithContextReset(ctx, "unused", first.ProjectID, second.ID, reset, updatedAt.Add(time.Second))
		if err != nil {
			t.Fatal(err)
		}
		if rebound.ID != conversation.ID || rebound.SessionID != second.ID {
			t.Fatalf("rebound = %#v", rebound)
		}
		snapshot, err := h.Conversations.LoadConversationSnapshot(ctx, conversation.ID)
		if err != nil {
			t.Fatal(err)
		}
		if len(snapshot.Activities) != 1 || snapshot.Activities[0].ProviderItemID != reset.ProviderItemID {
			t.Fatalf("reset activities = %#v", snapshot.Activities)
		}
		bySession, err := h.Conversations.ConversationForSession(ctx, second.ID)
		if err != nil || bySession.ID != conversation.ID {
			t.Fatalf("conversation for replacement = %#v, %v", bySession, err)
		}
	})
}

func createChatSession(ctx context.Context, t *testing.T, h Harness) (domain.SessionRecord, error) {
	t.Helper()
	rec := newSession("acme")
	rec.Mode = domain.SessionModeChat
	rec.Metadata.ProviderConversationID = "provider-conversation-1"
	return h.Sessions.CreateSession(ctx, rec)
}
