package chat_test

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	chatsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/chat"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

// historyRecorder is a provider double that CAN do the history operations, so a test
// can tell "the driver refuses" from "the driver does not offer this at all". The
// plain fakeConversation implements none of the three, which is what the unsupported
// paths exercise.
type historyRecorder struct {
	*fakeConversation

	mu           sync.Mutex
	rolledBack   []string
	titles       []string
	forkedTo     string
	rollbackErr  error
	setTitleErr  error
	forkErr      error
	forkAnchors  []*string
	echoRenameTo string
}

func newHistoryRecorder() *historyRecorder {
	return &historyRecorder{fakeConversation: newFakeConversation(), forkedTo: "thread-forked"}
}

func (h *historyRecorder) Rollback(_ context.Context, providerTurnID string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rollbackErr != nil {
		return h.rollbackErr
	}
	h.rolledBack = append(h.rolledBack, providerTurnID)
	return nil
}

func (h *historyRecorder) Fork(_ context.Context, anchor *string) (string, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if anchor == nil {
		h.forkAnchors = append(h.forkAnchors, nil)
	} else {
		anchorCopy := *anchor
		h.forkAnchors = append(h.forkAnchors, &anchorCopy)
	}
	if h.forkErr != nil {
		return "", h.forkErr
	}
	return h.forkedTo, nil
}

func (h *historyRecorder) lastForkAnchor() *string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.forkAnchors) == 0 {
		return nil
	}
	anchor := h.forkAnchors[len(h.forkAnchors)-1]
	if anchor == nil {
		return nil
	}
	anchorCopy := *anchor
	return &anchorCopy
}

// SetTitle records the name and, like the real provider, reports it back on the event
// stream. That echo is the only path by which a title reaches AO's rows.
func (h *historyRecorder) SetTitle(_ context.Context, title string) error {
	h.mu.Lock()
	if h.setTitleErr != nil {
		err := h.setTitleErr
		h.mu.Unlock()
		return err
	}
	h.titles = append(h.titles, title)
	echo := h.echoRenameTo
	h.mu.Unlock()

	if echo == "" {
		echo = title
	}
	h.emit(ports.ChatEvent{Kind: ports.ChatEventThreadRenamed, Title: echo})
	return nil
}

func (h *historyRecorder) rollbackTargets() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.rolledBack...)
}

func (h *historyRecorder) setTitles() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.titles...)
}

// refusedError is what a driver returns when the provider itself declined. The
// service classifies it structurally, which is what keeps an ordinary "not right now"
// from surfacing as an internal failure.
type refusedError struct{ msg string }

func (e refusedError) Error() string     { return e.msg }
func (e refusedError) ChatRefusal() bool { return true }

// completeTurn sends a message and drives it to completion, leaving one settled turn.
func completeTurn(t *testing.T, h *harness, text, providerTurn string) string {
	t.Helper()
	turn, err := h.svc.Send(context.Background(), testSession, ports.ChatUserMessage{
		Text:   text,
		Origin: domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("Send %q: %v", text, err)
	}
	h.conv.emit(
		ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: providerTurn},
		ports.ChatEvent{
			Kind: ports.ChatEventMessageCompleted, ProviderTurnID: providerTurn,
			ProviderItemID: "msg-" + providerTurn, Text: "reply to " + text,
		},
		ports.ChatEvent{
			Kind: ports.ChatEventTurnCompleted, ProviderTurnID: providerTurn,
			TurnState: domain.TurnStateCompleted,
		},
	)
	return turn.ID
}

func requireMessageTexts(t *testing.T, messages []domain.ConversationMessage, want []string) {
	t.Helper()
	got := make([]string, 0, len(messages))
	for _, message := range messages {
		got = append(got, message.Text)
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("message texts = %#v, want %#v", got, want)
	}
}

// The end-to-end shape of an undo: the provider is asked to forget, and AO's timeline
// stops showing what it forgot.
func TestRollbackDiscardsTheTurnAndEverythingAfterIt(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)
	ctx := context.Background()

	completeTurn(t, h, "first", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })
	second := completeTurn(t, h, "second", "provider-turn-2")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 4 })

	discarded, err := h.svc.Rollback(ctx, testSession, second)
	if err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	if discarded != 1 {
		t.Errorf("discarded = %d, want 1", discarded)
	}

	// The provider is named by ITS turn id, not AO's: they are different namespaces
	// and sending AO's would roll back nothing.
	if targets := recorder.rollbackTargets(); len(targets) != 1 || targets[0] != "provider-turn-2" {
		t.Fatalf("provider rollback targets = %v, want [provider-turn-2]", targets)
	}

	snapshot, err := h.st.LoadConversationSnapshot(ctx, h.ctrl.ConversationID())
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	if len(snapshot.Messages) != 2 {
		t.Fatalf("messages = %d, want only the surviving turn's pair", len(snapshot.Messages))
	}
	for _, msg := range snapshot.Messages {
		if strings.Contains(msg.Text, "second") {
			t.Errorf("discarded message still in the timeline: %q", msg.Text)
		}
	}
}

func TestRollbackRemovesLaterLegacyCompactionState(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)
	ctx := context.Background()

	completeTurn(t, h, "first", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })
	second := completeTurn(t, h, "second", "provider-turn-2")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 4 })

	// Builds before compaction turn correlation shipped stored this boundary with
	// no turn_id. It still belongs to the history after the second prompt.
	compactedAt := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)
	if err := h.st.UpsertActivity(ctx, h.ctrl.ConversationID(), "", domain.ConversationActivity{
		ID: "legacy-compaction", Kind: domain.ActivityKindSystem,
		Status: domain.ActivityStatusCompleted, Summary: "Compacted history",
		Detail: []byte(`{"event":"compaction"}`), ProviderItemID: "legacy-compaction-item",
	}, compactedAt); err != nil {
		t.Fatalf("seed legacy compaction: %v", err)
	}
	if err := h.st.MarkCompacted(ctx, h.ctrl.ConversationID(), compactedAt); err != nil {
		t.Fatalf("mark compacted: %v", err)
	}

	if _, err := h.svc.Rollback(ctx, testSession, second); err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	snapshot, err := h.st.LoadConversationSnapshot(ctx, h.ctrl.ConversationID())
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	if snapshot.Conversation.CompactedAt != nil {
		t.Fatalf("compactedAt = %v, want cleared after its history was rolled back", snapshot.Conversation.CompactedAt)
	}
	for _, activity := range snapshot.Activities {
		if activity.ID == "legacy-compaction" {
			t.Fatal("rolled-back legacy compaction remained visible")
		}
	}
}

