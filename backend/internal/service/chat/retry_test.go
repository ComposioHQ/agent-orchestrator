package chat_test

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

// Retry scenarios.
//
// The promise under test is the issue #4215 contract: a failed human turn can be
// re-dispatched as a NEW turn whose content the daemon reads from its own durable
// rows — never from a caller-supplied payload — while the original failed attempt
// stays failed and visible. Refusals are typed, not silent.

func failedTurnSnapshot(t *testing.T, h *harness, turnID string) store.ConversationSnapshot {
	t.Helper()
	return h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		for _, turn := range s.Turns {
			if turn.ID == turnID && turn.State == domain.TurnStateFailed {
				return true
			}
		}
		return false
	})
}

func turnByID(s store.ConversationSnapshot, id string) (domain.ConversationTurn, bool) {
	for _, turn := range s.Turns {
		if turn.ID == id {
			return turn, true
		}
	}
	return domain.ConversationTurn{}, false
}

func TestRetryTurnDispatchesFailedPromptAsNewTurn(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	turn, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text:            "summarize the failing CI run",
		ClientMessageID: "cm-1",
		Origin:          domain.MessageOriginHuman,
		Content: []ports.ChatContent{{
			Type: "resource", URI: "file:///worktree/ci-log.txt", Name: "ci-log.txt",
		}},
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if turn.State != domain.TurnStateRunning {
		t.Fatalf("turn state after dispatch = %q, want running", turn.State)
	}

	// The provider fails the turn asynchronously after a transient network loss.
	h.conv.emit(ports.ChatEvent{
		Kind:           ports.ChatEventTurnCompleted,
		ProviderTurnID: turn.ProviderTurnID,
		TurnState:      domain.TurnStateFailed,
		Err:            errors.New("stream disconnected before completion"),
	})
	snapshot := failedTurnSnapshot(t, h, turn.ID)
	failed, _ := turnByID(snapshot, turn.ID)
	if failed.ErrorMessage != "stream disconnected before completion" {
		t.Fatalf("failed turn error = %q, want the transport error", failed.ErrorMessage)
	}

	// Retry re-dispatches the same durable prompt as a brand-new turn.
	retried, err := h.svc.RetryTurn(ctx, testSession, turn.ID)
	if err != nil {
		t.Fatalf("RetryTurn: %v", err)
	}
	if retried.ID == "" || retried.ID == turn.ID {
		t.Fatalf("retried turn id = %q, want a new turn distinct from %q", retried.ID, turn.ID)
	}
	if retried.State != domain.TurnStateRunning {
		t.Fatalf("retried turn state = %q, want running", retried.State)
	}

	// The provider received exactly two sends, with the same prompt text.
	sent := h.conv.sentTexts()
	if len(sent) != 2 {
		t.Fatalf("provider received %d sends, want 2: %v", len(sent), sent)
	}
	if sent[1] != "summarize the failing CI run" {
		t.Fatalf("second send text = %q, want the original prompt", sent[1])
	}

	// Both attempts are durable: the original is still failed, the retry is a
	// separate turn.
	after := h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		_, ok := turnByID(s, retried.ID)
		return ok && len(s.Turns) == 2
	})
	original, ok := turnByID(after, turn.ID)
	if !ok || original.State != domain.TurnStateFailed {
		t.Fatalf("original turn after retry = %+v, want it to remain failed", original)
	}
	if original.ErrorMessage != "stream disconnected before completion" {
		t.Fatalf("original turn error changed to %q, want it preserved", original.ErrorMessage)
	}
}

func TestRetryTurnRefusesNonFailedTurn(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	turn, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text:            "what changed?",
		ClientMessageID: "cm-2",
		Origin:          domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	// Complete the turn, so it is terminal but not failed.
	h.conv.emit(ports.ChatEvent{
		Kind:           ports.ChatEventTurnCompleted,
		ProviderTurnID: turn.ProviderTurnID,
		TurnState:      domain.TurnStateCompleted,
	})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		t, ok := turnByID(s, turn.ID)
		return ok && t.State == domain.TurnStateCompleted
	})

	if _, err := h.svc.RetryTurn(ctx, testSession, turn.ID); !errors.Is(err, chatsvc.ErrTurnNotRetryable) {
		t.Fatalf("RetryTurn on a completed turn = %v, want ErrTurnNotRetryable", err)
	}
	// Nothing was re-dispatched.
	if sent := h.conv.sentTexts(); len(sent) != 1 {
		t.Fatalf("provider received %d sends after refused retry, want 1", len(sent))
	}
}

