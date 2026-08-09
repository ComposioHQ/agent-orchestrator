package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/store"
)

var testNow = time.Date(2026, 8, 9, 12, 0, 0, 0, time.UTC)

func seededChatConversation(t *testing.T) (*sqlite.Store, domain.SessionRecord, domain.ConversationRecord) {
	t.Helper()
	ctx := context.Background()
	s := newTestStore(t)
	seedProject(t, s, "branches")

	rec := sampleRecord("branches")
	rec.Mode = domain.SessionModeChat
	rec.Metadata.ProviderConversationID = "thread-root"
	rec.Metadata.ControllerGeneration = "generation-root"
	session, err := s.CreateSession(ctx, rec)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	conversation, err := s.CreateConversation(
		ctx, "conversation-branches", domain.ConversationScopeSession,
		"branches", session.ID, testNow,
	)
	if err != nil {
		t.Fatalf("CreateConversation: %v", err)
	}
	return s, session, conversation
}

func seedBranchTurns(t *testing.T, s *sqlite.Store, session domain.SessionRecord, conversation domain.ConversationRecord) {
	t.Helper()
	ctx := context.Background()
	created, err := s.AppendUserMessage(ctx, conversation.ID, session.ID, "generation-root", domain.ConversationMessage{
		ID: "message-1", Origin: domain.MessageOriginHuman, Text: "first prompt",
		ClientMessageID: "client-1", DeliveryContentJSON: `[{"type":"text","text":"first prompt"}]`,
	}, "turn-1", testNow)
	if err != nil || !created {
		t.Fatalf("AppendUserMessage turn-1: created=%v err=%v", created, err)
	}
	if err := s.BindTurnToProvider(ctx, "turn-1", "provider-turn-1", testNow); err != nil {
		t.Fatalf("BindTurnToProvider turn-1: %v", err)
	}
	if err := s.SettleAssistantMessage(ctx, conversation.ID, "assistant-1", "provider-turn-1", "first answer", "message-assistant-1", testNow); err != nil {
		t.Fatalf("SettleAssistantMessage turn-1: %v", err)
	}
	created, err = s.AppendUserMessage(ctx, conversation.ID, session.ID, "generation-root", domain.ConversationMessage{
		ID: "message-2", Origin: domain.MessageOriginHuman, Text: "second prompt",
		ClientMessageID: "client-2", DeliveryContentJSON: `[{"type":"text","text":"second prompt"},{"type":"image","url":"data:image/png;base64,AA=="}]`,
	}, "turn-2", testNow.Add(time.Minute))
	if err != nil || !created {
		t.Fatalf("AppendUserMessage turn-2: created=%v err=%v", created, err)
	}
}

func TestConversationBranchRootAndEditAnchorPersist(t *testing.T) {
	ctx := context.Background()
	s, session, conversation := seededChatConversation(t)
	if conversation.ActiveBranchID != conversation.ID+":root" {
		t.Fatalf("active branch = %q, want root", conversation.ActiveBranchID)
	}

	root, err := s.ConversationBranch(ctx, conversation.ID, conversation.ActiveBranchID)
	if err != nil {
		t.Fatalf("ConversationBranch: %v", err)
	}
	if !root.Active || root.SessionID != session.ID || root.ProviderConversationID != "thread-root" {
		t.Fatalf("root branch = %+v", root)
	}

	seedBranchTurns(t, s, session, conversation)
	anchor, err := s.ConversationEditAnchor(ctx, conversation.ID, "turn-2")
	if err != nil {
		t.Fatalf("ConversationEditAnchor: %v", err)
	}
	if anchor.ConversationID != conversation.ID || anchor.SourceBranchID != conversation.ActiveBranchID ||
		anchor.ReplacedTurnID != "turn-2" || anchor.PreviousProviderTurnID != "provider-turn-1" ||
		anchor.ForkAfterSequence != 2 {
		t.Fatalf("edit anchor = %+v", anchor)
	}
	wantDelivery := `[{"type":"text","text":"second prompt"},{"type":"image","url":"data:image/png;base64,AA=="}]`
	if anchor.OriginalDeliveryContentJSON != wantDelivery {
		t.Fatalf("delivery content = %q, want %q", anchor.OriginalDeliveryContentJSON, wantDelivery)
	}

	first, err := s.ConversationEditAnchor(ctx, conversation.ID, "turn-1")
	if err != nil {
		t.Fatalf("ConversationEditAnchor first prompt: %v", err)
	}
	if first.PreviousProviderTurnID != "" || first.ForkAfterSequence != 0 {
		t.Fatalf("first prompt anchor = %+v", first)
	}
}