// Refused, not raced. A rollback while the agent is mid-turn would leave AO hiding
// rows the agent is still writing into, so the check happens before the provider is
// asked at all.
func TestRollbackIsRefusedWhileATurnIsRunning(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)
	ctx := context.Background()

	turnID := completeTurn(t, h, "first", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })

	// A second turn that never completes: the agent is working.
	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "still going", Origin: domain.MessageOriginHuman,
	}); err != nil {
		t.Fatalf("Send: %v", err)
	}

	_, err := h.svc.Rollback(ctx, testSession, turnID)
	if !errors.Is(err, chatsvc.ErrTurnRunning) {
		t.Fatalf("err = %v, want ErrTurnRunning", err)
	}
	if targets := recorder.rollbackTargets(); len(targets) != 0 {
		t.Fatalf("provider was asked to roll back mid-turn: %v", targets)
	}

	// Nothing was hidden either. A refused rollback must leave the timeline alone.
	snapshot, err := h.st.LoadConversationSnapshot(ctx, h.ctrl.ConversationID())
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	for _, turn := range snapshot.Turns {
		if turn.RolledBackAt != nil {
			t.Errorf("turn %s was marked rolled back by a refused rollback", turn.ID)
		}
	}
}

// A provider without the capability gets a typed answer the client can render as an
// absent affordance, following the Models precedent.
func TestRollbackReportsAnUnsupportedDriver(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	turnID := completeTurn(t, h, "first", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })

	_, err := h.svc.Rollback(ctx, testSession, turnID)
	if !errors.Is(err, chatsvc.ErrRollbackUnsupported) {
		t.Fatalf("err = %v, want ErrRollbackUnsupported", err)
	}
}

// A turn the provider never accepted holds no provider history. Hiding AO's rows for
// it would leave the agent remembering more than the timeline shows, which is the
// exact disagreement rollback exists to prevent.
func TestRollbackRefusesATurnTheProviderNeverAccepted(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)
	ctx := context.Background()

	completeTurn(t, h, "first", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })

	// Busy, so this one is recorded and queued rather than dispatched.
	if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "running", Origin: domain.MessageOriginHuman,
	}); err != nil {
		t.Fatalf("Send running: %v", err)
	}
	queued, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "queued", Origin: domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("Send queued: %v", err)
	}
	if queued.State != domain.TurnStateQueued {
		t.Fatalf("second send state = %q, want queued", queued.State)
	}

	_, err = h.svc.Rollback(ctx, testSession, queued.ID)
	// It is refused, though which refusal depends on whether the running turn is
	// noticed first; both are honest and neither is a 500.
	if !errors.Is(err, chatsvc.ErrTurnNotRollbackable) && !errors.Is(err, chatsvc.ErrTurnRunning) {
		t.Fatalf("err = %v, want ErrTurnNotRollbackable or ErrTurnRunning", err)
	}
}

// A turn id from nowhere is a 404-shaped answer, not a conflict.
func TestRollbackReportsAnUnknownTurn(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)

	_, err := h.svc.Rollback(context.Background(), testSession, "turn-that-never-was")
	if !errors.Is(err, domain.ErrNoConversationTurn) {
		t.Fatalf("err = %v, want domain.ErrNoConversationTurn", err)
	}
}

// The provider's own refusal must arrive as a conflict carrying its explanation. A
// generic failure would tell the user nothing they could act on.
func TestRollbackClassifiesAProviderRefusal(t *testing.T) {
	recorder := newHistoryRecorder()
	recorder.rollbackErr = refusedError{msg: "Cannot rollback while a turn is in progress."}
	h := newHarnessWithConversation(t, recorder)
	ctx := context.Background()

	turnID := completeTurn(t, h, "first", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })

	_, err := h.svc.Rollback(ctx, testSession, turnID)
	if !errors.Is(err, chatsvc.ErrProviderRefused) {
		t.Fatalf("err = %v, want ErrProviderRefused", err)
	}
	if !strings.Contains(err.Error(), "turn is in progress") {
		t.Errorf("err = %v, want the provider's explanation carried through", err)
	}

	// And AO hid nothing: the provider still remembers the turn.
	snapshot, err := h.st.LoadConversationSnapshot(ctx, h.ctrl.ConversationID())
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	if len(snapshot.Messages) != 2 {
		t.Errorf("messages = %d, want the timeline untouched by a refused rollback",
			len(snapshot.Messages))
	}
}

// The title round trip: AO asks, the provider confirms on its own event, and only
// then does the session label move. Nothing is written optimistically.
func TestSetTitleFlowsThroughTheProviderIntoTheSessionName(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)
	ctx := context.Background()

	title, err := h.svc.SetTitle(ctx, testSession, "## \"Fix OAuth Return URL Loss.\"  ")
	if err != nil {
		t.Fatalf("SetTitle: %v", err)
	}
	// Normalized before it ever reaches the provider: heading markers, wrapper
	// quotes and trailing punctuation are model habits, not part of the title.
	if title != "Fix OAuth Return URL Loss" {
		t.Fatalf("normalized title = %q", title)
	}
	if titles := recorder.setTitles(); len(titles) != 1 || titles[0] != title {
		t.Fatalf("provider received %v, want [%q]", titles, title)
	}

	awaitSessionName(t, h, "Fix OAuth Return URL Loss")

	snapshot, err := h.st.LoadConversationSnapshot(ctx, h.ctrl.ConversationID())
	if err != nil {
		t.Fatalf("load snapshot: %v", err)
	}
	if snapshot.Conversation.ProviderTitle != "Fix OAuth Return URL Loss" {
		t.Errorf("provider title = %q", snapshot.Conversation.ProviderTitle)
	}
}

