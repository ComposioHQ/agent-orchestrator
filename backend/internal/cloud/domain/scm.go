package domain

import "time"

const SCMProviderGitHub = "github"

const (
	SCMWebhookClassificationObservation = "observation"
	SCMWebhookClassificationIgnored     = "ignored"
	SCMWebhookClassificationMalformed   = "malformed_json"
)

const (
	SCMWebhookStateProcessing = "processing"
	SCMWebhookStateRetry      = "retry"
	SCMWebhookStateComplete   = "complete"
	SCMWebhookStateDeadLetter = "dead_letter"
)

const (
	SCMWebhookOutcomeComplete = "complete"
	SCMWebhookOutcomeRetry    = "retry"
)

// SCMWebhookReceipt is the complete durable input for a verified delivery.
// A store must persist it and acquire any initial lease atomically.
type SCMWebhookReceipt struct {
	Provider       string
	DeliveryID     string
	Event          string
	Body           []byte
	Classification string
	TerminalError  string
}

// SCMWebhookClaim is one exclusive processing lease. LeaseID must accompany
// completion so an expired worker cannot finish a subsequently recovered
// attempt.
type SCMWebhookClaim struct {
	Provider       string
	DeliveryID     string
	Event          string
	Body           []byte
	Classification string
	State          string
	LeaseID        string
	Attempts       int
	FirstReceipt   bool
	Claimed        bool
	ReceivedAt     time.Time
	NextAttemptAt  time.Time
	LeaseExpiresAt time.Time
}