func TestConversationBranchRootLearnsFreshProviderConversationID(t *testing.T) {
	ctx := context.Background()
	s := newTestStore(t)
	seedProject(t, s, "fresh-branch")
	rec := sampleRecord("fresh-branch")
	rec.Mode = domain.SessionModeChat
	session, err := s.CreateSession(ctx, rec)
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	conversation, err := s.CreateConversation(ctx, "fresh-conversation", domain.ConversationScopeSession,
		"fresh-branch", session.ID, testNow)
	if err != nil {
		t.Fatalf("CreateConversation: %v", err)
	}

	session.Metadata.ProviderConversationID = "thread-created-after-conversation"
	session.Metadata.ControllerGeneration = "generation-fresh"
	if err := s.UpdateSession(ctx, session); err != nil {
		t.Fatalf("UpdateSession controller result: %v", err)
	}
	root, err := s.ConversationBranch(ctx, conversation.ID, conversation.ActiveBranchID)
	if err != nil {
		t.Fatalf("ConversationBranch: %v", err)
	}
	if root.ProviderConversationID != session.Metadata.ProviderConversationID {
		t.Fatalf("root provider conversation = %q, want %q",
			root.ProviderConversationID, session.Metadata.ProviderConversationID)
	}
}

func TestActivateConversationBranchMovesProviderAndGenerationTogether(t *testing.T) {
	ctx := context.Background()
	s, session, conversation := seededChatConversation(t)
	seedBranchTurns(t, s, session, conversation)
	branch := domain.ConversationBranch{
		ID:                     "branch-child",
		ConversationID:         conversation.ID,
		ProviderConversationID: "thread-child",
		ParentBranchID:         conversation.ActiveBranchID,
		ForkAfterTurnID:        "turn-1",
		ReplacedTurnID:         "turn-2",
		ForkAfterSequence:      2,
	}
	if err := s.CreateConversationBranch(ctx, branch, testNow); err != nil {
		t.Fatalf("CreateConversationBranch: %v", err)
	}
	if err := s.ActivateConversationBranch(ctx, session.ID, conversation.ID, branch.ID, "thread-child", "generation-child", testNow); err != nil {
		t.Fatalf("ActivateConversationBranch: %v", err)
	}
	got, found, err := s.GetSession(ctx, session.ID)
	if err != nil || !found {
		t.Fatalf("GetSession: found=%v err=%v", found, err)
	}
	if got.Metadata.ProviderConversationID != "thread-child" || got.Metadata.ControllerGeneration != "generation-child" {
		t.Fatalf("session controller metadata = %+v", got.Metadata)
	}
	branches, err := s.ConversationBranches(ctx, conversation.ID)
	if err != nil {
		t.Fatalf("ConversationBranches: %v", err)
	}
	if len(branches) != 2 {
		t.Fatalf("branches = %+v", branches)
	}
	byID := map[string]domain.ConversationBranch{}
	for _, gotBranch := range branches {
		byID[gotBranch.ID] = gotBranch
	}
	if byID[conversation.ActiveBranchID].Active || !byID[branch.ID].Active || byID[branch.ID].SessionID != session.ID {
		t.Fatalf("branches = %+v", branches)
	}

	created, err := s.AppendUserMessage(ctx, conversation.ID, session.ID, "generation-child", domain.ConversationMessage{
		ID: "message-replacement", Origin: domain.MessageOriginHuman, Text: "edited second prompt",
		ClientMessageID: "client-replacement",
	}, "turn-replacement", testNow.Add(2*time.Minute))
	if err != nil || !created {
		t.Fatalf("AppendUserMessage replacement: created=%v err=%v", created, err)
	}
	if err := s.UpdateConversationBranchReplacement(ctx, branch.ID, "turn-replacement"); err != nil {
		t.Fatalf("UpdateConversationBranchReplacement: %v", err)
	}
	child, err := s.ConversationBranch(ctx, conversation.ID, branch.ID)
	if err != nil || child.ReplacementTurnID != "turn-replacement" {
		t.Fatalf("child branch = %+v err=%v", child, err)
	}
}