// A title AO never asked for still lands: another client naming the thread is how a
// provider-derived title arrives at all.
func TestAProviderRenameFromElsewhereNamesTheSession(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)

	h.conv.emit(ports.ChatEvent{
		Kind:  ports.ChatEventThreadRenamed,
		Title: "Restore Canvas Renderer Fallback",
	})
	awaitSessionName(t, h, "Restore Canvas Renderer Fallback")
}

// The rule the user cares about: their own name is never taken away by a model.
func TestAProviderTitleDoesNotOverwriteAUserRename(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)
	ctx := context.Background()

	if renamed, err := h.st.RenameSession(ctx, testSession, "Mine", h.now()); err != nil || !renamed {
		t.Fatalf("rename: renamed=%v err=%v", renamed, err)
	}

	if _, err := h.svc.SetTitle(ctx, testSession, "Something Else Entirely"); err != nil {
		t.Fatalf("SetTitle: %v", err)
	}

	// The provider title is still recorded; only the label is left alone.
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return s.Conversation.ProviderTitle == "Something Else Entirely"
	})
	rec, ok, err := h.st.GetSession(ctx, testSession)
	if err != nil || !ok {
		t.Fatalf("get session: ok=%v err=%v", ok, err)
	}
	if rec.DisplayName != "Mine" {
		t.Errorf("display name = %q, want the user's name to have survived", rec.DisplayName)
	}
}

// Clearing the thread name is not a reason to strip AO's label.
func TestAClearedProviderTitleLeavesTheSessionNameAlone(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)
	ctx := context.Background()

	h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventThreadRenamed, Title: "First Name"})
	awaitSessionName(t, h, "First Name")

	h.conv.emit(ports.ChatEvent{Kind: ports.ChatEventThreadRenamed, Title: ""})
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool {
		return s.Conversation.ProviderTitle == ""
	})

	rec, ok, err := h.st.GetSession(ctx, testSession)
	if err != nil || !ok {
		t.Fatalf("get session: ok=%v err=%v", ok, err)
	}
	if rec.DisplayName != "First Name" {
		t.Errorf("display name = %q, want the label kept when the thread lost its name",
			rec.DisplayName)
	}
}

func TestSetTitleRefusesABlankTitle(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)

	if _, err := h.svc.SetTitle(context.Background(), testSession, "  ###  "); !errors.Is(err, chatsvc.ErrTitleRequired) {
		t.Fatalf("err = %v, want ErrTitleRequired", err)
	}
	if titles := recorder.setTitles(); len(titles) != 0 {
		t.Fatalf("provider was asked to set %v", titles)
	}
}

func TestSetTitleReportsAnUnsupportedDriver(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.SetTitle(context.Background(), testSession, "A Name"); !errors.Is(err, chatsvc.ErrRenameUnsupported) {
		t.Fatalf("err = %v, want ErrRenameUnsupported", err)
	}
}

func TestForkReturnsTheNewProviderConversationID(t *testing.T) {
	recorder := newHistoryRecorder()
	h := newHarnessWithConversation(t, recorder)

	forked, err := h.svc.ForkConversation(context.Background(), testSession)
	if err != nil {
		t.Fatalf("ForkConversation: %v", err)
	}
	if forked != "thread-forked" {
		t.Errorf("forked conversation = %q, want thread-forked", forked)
	}
}

func TestForkReportsAnUnsupportedDriver(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.ForkConversation(context.Background(), testSession); !errors.Is(err, chatsvc.ErrForkUnsupported) {
		t.Fatalf("err = %v, want ErrForkUnsupported", err)
	}
}

func TestForkClassifiesAProviderRefusal(t *testing.T) {
	recorder := newHistoryRecorder()
	recorder.forkErr = refusedError{msg: "lastTurnId identifies an in-progress turn"}
	h := newHarnessWithConversation(t, recorder)

	_, err := h.svc.ForkConversation(context.Background(), testSession)
	if !errors.Is(err, chatsvc.ErrProviderRefused) {
		t.Fatalf("err = %v, want ErrProviderRefused", err)
	}
}

type editDriverState struct {
	mu          sync.Mutex
	startCalls  int
	resumeCalls []ports.ChatResumeConfig
	fresh       *fakeConversation
	resumed     map[string]*fakeConversation
}

func newEditHarness(t *testing.T) (*harness, *historyRecorder, *editDriverState) {
	return newEditHarnessWithStore(t, func(st *store.Store) chatsvc.Store { return st })
}

