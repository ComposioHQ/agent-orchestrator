package domain

import "time"

// OrchestrationEventKind names an AO-owned fact. Settled deliberately does not
// imply that a worker's task completed.
type OrchestrationEventKind string

const (
	OrchestrationWorkerTurnSettled OrchestrationEventKind = "worker_turn_settled"
	OrchestrationWorkerBlocked     OrchestrationEventKind = "worker_blocked"
	OrchestrationWorkerReadyMerge  OrchestrationEventKind = "worker_ready_to_merge"
	OrchestrationWorkerTerminated  OrchestrationEventKind = "worker_terminated"
	OrchestrationPRMerged          OrchestrationEventKind = "pr_merged"
)

type OrchestrationDeliveryState string

const (
	OrchestrationPending      OrchestrationDeliveryState = "pending"
	OrchestrationLeased       OrchestrationDeliveryState = "leased"
	OrchestrationSubmitted    OrchestrationDeliveryState = "submitted"
	OrchestrationAcknowledged OrchestrationDeliveryState = "acknowledged"
	OrchestrationDeadLetter   OrchestrationDeliveryState = "dead_letter"
)

// OrchestrationEvent is the durable normalized event and delivery state. It
// intentionally contains identifiers and enums only, never provider prose.
type OrchestrationEvent struct {
	ID, SourceRevision, LeaseToken, LastError   string
	ProjectID                                   ProjectID
	WorkerID, DestinationSessionID              SessionID
	Kind                                        OrchestrationEventKind
	State                                       OrchestrationDeliveryState
	AttemptCount                                int
	EnqueuedAt, NextAttemptAt                   time.Time
	LeaseExpiresAt, SubmittedAt, AcknowledgedAt time.Time
}