func TestActivateConversationBranchRollsBackWhenSessionCannotMove(t *testing.T) {
	ctx := context.Background()
	s, session, conversation := seededChatConversation(t)
	seedBranchTurns(t, s, session, conversation)
	branch := domain.ConversationBranch{
		ID: "branch-child", ConversationID: conversation.ID,
		ProviderConversationID: "thread-child", ParentBranchID: conversation.ActiveBranchID,
		ForkAfterTurnID: "turn-1", ReplacedTurnID: "turn-2", ForkAfterSequence: 2,
	}
	if err := s.CreateConversationBranch(ctx, branch, testNow); err != nil {
		t.Fatalf("CreateConversationBranch: %v", err)
	}
	session.IsTerminated = true
	if err := s.UpdateSession(ctx, session); err != nil {
		t.Fatalf("terminate session: %v", err)
	}
	if err := s.ActivateConversationBranch(ctx, session.ID, conversation.ID, branch.ID, "thread-child", "generation-child", testNow); err == nil {
		t.Fatal("ActivateConversationBranch succeeded for a terminated session")
	}
	root, err := s.ConversationBranch(ctx, conversation.ID, conversation.ActiveBranchID)
	if err != nil || !root.Active {
		t.Fatalf("root after refused activation = %+v err=%v", root, err)
	}
	child, err := s.ConversationBranch(ctx, conversation.ID, branch.ID)
	if err != nil || child.Active {
		t.Fatalf("child after refused activation = %+v err=%v", child, err)
	}
}

func TestConversationBranchRejectsCrossConversationReferences(t *testing.T) {
	ctx := context.Background()
	s, session, conversation := seededChatConversation(t)
	seedBranchTurns(t, s, session, conversation)

	otherRecord := sampleRecord("branches")
	otherRecord.Mode = domain.SessionModeChat
	otherRecord.Metadata.ProviderConversationID = "thread-other"
	otherSession, err := s.CreateSession(ctx, otherRecord)
	if err != nil {
		t.Fatalf("CreateSession other: %v", err)
	}
	otherConversation, err := s.CreateConversation(ctx, "conversation-other", domain.ConversationScopeSession,
		"branches", otherSession.ID, testNow)
	if err != nil {
		t.Fatalf("CreateConversation other: %v", err)
	}
	created, err := s.AppendUserMessage(ctx, otherConversation.ID, otherSession.ID, "generation-other",
		domain.ConversationMessage{ID: "message-other", Origin: domain.MessageOriginHuman, Text: "other"},
		"turn-other", testNow)
	if err != nil || !created {
		t.Fatalf("AppendUserMessage other: created=%v err=%v", created, err)
	}

	for _, tc := range []struct {
		name   string
		branch domain.ConversationBranch
	}{
		{
			name: "parent",
			branch: domain.ConversationBranch{
				ID: "branch-wrong-parent", ConversationID: conversation.ID,
				ProviderConversationID: "thread-wrong-parent", ParentBranchID: otherConversation.ActiveBranchID,
			},
		},
		{
			name: "fork turn",
			branch: domain.ConversationBranch{
				ID: "branch-wrong-fork", ConversationID: conversation.ID,
				ProviderConversationID: "thread-wrong-fork", ParentBranchID: conversation.ActiveBranchID,
				ForkAfterTurnID: "turn-other", ReplacedTurnID: "turn-2",
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := s.CreateConversationBranch(ctx, tc.branch, testNow); err == nil {
				t.Fatalf("CreateConversationBranch accepted cross-conversation %s", tc.name)
			}
		})
	}

	valid := domain.ConversationBranch{
		ID: "branch-valid", ConversationID: conversation.ID,
		ProviderConversationID: "thread-valid", ParentBranchID: conversation.ActiveBranchID,
		ForkAfterTurnID: "turn-1", ReplacedTurnID: "turn-2", ForkAfterSequence: 2,
	}
	if err := s.CreateConversationBranch(ctx, valid, testNow); err != nil {
		t.Fatalf("CreateConversationBranch valid: %v", err)
	}
	if err := s.UpdateConversationBranchReplacement(ctx, valid.ID, "turn-other"); err == nil {
		t.Fatal("UpdateConversationBranchReplacement accepted a turn from another conversation")
	}
	got, err := s.ConversationBranch(ctx, conversation.ID, valid.ID)
	if err != nil || got.ReplacementTurnID != "" {
		t.Fatalf("branch after refused replacement = %+v err=%v", got, err)
	}
}

func TestConversationEditAnchorRejectsMissingOrNonHumanTurn(t *testing.T) {
	ctx := context.Background()
	s, _, conversation := seededChatConversation(t)
	if _, err := s.ConversationEditAnchor(ctx, conversation.ID, "missing"); !errors.Is(err, store.ErrConversationTurnNotFound) {
		t.Fatalf("missing edit anchor error = %v", err)
	}
}
