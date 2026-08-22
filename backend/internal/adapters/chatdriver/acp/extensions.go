package acp

import (
	"context"
	"encoding/json"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// ClientApprovalRequest describes a provider extension's blocking approval in
// AO's durable, provider-neutral vocabulary.
type ClientApprovalRequest struct {
	Summary      string
	ActivityKind domain.ActivityKind
	Detail       []byte
	Decisions    []ports.ChatDecisionOption
}

// ClientExtensionBridge exposes only the durable user-interaction operations a
// provider extension may need while its JSON-RPC request is blocked.
type ClientExtensionBridge interface {
	RequestInput(context.Context, ports.ChatInputRequest) (ports.ChatInputResponse, error)
	RequestApproval(context.Context, ClientApprovalRequest) (string, error)
	UpdatePlan(*domain.ConversationPlan)
}

// ClientExtensionHandler handles provider-defined agent-to-client JSON-RPC
// methods, including providers whose legacy names do not use ACP's `_` prefix.
// handled=false delegates to the standard ACP method dispatcher.
type ClientExtensionHandler func(
	context.Context,
	ClientExtensionBridge,
	string,
	json.RawMessage,
) (result any, handled bool, err error)
