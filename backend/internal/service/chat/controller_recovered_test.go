package chat

import (
	"encoding/json"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestReconcileNativeHistoryUpgradesRecoveredWithKnownProviderOutcome(t *testing.T) {
	events := []ports.ChatEvent{{
		Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn",
		TurnState: domain.TurnStateCompleted,
	}}
	turns := []domain.ConversationTurn{{
		ID: "ao-turn", ProviderTurnID: "provider-turn", State: domain.TurnStateRecovered,
	}}

	got := reconcileNativeHistory(events, turns, nil, nil)
	if len(got) != 1 || got[0].TurnState != domain.TurnStateCompleted {
		t.Fatalf("reconciled events = %#v, want provider completed to upgrade recovered", got)
	}
}

func TestReconcileNativeHistoryPreservesKnownOutcomeOverRecoveredReplay(t *testing.T) {
	events := []ports.ChatEvent{{
		Kind: ports.ChatEventTurnCompleted, ProviderTurnID: "provider-turn",
		TurnState: domain.TurnStateRecovered,
	}}
	turns := []domain.ConversationTurn{{
		ID: "ao-turn", ProviderTurnID: "provider-turn", State: domain.TurnStateInterrupted,
	}}

	got := reconcileNativeHistory(events, turns, nil, nil)
	if len(got) != 1 || got[0].TurnState != domain.TurnStateInterrupted {
		t.Fatalf("reconciled events = %#v, want durable interrupted outcome", got)
	}
}

func TestReconcileNativeHistoryDeduplicatesLiveProviderErrorOnResume(t *testing.T) {
	turns := []domain.ConversationTurn{{
		ID: "ao-turn", ProviderTurnID: "provider-turn", State: domain.TurnStateFailed,
	}}
	activities := []domain.ConversationActivity{{
		ID: "live-error", TurnID: "ao-turn",
		Kind: domain.ActivityKindError, Status: domain.ActivityStatusFailed,
		Summary: "Reconnecting",
		Detail:  json.RawMessage(`{"headline":"Reconnecting","detail":"No credits remain.","action":"openai_billing"}`),
	}}
	events := []ports.ChatEvent{
		{Kind: ports.ChatEventTurnStarted, ProviderEventID: "history-start", ProviderTurnID: "provider-turn"},
		{
			Kind: ports.ChatEventError, ProviderEventID: "history-same-error", ProviderTurnID: "provider-turn",
			ErrorInfo: &ports.ChatErrorInfo{
				Headline: "Reconnecting", Detail: "No credits remain.",
				Action: ports.ChatRecoveryActionOpenAIBilling,
			},
		},
		{
			Kind: ports.ChatEventError, ProviderEventID: "history-distinct-error", ProviderTurnID: "provider-turn",
			ErrorInfo: &ports.ChatErrorInfo{
				Headline: "Connection failed", Detail: "The provider rejected the retry.",
			},
		},
		{
			Kind: ports.ChatEventTurnCompleted, ProviderEventID: "history-complete",
			ProviderTurnID: "provider-turn", TurnState: domain.TurnStateFailed,
		},
	}

	got := reconcileNativeHistory(events, turns, nil, activities)
	if len(got) != 3 {
		t.Fatalf("reconciled events = %#v, want lifecycle plus only the distinct provider error", got)
	}
	errorEvents := 0
	for _, event := range got {
		if event.Kind != ports.ChatEventError {
			continue
		}
		errorEvents++
		if event.ErrorInfo == nil || event.ErrorInfo.Headline != "Connection failed" {
			t.Fatalf("remaining error = %+v, want only the distinct history error", event.ErrorInfo)
		}
	}
	if errorEvents != 1 {
		t.Fatalf("remaining error events = %d, want 1", errorEvents)
	}
}