func newEditHarnessWithStore(
	t *testing.T,
	wrapStore func(*store.Store) chatsvc.Store,
) (*harness, *historyRecorder, *editDriverState) {
	t.Helper()
	st := openStore(t)
	source := newHistoryRecorder()
	fresh := newFakeConversation()
	fresh.providerConversationID = "thread-fresh"
	fresh.turnSeq = 100
	forked := newFakeConversation()
	forked.providerConversationID = "thread-forked"
	forked.turnSeq = 200
	root := newFakeConversation()
	root.providerConversationID = "thread-1"
	root.turnSeq = 300
	state := &editDriverState{
		fresh: fresh,
		resumed: map[string]*fakeConversation{
			"thread-forked": forked,
			"thread-1":      root,
		},
	}
	driver := fakeDriver{conv: source.fakeConversation}
	driver.start = func(ports.ChatStartConfig) (ports.ChatConversation, error) {
		state.mu.Lock()
		defer state.mu.Unlock()
		state.startCalls++
		if state.startCalls == 1 {
			return source, nil
		}
		return state.fresh, nil
	}
	driver.resume = func(cfg ports.ChatResumeConfig) (ports.ChatConversation, error) {
		state.mu.Lock()
		defer state.mu.Unlock()
		state.resumeCalls = append(state.resumeCalls, cfg)
		conv := state.resumed[cfg.ProviderConversationID]
		if conv == nil {
			return nil, errors.New("unexpected provider conversation: " + cfg.ProviderConversationID)
		}
		return conv, nil
	}

	clock := time.Date(2026, 8, 9, 15, 0, 0, 0, time.UTC)
	var idMu sync.Mutex
	nextID := 0
	svc := chatsvc.New(chatsvc.Options{
		Store: wrapStore(st), Sessions: st,
		Drivers: fakeRegistry{driver: driver},
		Log:     slog.New(slog.DiscardHandler),
		NewID: func() string {
			idMu.Lock()
			defer idMu.Unlock()
			nextID++
			return fmt.Sprintf("edit-id-%d", nextID)
		},
		Now: func() time.Time { return clock },
	})
	workspace := t.TempDir()
	ctrl, err := svc.Start(context.Background(), chatsvc.StartConfig{
		SessionID: testSession, ProjectID: testProject, Kind: domain.KindWorker,
		Harness: domain.HarnessCodex, WorkspacePath: workspace,
		Env: map[string]string{"AO_EDIT_TEST": "yes"}, SystemPrompt: "preserved prompt",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	record, found, err := st.GetSession(context.Background(), testSession)
	if err != nil || !found {
		t.Fatalf("GetSession: found=%v err=%v", found, err)
	}
	record.Metadata.ProviderConversationID = "thread-1"
	record.Metadata.ControllerGeneration = ctrl.Generation()
	if err := st.UpdateSession(context.Background(), record); err != nil {
		t.Fatalf("UpdateSession provider controller: %v", err)
	}
	t.Cleanup(func() { _ = svc.Stop(context.Background(), testSession) })
	return &harness{svc: svc, st: st, conv: source.fakeConversation, ctrl: ctrl, clock: clock}, source, state
}

type failEditCompletionStore struct{ chatsvc.Store }

func (s *failEditCompletionStore) CompleteEditDelivery(
	context.Context,
	string,
	string,
	string,
	string,
	domain.ConversationTurn,
	time.Time,
) error {
	return errors.New("injected edit completion failure")
}

func restartEditService(
	t *testing.T,
	h *harness,
) (*chatsvc.Service, *historyRecorder) {
	t.Helper()
	controller, err := h.svc.Controller(testSession)
	if err != nil {
		t.Fatalf("Controller before restart: %v", err)
	}
	providerConversationID := controller.ProviderConversationID()
	if err := h.svc.Stop(context.Background(), testSession); err != nil {
		t.Fatalf("stop original edit service: %v", err)
	}
	provider := newHistoryRecorder()
	provider.providerConversationID = providerConversationID
	var (
		idMu sync.Mutex
		id   int
	)
	svc := chatsvc.New(chatsvc.Options{
		Store: h.st, Sessions: h.st,
		Drivers: fakeRegistry{driver: fakeDriver{conv: provider}},
		Log:     slog.New(slog.DiscardHandler),
		NewID: func() string {
			idMu.Lock()
			defer idMu.Unlock()
			id++
			return fmt.Sprintf("restart-edit-%d", id)
		},
		Now: h.now,
	})
	if _, err := svc.Start(context.Background(), chatsvc.StartConfig{
		SessionID: testSession, ProjectID: testProject, Harness: domain.HarnessCodex,
		WorkspacePath: t.TempDir(), ProviderConversationID: providerConversationID,
	}); err != nil {
		t.Fatalf("restart edit service: %v", err)
	}
	t.Cleanup(func() { _ = svc.Stop(context.Background(), testSession) })
	return svc, provider
}

func TestEditMessageForksBeforeMiddlePromptAndReusesStoredContent(t *testing.T) {
	h, source, driver := newEditHarness(t)
	ctx := context.Background()
	first := completeTurn(t, h, "A", "provider-turn-1")
	_ = first
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })
	second, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{
		Text: "B", Origin: domain.MessageOriginHuman, ClientMessageID: "original-b",
		Content: []ports.ChatContent{{Type: "image", Data: "data:image/png;base64,AA==", MIMEType: "image/png", Name: "diagram.png"}},
	})
	if err != nil {
		t.Fatalf("Send B: %v", err)
	}
	h.conv.emit(
		ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-turn-2"},
		ports.ChatEvent{Kind: ports.ChatEventMessageCompleted, ProviderTurnID: "provider-turn-2", ProviderItemID: "answer-b", Text: "answer B"},
		ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-2", TurnState: domain.TurnStateCompleted},
	)
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 4 })

	result, err := h.svc.EditMessage(ctx, testSession, second.ID, ports.ChatUserMessage{
		Text: "B edited", ClientMessageID: "edit-b", Origin: domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("EditMessage: %v", err)
	}
	if result.SourceBranchID == "" || result.ActiveBranchID == "" || result.SourceBranchID == result.ActiveBranchID {
		t.Fatalf("branch result = %+v", result)
	}
	if anchor := source.lastForkAnchor(); anchor == nil || *anchor != "provider-turn-1" {
		t.Fatalf("fork anchor = %#v", anchor)
	}
	if got := source.rollbackTargets(); len(got) != 0 {
		t.Fatalf("editing called rollback: %v", got)
	}
	driver.mu.Lock()
	replacement := driver.resumed["thread-forked"]
	resumes := append([]ports.ChatResumeConfig(nil), driver.resumeCalls...)
	driver.mu.Unlock()
	sent := replacement.sentMessages()
	if len(sent) != 1 || sent[0].Text != "B edited" || len(sent[0].Content) != 1 || sent[0].Content[0].Data != "data:image/png;base64,AA==" {
		t.Fatalf("replacement send = %#v", sent)
	}
	if len(resumes) != 1 || resumes[0].WorkspacePath == "" || resumes[0].Env["AO_EDIT_TEST"] != "yes" || resumes[0].SystemPrompt != "preserved prompt" {
		t.Fatalf("resume config = %#v", resumes)
	}
}

