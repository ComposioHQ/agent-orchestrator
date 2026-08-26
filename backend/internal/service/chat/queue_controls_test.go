package chat_test

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
)

// A turn-scoped cancellation is intentionally narrower than Stop: it settles
// only the selected durable prompt and neither interrupts the provider nor
// changes the relative order of queue siblings.
func TestCancelSelectedQueuedTurnPreservesActiveTurnAndSiblingQueue(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	running, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "active work", ClientMessageID: "active", Origin: domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("start active turn: %v", err)
	}
	cancelled, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "cancel me", ClientMessageID: "cancel", Origin: domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("queue selected turn: %v", err)
	}
	kept, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "keep me", ClientMessageID: "keep", Origin: domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("queue sibling turn: %v", err)
	}

	if err := h.svc.CancelQueuedTurn(ctx, testSession, cancelled.ID); err != nil {
		t.Fatalf("cancel selected queued turn: %v", err)
	}

	snapshot, err := h.st.LoadConversationSnapshot(ctx, h.ctrl.ConversationID())
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	states := turnStateByText(t, snapshot)
	if states["active work"] != domain.TurnStateRunning {
		t.Errorf("active turn = %q, want running", states["active work"])
	}
	if states["cancel me"] != domain.TurnStateInterrupted {
		t.Errorf("selected turn = %q, want interrupted", states["cancel me"])
	}
	if states["keep me"] != domain.TurnStateQueued {
		t.Errorf("sibling turn = %q, want queued", states["keep me"])
	}
	if got := h.conv.sentTexts(); len(got) != 1 || got[0] != "active work" {
		t.Fatalf("provider received %v, want only active work", got)
	}
	next, err := h.st.NextQueuedTurn(ctx, h.ctrl.ConversationID())
	if err != nil || next.TurnID != kept.ID {
		t.Fatalf("remaining queue head = %+v, %v; want %s", next, err, kept.ID)
	}

	if err := h.svc.CancelQueuedTurn(ctx, testSession, running.ID); !errors.Is(err, chatsvc.ErrTurnNotQueued) {
		t.Fatalf("cancel running turn error = %v, want ErrTurnNotQueued", err)
	}
	if err := h.svc.CancelQueuedTurn(ctx, testSession, "missing-turn"); !errors.Is(err, domain.ErrNoConversationTurn) {
		t.Fatalf("cancel missing turn error = %v, want ErrNoConversationTurn", err)
	}
	if err := h.svc.CancelQueuedTurn(ctx, "wrong-session", kept.ID); !errors.Is(err, ports.ErrSessionNotFound) {
		t.Fatalf("cancel through wrong session error = %v, want ErrSessionNotFound", err)
	}
}
