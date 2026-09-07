package sessionmanager

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	claudeagent "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/claudecode"
	codexagent "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/codex"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/sqlitetest"
)

type freshChatTransitionStore struct {
	*transitionStore
	conversation domain.ConversationRecord
	branch       domain.ConversationBranch
	historyErr   error
	hasTurns     bool
}

func (s *freshChatTransitionStore) ConversationForSession(context.Context, domain.SessionID) (domain.ConversationRecord, error) {
	return s.conversation, s.historyErr
}

func (s *freshChatTransitionStore) ConversationBranch(context.Context, string, string) (domain.ConversationBranch, error) {
	return s.branch, s.historyErr
}

func (s *freshChatTransitionStore) HasConversationTurns(context.Context, string) (bool, error) {
	return s.hasTurns, s.historyErr
}

func withFreshChatHistory(manager *Manager, store *transitionStore) *freshChatTransitionStore {
	rec := store.sessions["session-1"]
	history := &freshChatTransitionStore{
		transitionStore: store,
		conversation:    domain.ConversationRecord{ID: "conversation-1", SessionID: rec.ID, ActiveBranchID: "branch-1"},
		branch: domain.ConversationBranch{ID: "branch-1", ConversationID: "conversation-1", SessionID: rec.ID,
			ProviderConversationID: rec.Metadata.ProviderConversationID},
	}
	manager.store = history
	return history
}

func TestInterfaceTransitionUnpromptedChatToTUI(t *testing.T) {
	for _, tc := range []struct {
		name         string
		harness      domain.AgentHarness
		agent        ports.Agent
		providerTurn bool
	}{
		{"claude", domain.HarnessClaudeCode, claudeagent.New(), false},
		{"codex", domain.HarnessCodex, codexagent.New(), false},
		{"claude with provider turn but no text", domain.HarnessClaudeCode, claudeagent.New(), true},
		{"codex with provider turn but no text", domain.HarnessCodex, codexagent.New(), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
			t.Setenv("CODEX_HOME", t.TempDir())
			manager, store, runtime, _, log := newTransitionManager(t, domain.SessionModeChat)
			manager.agents = singleAgent{agent: tc.agent}
			manager.dataDir = t.TempDir()
			rec := store.sessions["session-1"]
			rec.Harness = tc.harness
			rec.Metadata.WorkspacePath = t.TempDir()
			rec.Metadata.AgentSessionID = ""
			rec.Metadata.ProviderConversationID = "019fc430-1234-7abc-8def-0123456789ab"
			store.sessions[rec.ID] = rec
			// Exercise the production conversation/branch reads. Runtime and
			// lifecycle effects stay in the existing handoff fixture.
			ctx := context.Background()
			history := sqlitetest.MustOpenAt(t, t.TempDir())
			if err := history.UpsertProject(ctx, store.projects["proj"]); err != nil {
				t.Fatal(err)
			}
			created, err := history.CreateSession(ctx, rec)
			if err != nil {
				t.Fatal(err)
			}
			delete(store.sessions, rec.ID)
			rec.ID = created.ID
			store.sessions[rec.ID] = rec
			if _, err := history.CreateConversation(ctx, "conversation-1", domain.ConversationScopeSession,
				rec.ProjectID, rec.ID, time.Now()); err != nil {
				t.Fatal(err)
			}
			manager.store = struct {
				*transitionStore
				chatHandoffHistoryStore
			}{store, history}
			if tc.providerTurn {
				if err := history.AdoptProviderTurn(ctx, "conversation-1", rec.ID,
					rec.Metadata.ControllerGeneration, "turn-1", "provider-turn-1", time.Now()); err != nil {
					t.Fatal(err)
				}
			}
			transition, err := manager.StartInterfaceTransition(context.Background(), rec.ID,
				domain.SessionModeTUI, domain.SessionInterfaceTransitionInterrupt)
			if tc.providerTurn {
				if !errors.Is(err, ErrNativeConversationMissing) || len(*log) != 0 {
					t.Fatalf("provider turn without text was treated as untouched: err=%v log=%v", err, *log)
				}
				return
			}
			if err != nil {
				t.Fatalf("unprompted Chat-to-terminal switch was refused: %v", err)
			}
			settled := awaitTransition(t, store, transition.ID)
			if settled.Phase != domain.SessionInterfaceTransitionCompleted {
				t.Fatalf("switch = %s (%s): %s", settled.Phase, settled.ErrorCode, settled.ErrorDetail)
			}
			if settled.NativeConversationID != "" {
				t.Fatalf("reserved id was passed to resume: %q", settled.NativeConversationID)
			}
			if got := fmt.Sprint(*log); got != "[prepare:chat:interrupt stop:chat start:tui]" {
				t.Fatalf("controller order = %s", got)
			}
			if runtime.created != 1 || strings.Contains(strings.Join(runtime.lastCfg.Argv, " "), "resume") {
				t.Fatalf("expected one fresh terminal launch: %+v", runtime.lastCfg)
			}
		})
	}
}