func TestEditMessageFirstPromptStartsFreshConversation(t *testing.T) {
	h, source, driver := newEditHarness(t)
	first := completeTurn(t, h, "A", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })
	if _, err := h.svc.EditMessage(context.Background(), testSession, first, ports.ChatUserMessage{
		Text: "A edited", ClientMessageID: "edit-a", Origin: domain.MessageOriginHuman,
	}); err != nil {
		t.Fatalf("EditMessage first: %v", err)
	}
	driver.mu.Lock()
	startCalls := driver.startCalls
	driver.mu.Unlock()
	if startCalls != 2 {
		t.Fatalf("driver Start calls = %d, want 2", startCalls)
	}
	if anchor := source.lastForkAnchor(); anchor != nil {
		t.Fatalf("first prompt forked existing provider history at %#v", anchor)
	}
	if sent := driver.fresh.sentTexts(); len(sent) != 1 || sent[0] != "A edited" {
		t.Fatalf("fresh provider sends = %v", sent)
	}
}

func TestEditMessageRefusesBusyControllerAndLeavesSourceActive(t *testing.T) {
	h, source, driver := newEditHarness(t)
	turn, err := h.svc.Send(context.Background(), testSession, ports.ChatUserMessage{
		Text: "running", Origin: domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	conversation, err := h.st.ConversationForSession(context.Background(), testSession)
	if err != nil {
		t.Fatalf("ConversationForSession: %v", err)
	}
	_, err = h.svc.EditMessage(context.Background(), testSession, turn.ID, ports.ChatUserMessage{Text: "edited"})
	if !errors.Is(err, chatsvc.ErrTurnRunning) {
		t.Fatalf("EditMessage busy error = %v, want ErrTurnRunning", err)
	}
	after, err := h.st.ConversationForSession(context.Background(), testSession)
	if err != nil || after.ActiveBranchID != conversation.ActiveBranchID {
		t.Fatalf("active branch after busy refusal = %q, want %q, err=%v", after.ActiveBranchID, conversation.ActiveBranchID, err)
	}
	if anchor := source.lastForkAnchor(); anchor != nil {
		t.Fatalf("busy edit called Fork at %#v", anchor)
	}
	driver.mu.Lock()
	startCalls := driver.startCalls
	driver.mu.Unlock()
	if startCalls != 1 {
		t.Fatalf("busy edit started replacement provider; starts=%d", startCalls)
	}
}

func TestEditMessageForkFailureReopensSource(t *testing.T) {
	h, source, _ := newEditHarness(t)
	first := completeTurn(t, h, "A", "provider-turn-1")
	_ = first
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })
	second := completeTurn(t, h, "B", "provider-turn-2")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 4 })
	source.mu.Lock()
	source.forkErr = errors.New("fork unavailable")
	source.mu.Unlock()
	conversation, err := h.st.ConversationForSession(context.Background(), testSession)
	if err != nil {
		t.Fatalf("ConversationForSession: %v", err)
	}
	if _, err := h.svc.EditMessage(context.Background(), testSession, second,
		ports.ChatUserMessage{Text: "B edited"}); err == nil {
		t.Fatal("EditMessage succeeded after provider fork failure")
	}
	after, err := h.st.ConversationForSession(context.Background(), testSession)
	if err != nil || after.ActiveBranchID != conversation.ActiveBranchID {
		t.Fatalf("active branch after fork failure = %q, want %q, err=%v", after.ActiveBranchID, conversation.ActiveBranchID, err)
	}
	if _, err := h.svc.Send(context.Background(), testSession, ports.ChatUserMessage{Text: "source reopened"}); err != nil {
		t.Fatalf("Send after fork failure: %v", err)
	}
}

func TestEditMessageSendFailureKeepsAnEmptyBranchForRetry(t *testing.T) {
	h, source, driver := newEditHarness(t)
	ctx := context.Background()
	completeTurn(t, h, "A", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })
	second := completeTurn(t, h, "B", "provider-turn-2")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 4 })

	driver.mu.Lock()
	replacement := driver.resumed["thread-forked"]
	replacement.mu.Lock()
	replacement.sendErr = errors.New("provider unavailable")
	replacement.mu.Unlock()
	driver.mu.Unlock()

	failed, err := h.svc.EditMessage(ctx, testSession, second, ports.ChatUserMessage{
		Text: "B edited", ClientMessageID: "edit-b-failed", Origin: domain.MessageOriginHuman,
	})
	if err == nil {
		t.Fatal("EditMessage succeeded after replacement send failure")
	}
	if failed.ActiveBranchID == "" || failed.ActiveBranchID == failed.SourceBranchID {
		t.Fatalf("failed edit branch result = %+v", failed)
	}
	snapshot, err := h.st.LoadConversationSnapshot(ctx, h.ctrl.ConversationID())
	if err != nil {
		t.Fatalf("LoadConversationSnapshot failed branch: %v", err)
	}
	requireMessageTexts(t, snapshot.Messages, []string{"A", "reply to A"})

	replacement.mu.Lock()
	replacement.sendErr = nil
	replacement.mu.Unlock()
	retried, err := h.svc.EditMessage(ctx, testSession, second, ports.ChatUserMessage{
		Text: "B edited", ClientMessageID: "edit-b-retry", Origin: domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("retry EditMessage: %v", err)
	}
	if retried.SourceBranchID != failed.SourceBranchID || retried.ActiveBranchID != failed.ActiveBranchID {
		t.Fatalf("retry created another branch: failed=%+v retried=%+v", failed, retried)
	}
	source.mu.Lock()
	forkCount := len(source.forkAnchors)
	source.mu.Unlock()
	driver.mu.Lock()
	resumeCount := len(driver.resumeCalls)
	driver.mu.Unlock()
	if forkCount != 1 || resumeCount != 1 {
		t.Fatalf("retry provider setup: forks=%d resumes=%d, want one of each", forkCount, resumeCount)
	}
	if sent := replacement.sentTexts(); len(sent) != 1 || sent[0] != "B edited" {
		t.Fatalf("replacement provider sends = %v", sent)
	}
	snapshot, err = h.st.LoadConversationSnapshot(ctx, h.ctrl.ConversationID())
	if err != nil {
		t.Fatalf("LoadConversationSnapshot retried branch: %v", err)
	}
	requireMessageTexts(t, snapshot.Messages, []string{"A", "reply to A", "B edited"})
}

