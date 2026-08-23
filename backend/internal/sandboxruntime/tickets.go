package sandboxruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

// ControlPlaneTicketConsumer delegates the replay boundary to the durable
// public control plane. It intentionally keeps no accepted-ticket cache or
// offline verification key.
type ControlPlaneTicketConsumer struct {
	client      *ControlPlaneClient
	route       string
	sandboxID   string
	workspaceID string
	sessionID   domain.SessionID
}

func newControlPlaneTicketConsumer(client *ControlPlaneClient, route, sandboxID, workspaceID string, sessionID domain.SessionID) (*ControlPlaneTicketConsumer, error) {
	if client == nil {
		return nil, errors.New("control-plane ticket consumer requires a client")
	}
	if !strings.HasPrefix(route, "/api/cloud/v1/") || strings.ContainsAny(route, "?#") {
		return nil, errors.New("ticket consume route must be a public cloud API route")
	}
	if strings.TrimSpace(sandboxID) == "" || strings.TrimSpace(workspaceID) == "" || strings.TrimSpace(string(sessionID)) == "" {
		return nil, errors.New("ticket consumer requires sandbox, workspace, and session scope")
	}
	return &ControlPlaneTicketConsumer{
		client: client, route: route, sandboxID: sandboxID, workspaceID: workspaceID, sessionID: sessionID,
	}, nil
}

func (c *ControlPlaneTicketConsumer) Consume(ctx context.Context, ticket string, operation Operation) error {
	if ticket == "" || strings.ContainsAny(ticket, "\r\n") {
		return ErrTicketRejected
	}
	payload, err := json.Marshal(struct {
		Ticket      string           `json:"ticket"`
		SandboxID   string           `json:"sandboxId"`
		WorkspaceID string           `json:"workspaceId"`
		SessionID   domain.SessionID `json:"sessionId"`
		Operation   Operation        `json:"operation"`
	}{
		Ticket: ticket, SandboxID: c.sandboxID, WorkspaceID: c.workspaceID, SessionID: c.sessionID, Operation: operation,
	})
	if err != nil {
		return fmt.Errorf("encode ticket consume request: %w", err)
	}
	defer zeroBytes(payload)
	response, err := c.client.doAuthenticated(ctx, http.MethodPost, c.route, bytes.NewReader(payload))
	if err != nil {
		return ErrTicketRejected
	}
	_ = response.Body.Close()
	return nil
}
