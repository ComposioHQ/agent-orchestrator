package daemon

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/orchestrationevents"
)

type automationSenderFake struct {
	id           domain.SessionID
	message, key string
	err          error
}

func (f *automationSenderFake) SendAutomation(_ context.Context, id domain.SessionID, message, key string) error {
	f.id = id
	f.message = message
	f.key = key
	return f.err
}

func TestOrchestrationTransportChatAcknowledgesStableClientMessageID(t *testing.T) {
	s := &automationSenderFake{}
	result, err := (orchestrationTransport{sender: s}).Submit(context.Background(), domain.SessionRecord{ID: "o", Mode: domain.SessionModeChat}, orchestrationevents.Batch{ID: "batch", Payload: "safe"})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Submitted || !result.Acknowledged || s.key != "batch" {
		t.Fatalf("result=%+v key=%q", result, s.key)
	}
}
func TestOrchestrationTransportTUIWaitsForHookAcknowledgement(t *testing.T) {
	s := &automationSenderFake{}
	result, err := (orchestrationTransport{sender: s}).Submit(context.Background(), domain.SessionRecord{ID: "o", Mode: domain.SessionModeTUI}, orchestrationevents.Batch{ID: "batch", Payload: "safe"})
	if err != nil {
		t.Fatal(err)
	}
	if !result.Submitted || result.Acknowledged {
		t.Fatalf("result=%+v", result)
	}
}
func TestOrchestrationTransportFailureClaimsNoSubmission(t *testing.T) {
	s := &automationSenderFake{err: errors.New("no")}
	result, err := (orchestrationTransport{sender: s}).Submit(context.Background(), domain.SessionRecord{ID: "o", Mode: domain.SessionModeChat}, orchestrationevents.Batch{ID: "batch", Payload: "safe"})
	if err == nil || result.Submitted || result.Acknowledged {
		t.Fatalf("result=%+v err=%v", result, err)
	}
}