func TestAcceptedEditReplaysBeforeAnchorLookupAndRejectsChangedPayload(t *testing.T) {
	h, _, driver := newEditHarness(t)
	ctx := context.Background()
	first := completeTurn(t, h, "A", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })
	msg := ports.ChatUserMessage{
		Text: "A edited", ClientMessageID: "edit-replay", Origin: domain.MessageOriginHuman,
	}

	original, err := h.svc.EditMessage(ctx, testSession, first, msg)
	if err != nil {
		t.Fatalf("first EditMessage: %v", err)
	}
	replayed, err := h.svc.EditMessage(ctx, testSession, first, msg)
	if err != nil {
		t.Fatalf("replayed EditMessage: %v", err)
	}
	if replayed != original {
		t.Fatalf("replayed result = %+v, want original %+v", replayed, original)
	}
	if sent := driver.fresh.sentTexts(); len(sent) != 1 || sent[0] != "A edited" {
		t.Fatalf("provider sends after replay = %v, want one", sent)
	}

	_, err = h.svc.EditMessage(ctx, testSession, first, ports.ChatUserMessage{
		Text: "different edit", ClientMessageID: msg.ClientMessageID,
		Origin: domain.MessageOriginHuman,
	})
	if !errors.Is(err, chatsvc.ErrEditIdempotencyConflict) {
		t.Fatalf("changed edit error = %v, want ErrEditIdempotencyConflict", err)
	}
	if sent := driver.fresh.sentTexts(); len(sent) != 1 {
		t.Fatalf("changed payload reached provider; sends=%v", sent)
	}
}

func TestRejectedEditReplaysWithoutEmptySuccessOrProviderRedispatch(t *testing.T) {
	h, _, driver := newEditHarness(t)
	ctx := context.Background()
	first := completeTurn(t, h, "A", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })
	driver.fresh.mu.Lock()
	driver.fresh.sendErr = errors.New("provider unavailable")
	driver.fresh.mu.Unlock()
	msg := ports.ChatUserMessage{
		Text: "A edited", ClientMessageID: "edit-rejected", Origin: domain.MessageOriginHuman,
	}

	failed, err := h.svc.EditMessage(ctx, testSession, first, msg)
	if err == nil {
		t.Fatal("first EditMessage unexpectedly succeeded")
	}
	if failed.ActiveBranchID == "" {
		t.Fatalf("failed edit did not identify its selected branch: %+v", failed)
	}
	driver.fresh.mu.Lock()
	driver.fresh.sendErr = nil
	driver.fresh.mu.Unlock()
	replayed, retryErr := h.svc.EditMessage(ctx, testSession, first, msg)
	if !errors.Is(retryErr, chatsvc.ErrEditDeliveryRejected) {
		t.Fatalf("replayed rejection error = %v, want ErrEditDeliveryRejected", retryErr)
	}
	if replayed != (chatsvc.EditMessageResult{}) {
		t.Fatalf("replayed rejection returned false success result %+v", replayed)
	}
	if sent := driver.fresh.sentTexts(); len(sent) != 0 {
		t.Fatalf("provider received retry after durable rejection: %v", sent)
	}
	restarted, restartedProvider := restartEditService(t, h)
	_, retryErr = restarted.EditMessage(ctx, testSession, first, msg)
	if !errors.Is(retryErr, chatsvc.ErrEditDeliveryRejected) {
		t.Fatalf("restart rejection error = %v, want ErrEditDeliveryRejected", retryErr)
	}
	if sent := restartedProvider.sentTexts(); len(sent) != 0 {
		t.Fatalf("restarted provider received rejected edit replay: %v", sent)
	}
}

func TestAcceptedEditReplaysAfterControllerRestartWithoutProviderRedispatch(t *testing.T) {
	h, _, driver := newEditHarness(t)
	first := completeTurn(t, h, "A", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })
	msg := ports.ChatUserMessage{
		Text: "A edited", ClientMessageID: "edit-restart", Origin: domain.MessageOriginHuman,
	}
	original, err := h.svc.EditMessage(context.Background(), testSession, first, msg)
	if err != nil {
		t.Fatalf("first EditMessage: %v", err)
	}
	if sent := driver.fresh.sentTexts(); len(sent) != 1 {
		t.Fatalf("original provider sends = %v, want one", sent)
	}

	restarted, restartedProvider := restartEditService(t, h)
	replayed, err := restarted.EditMessage(context.Background(), testSession, first, msg)
	if err != nil {
		t.Fatalf("EditMessage after restart: %v", err)
	}
	if replayed != original {
		t.Fatalf("restart replay = %+v, want %+v", replayed, original)
	}
	if sent := restartedProvider.sentTexts(); len(sent) != 0 {
		t.Fatalf("restarted provider received edit replay: %v", sent)
	}
}