func TestRetryTurnRefusesWhileBusy(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	// First turn fails, leaving it eligible for retry.
	turn, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text:            "first",
		ClientMessageID: "cm-3",
		Origin:          domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	h.conv.emit(ports.ChatEvent{
		Kind:           ports.ChatEventTurnCompleted,
		ProviderTurnID: turn.ProviderTurnID,
		TurnState:      domain.TurnStateFailed,
		Err:            errors.New("boom"),
	})
	failedTurnSnapshot(t, h, turn.ID)

	// A second turn is now running.
	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text:            "second",
		ClientMessageID: "cm-4",
		Origin:          domain.MessageOriginHuman,
	}); err != nil {
		t.Fatalf("Send second: %v", err)
	}

	// Retrying the failed first turn is refused while another turn runs.
	if _, err := h.svc.RetryTurn(ctx, testSession, turn.ID); !errors.Is(err, chatsvc.ErrTurnRunning) {
		t.Fatalf("RetryTurn while busy = %v, want ErrTurnRunning", err)
	}
}

func TestRetryTurnRefusesFailedTurnOutsideActiveBranch(t *testing.T) {
	h, _, driver := newEditHarness(t)
	ctx := context.Background()

	first := completeTurn(t, h, "first prompt", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })
	stale, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "stale failed prompt", Origin: domain.MessageOriginHuman, ClientMessageID: "stale-source",
	})
	if err != nil {
		t.Fatalf("Send stale source: %v", err)
	}
	h.conv.emit(ports.ChatEvent{
		Kind: ports.ChatEventTurnCompleted, ProviderTurnID: stale.ProviderTurnID,
		TurnState: domain.TurnStateFailed, Err: errors.New("source failed"),
	})
	failedTurnSnapshot(t, h, stale.ID)

	// Editing the first prompt forks before the failed second turn, so the
	// failed source remains durable but is no longer on the active lineage.
	edited, err := h.svc.EditMessage(ctx, testSession, first, ports.ChatUserMessage{
		Text: "edited first prompt", Origin: domain.MessageOriginHuman, ClientMessageID: "edited-first",
	})
	if err != nil {
		t.Fatalf("EditMessage: %v", err)
	}
	driver.fresh.emit(
		ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: edited.Turn.ProviderTurnID},
		ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: edited.Turn.ProviderTurnID, TurnState: domain.TurnStateCompleted},
	)
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		turn, ok := turnByID(s, edited.Turn.ID)
		return ok && turn.State == domain.TurnStateCompleted
	})

	if _, err := h.svc.RetryTurn(ctx, testSession, stale.ID); !errors.Is(err, chatsvc.ErrRetryStaleBranch) {
		t.Fatalf("RetryTurn outside active branch = %v, want ErrRetryStaleBranch", err)
	}
}

func TestRetryTurnRefusesNonHumanPrompt(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	turn, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text:            "automated relay",
		ClientMessageID: "cm-5",
		Origin:          domain.MessageOriginAutomation,
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	h.conv.emit(ports.ChatEvent{
		Kind:           ports.ChatEventTurnCompleted,
		ProviderTurnID: turn.ProviderTurnID,
		TurnState:      domain.TurnStateFailed,
		Err:            errors.New("boom"),
	})
	failedTurnSnapshot(t, h, turn.ID)

	if _, err := h.svc.RetryTurn(ctx, testSession, turn.ID); !errors.Is(err, chatsvc.ErrTurnNotRetryable) {
		t.Fatalf("RetryTurn on automation-origin turn = %v, want ErrTurnNotRetryable", err)
	}
}

