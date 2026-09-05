package daemon

import (
	"context"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/orchestrationevents"
)

type automationSender interface {
	SendAutomation(context.Context, domain.SessionID, string, string) error
}

type orchestrationTransport struct{ sender automationSender }

func (t orchestrationTransport) Submit(ctx context.Context, target domain.SessionRecord, batch orchestrationevents.Batch) (orchestrationevents.Submission, error) {
	err := t.sender.SendAutomation(ctx, target.ID, batch.Payload, batch.ID)
	if err != nil {
		return orchestrationevents.Submission{}, err
	}
	// Chat's durable client-message-id admission is the acknowledgement. TUI is
	// submitted only; its exact prompt-submit hook closes the leased batch.
	return orchestrationevents.Submission{Submitted: true, Acknowledged: domain.NormalizeSessionMode(target.Mode) == domain.SessionModeChat}, nil
}