func TestEditCompletionGapStaysUncertainAcrossRetryAndControllerRestart(t *testing.T) {
	var flaky *failEditCompletionStore
	h, _, driver := newEditHarnessWithStore(t, func(st *store.Store) chatsvc.Store {
		flaky = &failEditCompletionStore{Store: st}
		return flaky
	})
	first := completeTurn(t, h, "A", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })
	msg := ports.ChatUserMessage{
		Text: "A edited", ClientMessageID: "edit-uncertain", Origin: domain.MessageOriginHuman,
	}

	_, err := h.svc.EditMessage(context.Background(), testSession, first, msg)
	if !errors.Is(err, chatsvc.ErrEditDeliveryUncertain) {
		t.Fatalf("completion gap error = %v, want ErrEditDeliveryUncertain", err)
	}
	_, err = h.svc.EditMessage(context.Background(), testSession, first, msg)
	if !errors.Is(err, chatsvc.ErrEditDeliveryUncertain) {
		t.Fatalf("same-controller retry error = %v, want ErrEditDeliveryUncertain", err)
	}
	if sent := driver.fresh.sentTexts(); len(sent) != 1 {
		t.Fatalf("provider received %d sends after uncertain retry, want one", len(sent))
	}

	restarted, restartedProvider := restartEditService(t, h)
	_, err = restarted.EditMessage(context.Background(), testSession, first, msg)
	if !errors.Is(err, chatsvc.ErrEditDeliveryUncertain) {
		t.Fatalf("restart retry error = %v, want ErrEditDeliveryUncertain", err)
	}
	if sent := restartedProvider.sentTexts(); len(sent) != 0 {
		t.Fatalf("restarted provider received uncertain edit replay: %v", sent)
	}
}

func TestEditMessageRejectsMalformedStoredContentBeforeFork(t *testing.T) {
	h, source, _ := newEditHarness(t)
	created, err := h.st.AppendUserMessage(context.Background(), h.ctrl.ConversationID(), testSession,
		h.ctrl.Generation(), domain.ConversationMessage{
			ID: "legacy-message", Text: "legacy", Origin: domain.MessageOriginHuman,
			ClientMessageID: "legacy-client", DeliveryContentJSON: `{broken`,
		}, "legacy-turn", h.now())
	if err != nil || !created {
		t.Fatalf("AppendUserMessage legacy: created=%v err=%v", created, err)
	}
	_, err = h.svc.EditMessage(context.Background(), testSession, "legacy-turn", ports.ChatUserMessage{Text: "edited"})
	if !errors.Is(err, chatsvc.ErrEditTurnInvalid) {
		t.Fatalf("EditMessage malformed content error = %v, want ErrEditTurnInvalid", err)
	}
	if anchor := source.lastForkAnchor(); anchor != nil {
		t.Fatalf("malformed content called Fork at %#v", anchor)
	}
}