func TestRetryTurnReplaysReturnExistingAttempt(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	turn, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text:            "retry me once",
		ClientMessageID: "cm-6",
		Origin:          domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	h.conv.emit(ports.ChatEvent{
		Kind:           ports.ChatEventTurnCompleted,
		ProviderTurnID: turn.ProviderTurnID,
		TurnState:      domain.TurnStateFailed,
		Err:            errors.New("boom"),
	})
	failedTurnSnapshot(t, h, turn.ID)

	first, err := h.svc.RetryTurn(ctx, testSession, turn.ID)
	if err != nil {
		t.Fatalf("first RetryTurn: %v", err)
	}

	// A replay of the same request — an uncertain round trip or a double-click —
	// must return the attempt that already exists rather than opening another.
	second, err := h.svc.RetryTurn(ctx, testSession, turn.ID)
	if err != nil {
		t.Fatalf("replayed RetryTurn: %v", err)
	}
	if second.ID != first.ID {
		t.Fatalf("replay opened turn %q, want the existing attempt %q", second.ID, first.ID)
	}
	sent := h.conv.sentTexts()
	if len(sent) != 2 {
		t.Fatalf("provider received %d sends after replay, want exactly 2: %v", len(sent), sent)
	}

	// Even after the first attempt settles, the source keeps answering with it
	// instead of minting another attempt.
	h.conv.emit(ports.ChatEvent{
		Kind:           ports.ChatEventTurnCompleted,
		ProviderTurnID: first.ProviderTurnID,
		TurnState:      domain.TurnStateCompleted,
	})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		t, ok := turnByID(s, first.ID)
		return ok && t.State == domain.TurnStateCompleted
	})
	third, err := h.svc.RetryTurn(ctx, testSession, turn.ID)
	if err != nil {
		t.Fatalf("post-settlement RetryTurn: %v", err)
	}
	if third.ID != first.ID {
		t.Fatalf("post-settlement replay opened turn %q, want the existing attempt %q", third.ID, first.ID)
	}
	if got := h.conv.sentTexts(); len(got) != 2 {
		t.Fatalf("provider received %d sends after all replays, want exactly 2: %v", len(got), got)
	}
}

// A deliberate further attempt is expressed by retrying the failed RETRY turn,
// which owns its own deterministic key. That builds the chain A -> B -> C from
// distinct sources instead of ever re-sending A.
func TestRetryChainThroughFailedAttempt(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	a, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text:            "deploy the service",
		ClientMessageID: "cm-7",
		Origin:          domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	fail := func(turn domain.ConversationTurn) {
		h.conv.emit(ports.ChatEvent{
			Kind:           ports.ChatEventTurnCompleted,
			ProviderTurnID: turn.ProviderTurnID,
			TurnState:      domain.TurnStateFailed,
			Err:            errors.New("still down"),
		})
	}
	fail(a)
	failedTurnSnapshot(t, h, a.ID)

	b, err := h.svc.RetryTurn(ctx, testSession, a.ID)
	if err != nil {
		t.Fatalf("retry A: %v", err)
	}
	if b.ID == a.ID {
		t.Fatalf("retry of A reused A's id")
	}
	fail(b)
	failedTurnSnapshot(t, h, b.ID)

	c, err := h.svc.RetryTurn(ctx, testSession, b.ID)
	if err != nil {
		t.Fatalf("retry B: %v", err)
	}
	if c.ID == a.ID || c.ID == b.ID {
		t.Fatalf("retry of B produced id %q, want a distinct third turn (a=%q b=%q)", c.ID, a.ID, b.ID)
	}
	if c.State != domain.TurnStateRunning {
		t.Fatalf("chained retry state = %q, want running", c.State)
	}
	sent := h.conv.sentTexts()
	if len(sent) != 3 {
		t.Fatalf("provider received %d sends across the chain, want 3: %v", len(sent), sent)
	}
	for i, text := range sent {
		if text != "deploy the service" {
			t.Fatalf("send %d text = %q, want the original prompt throughout the chain", i+1, text)
		}
	}
}

// A dispatch the provider never acknowledged may still have been accepted, so
// re-dispatching it could run the work twice. These turns are refused with a
// typed uncertain-delivery error rather than retried.
func TestRetryTurnRefusesUnconfirmedDispatch(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()

	h.conv.sendErr = errors.New("connection reset before response")
	turn, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text:            "uncertain delivery",
		ClientMessageID: "cm-8",
		Origin:          domain.MessageOriginHuman,
	})
	h.conv.sendErr = nil
	if err == nil {
		t.Fatalf("Send with a failing provider = nil error, want the dispatch failure")
	}
	if turn.ID == "" || turn.State != domain.TurnStateFailed {
		t.Fatalf("undispatched turn = %+v, want a failed turn with an AO id", turn)
	}
	snapshot := failedTurnSnapshot(t, h, turn.ID)
	if settled, ok := turnByID(snapshot, turn.ID); !ok || settled.ProviderTurnID != "" {
		t.Fatalf("failed turn provider id = %q, want empty (never accepted)", settled.ProviderTurnID)
	}

	if _, err := h.svc.RetryTurn(ctx, testSession, turn.ID); !errors.Is(err, chatsvc.ErrRetryDeliveryUncertain) {
		t.Fatalf("RetryTurn on unconfirmed dispatch = %v, want ErrRetryDeliveryUncertain", err)
	}
	if sent := h.conv.sentTexts(); len(sent) != 0 {
		t.Fatalf("provider received %d sends after refused retry, want 0: %v", len(sent), sent)
	}
}
