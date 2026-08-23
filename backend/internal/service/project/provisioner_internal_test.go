package project

import (
	"context"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestLocalProjectProvisionerCompensationIsIdempotent(t *testing.T) {
	provisioner := New(nil).provisioner
	request := ports.ProjectProvisionCompensation{
		AttemptID: "local-attempt", IdempotencyKey: "local-key", Reason: "test rollback",
	}
	for attempt := 0; attempt < 2; attempt++ {
		result, err := provisioner.Compensate(context.Background(), request)
		if err != nil {
			t.Fatalf("Compensate attempt %d: %v", attempt+1, err)
		}
		if result.State != ports.ProjectProvisionCompensated || result.AttemptID != request.AttemptID || result.IdempotencyKey != request.IdempotencyKey {
			t.Fatalf("Compensate attempt %d = %#v", attempt+1, result)
		}
	}
}