func TestActivateBranchResumesWithoutSending(t *testing.T) {
	h, _, driver := newEditHarness(t)
	first := completeTurn(t, h, "A", "provider-turn-1")
	h.awaitSnapshot(t, func(s store.ConversationSnapshot) bool { return len(s.Messages) == 2 })
	result, err := h.svc.EditMessage(context.Background(), testSession, first, ports.ChatUserMessage{
		Text: "A edited", ClientMessageID: "edit-a", Origin: domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("EditMessage: %v", err)
	}
	driver.fresh.emit(
		ports.ChatEvent{Kind: ports.ChatEventTurnStarted, ProviderTurnID: "provider-turn-101"},
		ports.ChatEvent{Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn-101", TurnState: domain.TurnStateCompleted},
	)
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		controller, controllerErr := h.svc.Controller(testSession)
		if controllerErr == nil && controller.State() == ports.ChatControllerReady {
			snapshot, snapshotErr := h.st.LoadConversationSnapshot(context.Background(), h.ctrl.ConversationID())
			if snapshotErr == nil && len(snapshot.Turns) == 1 && snapshot.Turns[0].State.Terminal() {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	active, err := h.svc.ActivateBranch(context.Background(), testSession, result.SourceBranchID)
	if err != nil {
		t.Fatalf("ActivateBranch: %v", err)
	}
	if active != result.SourceBranchID {
		t.Fatalf("active branch = %q, want %q", active, result.SourceBranchID)
	}
	driver.mu.Lock()
	root := driver.resumed["thread-1"]
	driver.mu.Unlock()
	if sent := root.sentTexts(); len(sent) != 0 {
		t.Fatalf("branch activation sent messages: %v", sent)
	}
}

func TestProviderBoundaryRejectsSourceProviderBranchAndEdit(t *testing.T) {
	ctx := context.Background()
	st := openStore(t)
	now := time.Date(2026, 8, 18, 14, 0, 0, 0, time.UTC)
	record, found, err := st.GetSession(ctx, testSession)
	if err != nil || !found {
		t.Fatalf("GetSession: found=%v err=%v", found, err)
	}
	record.Metadata.ProviderConversationID = "source-provider-thread"
	record.Metadata.ControllerGeneration = "source-generation"
	if err := st.UpdateSession(ctx, record); err != nil {
		t.Fatalf("seed source controller identity: %v", err)
	}
	conversation, err := st.CreateConversation(ctx, "provider-boundary-conversation",
		domain.ConversationScopeProject, testProject, testSession, now)
	if err != nil {
		t.Fatalf("CreateConversation: %v", err)
	}
	created, err := st.AppendUserMessage(ctx, conversation.ID, testSession, "source-generation",
		domain.ConversationMessage{
			ID: "source-message", Origin: domain.MessageOriginHuman, Text: "source task",
			ClientMessageID: "source-client-message",
		}, "source-turn", now)
	if err != nil || !created {
		t.Fatalf("AppendUserMessage: created=%v err=%v", created, err)
	}
	if err := st.BindTurnToProvider(ctx, "source-turn", "source-provider-turn", now); err != nil {
		t.Fatalf("BindTurnToProvider: %v", err)
	}
	conversation, err = st.ConversationForSession(ctx, testSession)
	if err != nil {
		t.Fatalf("reload source conversation: %v", err)
	}

	target := newHistoryRecorder()
	target.providerConversationID = "target-provider-thread"
	startCalls := 0
	resumeCalls := 0
	driver := fakeDriver{conv: target}
	driver.start = func(ports.ChatStartConfig) (ports.ChatConversation, error) {
		startCalls++
		if startCalls == 1 {
			return target, nil
		}
		return nil, errors.New("source-provider edit reached target driver")
	}
	driver.resume = func(ports.ChatResumeConfig) (ports.ChatConversation, error) {
		resumeCalls++
		return nil, errors.New("source-provider branch reached target driver")
	}
	nextID := 0
	svc := chatsvc.New(chatsvc.Options{
		Store: st, Sessions: st,
		Drivers: fakeRegistry{driver: driver},
		Log:     slog.New(slog.DiscardHandler),
		NewID: func() string {
			nextID++
			return fmt.Sprintf("provider-boundary-%d", nextID)
		},
		Now: func() time.Time { return now.Add(time.Minute) },
	})
	t.Cleanup(func() { _ = svc.Stop(context.Background(), testSession) })

	_, err = svc.Start(ctx, chatsvc.StartConfig{
		SessionID: testSession, ProjectID: testProject, Kind: domain.KindOrchestrator,
		Harness: domain.HarnessCodex, WorkspacePath: t.TempDir(),
		ControllerGeneration: "target-generation",
		ControllerReady: func(started chatsvc.StartResult) (chatsvc.ControllerCommit, error) {
			if err := st.CreateAndActivateConversationBranch(ctx, testSession, domain.ConversationBranch{
				ID: "target-provider-boundary", ConversationID: conversation.ID, SessionID: testSession,
				ProviderConversationID: started.ProviderConversationID,
				ParentBranchID:         conversation.ActiveBranchID, ForkAfterSequence: conversation.LatestSequence,
				CreatedAt: now.Add(time.Minute),
			}, started.ControllerGeneration, now.Add(time.Minute)); err != nil {
				return chatsvc.ControllerCommit{}, err
			}
			committed := started.Conversation
			committed.ActiveBranchID = "target-provider-boundary"
			committed.UpdatedAt = now.Add(time.Minute)
			return chatsvc.ControllerCommit{Conversation: committed}, nil
		},
	})
	if err != nil {
		t.Fatalf("Start target controller: %v", err)
	}

	if _, err := svc.EditMessage(ctx, testSession, "source-turn", ports.ChatUserMessage{
		Text: "rewrite source task", Origin: domain.MessageOriginHuman,
	}); !errors.Is(err, chatsvc.ErrEditTurnInvalid) {
		t.Fatalf("source-provider edit error = %v, want ErrEditTurnInvalid", err)
	}
	if startCalls != 1 {
		t.Fatalf("driver starts = %d, want source-provider edit rejected before target driver", startCalls)
	}
	if _, err := svc.Rollback(ctx, testSession, "source-turn"); !errors.Is(err, chatsvc.ErrTurnProviderMismatch) {
		t.Fatalf("source-provider rollback error = %v, want ErrTurnProviderMismatch", err)
	}
	target.mu.Lock()
	rollbackCalls := append([]string(nil), target.rolledBack...)
	target.mu.Unlock()
	if len(rollbackCalls) != 0 {
		t.Fatalf("target provider rollback calls = %v, want source turn rejected before target driver", rollbackCalls)
	}

	if _, err := svc.ActivateBranch(ctx, testSession, conversation.ActiveBranchID); !errors.Is(err, chatsvc.ErrBranchProviderMismatch) {
		t.Fatalf("source-provider branch activation error = %v, want ErrBranchProviderMismatch", err)
	}
	if resumeCalls != 0 {
		t.Fatalf("driver resumes = %d, want source-provider branch rejected before target driver", resumeCalls)
	}
}

// The contract from the automatic-semantic-task-titles design, applied to whatever
// the provider says rather than trusted.
func TestNormalizeTitle(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"plain", "Fix OAuth Return URL Loss", "Fix OAuth Return URL Loss"},
		{"heading marker", "## Review PR in Fresh Worktree", "Review PR in Fresh Worktree"},
		{"list marker", "- Restore Canvas Renderer Fallback", "Restore Canvas Renderer Fallback"},
		{"quoted", `"Fix the login redirect"`, "Fix the login redirect"},
		{"backticked", "`Rebuild the index`", "Rebuild the index"},
		{"trailing period", "Fix the login redirect.", "Fix the login redirect"},
		{"multi line keeps the first", "Fix the redirect\nand then some prose", "Fix the redirect"},
		{"collapses whitespace", "Fix   the    redirect", "Fix the redirect"},
		{"identifiers survive", "Fix OAuth callback in auth.go #3421", "Fix OAuth callback in auth.go #3421"},
		{"blank", "   ", ""},
		{"punctuation only", " -- ... ", ""},
		{
			"over length truncates at a word",
			strings.Repeat("alpha ", 20),
			"alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := chatsvc.NormalizeTitle(tc.in); got != tc.want {
				t.Errorf("NormalizeTitle(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// awaitSessionName polls until the label moves, because the title arrives on the
// projection goroutine rather than on the caller's.
func awaitSessionName(t *testing.T, h *harness, want string) {
	t.Helper()
	h.awaitSnapshot(t, func(store.ConversationSnapshot) bool {
		rec, ok, err := h.st.GetSession(context.Background(), testSession)
		return err == nil && ok && rec.DisplayName == want
	})
}
