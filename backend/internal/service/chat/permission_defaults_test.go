package chat_test

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestReplacingBypassSettingsWithEmptyApprovalDispatchesDefault(t *testing.T) {
	for _, replacement := range []domain.ConversationSettings{{}, {Model: "new-model"}} {
		name := "empty-settings"
		if replacement.Model != "" {
			name = "model-only"
		}
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			ctx := context.Background()
			if _, err := h.svc.SetTurnSettings(ctx, testSession, domain.ConversationSettings{ApprovalMode: domain.PermissionModeBypassPermissions}); err != nil {
				t.Fatal(err)
			}
			// PATCH settings replaces the durable choices, including omitted approvalMode.
			if _, err := h.svc.SetTurnSettings(ctx, testSession, replacement); err != nil {
				t.Fatal(err)
			}
			if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "next", Origin: domain.MessageOriginHuman}); err != nil {
				t.Fatal(err)
			}
			sent := h.conv.sentMessages()
			if len(sent) != 1 || sent[0].Settings.Approval != ports.PermissionModeDefault {
				t.Fatalf("next turn must explicitly reset native permissions: %+v", sent)
			}
		})
	}
}

func TestExplicitChatPermissionModes(t *testing.T) {
	for _, mode := range []domain.PermissionMode{domain.PermissionModeManual, domain.PermissionModeDontAsk} {
		t.Run(string(mode), func(t *testing.T) {
			ctx := context.Background()
			h := newHarness(t)
			if _, err := h.svc.SetTurnSettings(ctx, testSession, domain.ConversationSettings{ApprovalMode: mode}); err != nil {
				t.Fatal(err)
			}
			if _, err := h.svc.Send(ctx, testSession, ports.ChatUserMessage{Text: "next", Origin: domain.MessageOriginHuman}); err != nil {
				t.Fatal(err)
			}
			sent := h.conv.sentMessages()
			if len(sent) != 1 || sent[0].Settings.Approval != mode {
				t.Fatalf("approval not dispatched: %+v", sent)
			}
			other := newHarnessForHarness(t, domain.HarnessClaudeCode)
			if _, err := other.svc.SetTurnSettings(ctx, testSession, domain.ConversationSettings{ApprovalMode: mode}); !errors.Is(err, ports.ErrChatPermissionModeUnsupported) {
				t.Fatalf("unsupported mode error = %v", err)
			}
			controller, err := other.svc.Controller(testSession)
			if err != nil {
				t.Fatal(err)
			}
			if controller.Settings().ApprovalMode == mode {
				t.Fatal("unsupported policy persisted")
			}
		})
	}
}