func TestInterfaceTransitionUnpromptedChatWithoutNativeID(t *testing.T) {
	manager, store, _, _, _ := newTransitionManager(t, domain.SessionModeChat)
	manager.agents = singleAgent{agent: emptyTransitionAgent{}}
	rec := store.sessions["session-1"]
	rec.Metadata.AgentSessionID = ""
	rec.Metadata.ProviderConversationID = ""
	store.sessions[rec.ID] = rec
	withFreshChatHistory(manager, store)
	status, err := manager.InterfaceTransitionStatus(context.Background(), rec.ID)
	if err != nil || !status.Supported {
		t.Fatalf("untouched Chat status = %+v, err=%v", status, err)
	}
	transition, err := manager.StartInterfaceTransition(context.Background(), rec.ID,
		domain.SessionModeTUI, domain.SessionInterfaceTransitionInterrupt)
	if err != nil {
		t.Fatal(err)
	}
	if settled := awaitTransition(t, store, transition.ID); settled.Phase != domain.SessionInterfaceTransitionCompleted {
		t.Fatalf("switch = %s (%s): %s", settled.Phase, settled.ErrorCode, settled.ErrorDetail)
	}
}

func TestInterfaceTransitionChatRequiresUntouchedConversationProof(t *testing.T) {
	for _, tc := range []struct {
		name   string
		mutate func(*freshChatTransitionStore)
	}{
		{"accepted message or activity", func(s *freshChatTransitionStore) { s.conversation.LatestSequence = 1 }},
		{"provider turn without text", func(s *freshChatTransitionStore) { s.hasTurns = true }},
		{"missing conversation", func(s *freshChatTransitionStore) { s.historyErr = domain.ErrNoConversation }},
		{"history read failed", func(s *freshChatTransitionStore) { s.historyErr = errors.New("database unavailable") }},
		{"different owner", func(s *freshChatTransitionStore) { s.conversation.SessionID = "session-2" }},
		{"different branch owner", func(s *freshChatTransitionStore) { s.branch.SessionID = "session-2" }},
		{"different provider", func(s *freshChatTransitionStore) { s.branch.ProviderConversationID = "other-native" }},
		{"branch with inherited context", func(s *freshChatTransitionStore) { s.branch.ParentBranchID = "parent" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			manager, store, runtime, chat, log := newTransitionManager(t, domain.SessionModeChat)
			manager.agents = singleAgent{agent: emptyTransitionAgent{}}
			tc.mutate(withFreshChatHistory(manager, store))
			_, err := manager.StartInterfaceTransition(context.Background(), "session-1",
				domain.SessionModeTUI, domain.SessionInterfaceTransitionInterrupt)
			if !errors.Is(err, ErrNativeConversationMissing) {
				t.Fatalf("switch without untouched proof = %v", err)
			}
			if len(store.transitions) != 0 || runtime.created != 0 || chat.preparedPolicy != "" || len(*log) != 0 {
				t.Fatalf("refusal mutated source: transitions=%d log=%v", len(store.transitions), *log)
			}
		})
	}
}

type racingFreshChat struct {
	*transitionChat
	beforePrepare func()
}

func (c *racingFreshChat) PrepareChatHandoff(ctx context.Context, id domain.SessionID, policy domain.SessionInterfaceTransitionPolicy) error {
	c.beforePrepare()
	return c.transitionChat.PrepareChatHandoff(ctx, id, policy)
}

func TestInterfaceTransitionFreshChatRechecksAfterFencing(t *testing.T) {
	manager, store, runtime, chat, log := newTransitionManager(t, domain.SessionModeChat)
	manager.agents = singleAgent{agent: emptyTransitionAgent{}}
	history := withFreshChatHistory(manager, store)
	manager.chat = &racingFreshChat{transitionChat: chat, beforePrepare: func() {
		// Message intake won the race with ArmChatHandoff. Its durable sequence
		// remains even if interrupt settles it before a native transcript exists.
		history.conversation.LatestSequence = 1
	}}
	transition, err := manager.StartInterfaceTransition(context.Background(), "session-1",
		domain.SessionModeTUI, domain.SessionInterfaceTransitionInterrupt)
	if err != nil {
		t.Fatal(err)
	}
	settled := awaitTransition(t, store, transition.ID)
	if settled.Phase != domain.SessionInterfaceTransitionFailed || settled.ErrorCode != "NATIVE_SESSION_MISSING" {
		t.Fatalf("switch after accepted message = %s (%s)", settled.Phase, settled.ErrorCode)
	}
	if runtime.created != 0 || fmt.Sprint(*log) != "[prepare:chat:interrupt]" {
		t.Fatalf("source stopped after losing untouched proof: %v", *log)
	}
}
