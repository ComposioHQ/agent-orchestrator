package domain

import "time"

// TurnID identifies a conversation turn.
type TurnID string

// ConversationID identifies a conversation within a session.
type ConversationID string

// TurnRole is the role of a turn.
type TurnRole string

const (
	TurnRoleHuman TurnRole = "human"
	TurnRoleAgent TurnRole = "agent"
)

// TurnState is the lifecycle state of a turn.
type TurnState string

const (
	TurnStateQueued      TurnState = "queued"
	TurnStateRunning     TurnState = "running"
	TurnStateCompleted   TurnState = "completed"
	TurnStatePromoted    TurnState = "promoted"
	TurnStateInterrupted TurnState = "interrupted"
)

// ConversationTurn is the persistence shape for a queued or running human turn.
type ConversationTurn struct {
	ID                   TurnID         `json:"id"`
	SessionID            SessionID      `json:"sessionId"`
	ConversationID       ConversationID `json:"conversationId"`
	Role                 TurnRole       `json:"role"`
	State                TurnState      `json:"state"`
	Text                 string         `json:"text"`
	ClientID             string         `json:"clientId,omitempty"`
	DeliveryContentJSON  string         `json:"deliveryContentJson,omitempty"`
	CreatedAt            time.Time      `json:"createdAt"`
	UpdatedAt            time.Time      `json:"updatedAt"`
}
