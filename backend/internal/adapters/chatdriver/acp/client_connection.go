package acp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"

	acpsdk "github.com/coder/acp-go-sdk"
)

// clientConnection keeps AO on the SDK's JSON-RPC transport while extending
// its generated client dispatcher. The pinned SDK only dispatches custom method
// names beginning with `_`; Cursor's documented blocking methods use the legacy
// `cursor/` namespace, so AO must route those names before standard ACP dispatch.
type clientConnection struct {
	conn      *acpsdk.Connection
	client    acpsdk.Client
	bridge    ClientExtensionBridge
	extension ClientExtensionHandler
}

func newClientConnection(
	client acpsdk.Client,
	extension ClientExtensionHandler,
	peerInput io.Writer,
	peerOutput io.Reader,
) *clientConnection {
	connection := &clientConnection{client: client, extension: extension}
	connection.bridge, _ = client.(ClientExtensionBridge)
	connection.conn = acpsdk.NewConnection(connection.handle, peerInput, peerOutput)
	return connection
}

func (c *clientConnection) Done() <-chan struct{}      { return c.conn.Done() }
func (c *clientConnection) SetLogger(log *slog.Logger) { c.conn.SetLogger(log) }

func (c *clientConnection) handle(
	ctx context.Context,
	method string,
	params json.RawMessage,
) (any, *acpsdk.RequestError) {
	if c.extension != nil && c.bridge != nil {
		result, handled, err := c.extension(ctx, c.bridge, method, params)
		if handled {
			if err != nil {
				return nil, requestError(err)
			}
			return result, nil
		}
	}

	switch method {
	case acpsdk.ClientMethodElicitationComplete:
		var p acpsdk.UnstableCompleteElicitationNotification
		if err := decodeClientParams(params, &p); err != nil {
			return nil, err
		}
		experimental, ok := c.client.(acpsdk.ClientExperimental)
		if !ok {
			return nil, acpsdk.NewMethodNotFound(method)
		}
		return nil, requestErrorOrNil(experimental.UnstableCompleteElicitation(ctx, p))
	case acpsdk.ClientMethodElicitationCreate:
		var p acpsdk.UnstableCreateElicitationRequest
		if err := decodeClientParams(params, &p); err != nil {
			return nil, err
		}
		experimental, ok := c.client.(acpsdk.ClientExperimental)
		if !ok {
			return nil, acpsdk.NewMethodNotFound(method)
		}
		result, err := experimental.UnstableCreateElicitation(ctx, p)
		return result, requestErrorOrNil(err)
	case acpsdk.ClientMethodFsReadTextFile:
		var p acpsdk.ReadTextFileRequest
		if err := decodeClientParams(params, &p); err != nil {
			return nil, err
		}
		result, err := c.client.ReadTextFile(ctx, p)
		return result, requestErrorOrNil(err)
	case acpsdk.ClientMethodFsWriteTextFile:
		var p acpsdk.WriteTextFileRequest
		if err := decodeClientParams(params, &p); err != nil {
			return nil, err
		}
		result, err := c.client.WriteTextFile(ctx, p)
		return result, requestErrorOrNil(err)
	case acpsdk.ClientMethodMcpConnect:
		var p acpsdk.UnstableConnectMcpRequest
		if err := decodeClientParams(params, &p); err != nil {
			return nil, err
		}
		experimental, ok := c.client.(acpsdk.ClientExperimental)
		if !ok {
			return nil, acpsdk.NewMethodNotFound(method)
		}
		result, err := experimental.UnstableConnectMcp(ctx, p)
		return result, requestErrorOrNil(err)
	case acpsdk.ClientMethodMcpDisconnect:
		var p acpsdk.UnstableDisconnectMcpRequest
		if err := decodeClientParams(params, &p); err != nil {
			return nil, err
		}
		experimental, ok := c.client.(acpsdk.ClientExperimental)
		if !ok {
			return nil, acpsdk.NewMethodNotFound(method)
		}
		result, err := experimental.UnstableDisconnectMcp(ctx, p)
		return result, requestErrorOrNil(err)
	case acpsdk.ClientMethodSessionRequestPermission:
		var p acpsdk.RequestPermissionRequest
		if err := decodeClientParams(params, &p); err != nil {
			return nil, err
		}
		result, err := c.client.RequestPermission(ctx, p)
		return result, requestErrorOrNil(err)
	case acpsdk.ClientMethodSessionUpdate:
		var p acpsdk.SessionNotification
		if err := decodeClientParams(params, &p); err != nil {
			return nil, err
		}
		return nil, requestErrorOrNil(c.client.SessionUpdate(ctx, p))
	case acpsdk.ClientMethodTerminalCreate:
		var p acpsdk.CreateTerminalRequest
		if err := decodeClientParams(params, &p); err != nil {
			return nil, err
		}
		result, err := c.client.CreateTerminal(ctx, p)
		return result, requestErrorOrNil(err)
	case acpsdk.ClientMethodTerminalKill:
		var p acpsdk.KillTerminalRequest
		if err := decodeClientParams(params, &p); err != nil {
			return nil, err
		}
		result, err := c.client.KillTerminal(ctx, p)
		return result, requestErrorOrNil(err)
	case acpsdk.ClientMethodTerminalOutput:
		var p acpsdk.TerminalOutputRequest
		if err := decodeClientParams(params, &p); err != nil {
			return nil, err
		}
		result, err := c.client.TerminalOutput(ctx, p)
		return result, requestErrorOrNil(err)
	case acpsdk.ClientMethodTerminalRelease:
		var p acpsdk.ReleaseTerminalRequest
		if err := decodeClientParams(params, &p); err != nil {
			return nil, err
		}
		result, err := c.client.ReleaseTerminal(ctx, p)
		return result, requestErrorOrNil(err)
	case acpsdk.ClientMethodTerminalWaitForExit:
		var p acpsdk.WaitForTerminalExitRequest
		if err := decodeClientParams(params, &p); err != nil {
			return nil, err
		}
		result, err := c.client.WaitForTerminalExit(ctx, p)
		return result, requestErrorOrNil(err)
	default:
		return nil, acpsdk.NewMethodNotFound(method)
	}
}

type clientParams interface{ Validate() error }

func decodeClientParams(raw json.RawMessage, target clientParams) *acpsdk.RequestError {
	if err := json.Unmarshal(raw, target); err != nil {
		return acpsdk.NewInvalidParams(map[string]any{"error": err.Error()})
	}
	if err := target.Validate(); err != nil {
		return acpsdk.NewInvalidParams(map[string]any{"error": err.Error()})
	}
	return nil
}

func requestErrorOrNil(err error) *acpsdk.RequestError {
	if err == nil {
		return nil
	}
	return requestError(err)
}

func requestError(err error) *acpsdk.RequestError {
	var requestErr *acpsdk.RequestError
	if errors.As(err, &requestErr) {
		return requestErr
	}
	return acpsdk.NewInternalError(map[string]any{"error": err.Error()})
}

func (c *clientConnection) Initialize(ctx context.Context, params acpsdk.InitializeRequest) (acpsdk.InitializeResponse, error) {
	return acpsdk.SendRequest[acpsdk.InitializeResponse](c.conn, ctx, acpsdk.AgentMethodInitialize, params)
}

func (c *clientConnection) NewSession(ctx context.Context, params acpsdk.NewSessionRequest) (acpsdk.NewSessionResponse, error) {
	return acpsdk.SendRequest[acpsdk.NewSessionResponse](c.conn, ctx, acpsdk.AgentMethodSessionNew, params)
}

func (c *clientConnection) LoadSession(ctx context.Context, params acpsdk.LoadSessionRequest) (acpsdk.LoadSessionResponse, error) {
	return acpsdk.SendRequest[acpsdk.LoadSessionResponse](c.conn, ctx, acpsdk.AgentMethodSessionLoad, params)
}

func (c *clientConnection) ResumeSession(ctx context.Context, params acpsdk.ResumeSessionRequest) (acpsdk.ResumeSessionResponse, error) {
	return acpsdk.SendRequest[acpsdk.ResumeSessionResponse](c.conn, ctx, acpsdk.AgentMethodSessionResume, params)
}

func (c *clientConnection) Prompt(ctx context.Context, params acpsdk.PromptRequest) (acpsdk.PromptResponse, error) {
	response, err := acpsdk.SendRequest[acpsdk.PromptResponse](c.conn, ctx, acpsdk.AgentMethodSessionPrompt, params)
	if err != nil && ctx.Err() != nil {
		_ = c.Cancel(context.Background(), acpsdk.CancelNotification{SessionId: params.SessionId})
	}
	return response, err
}

func (c *clientConnection) Cancel(ctx context.Context, params acpsdk.CancelNotification) error {
	return c.conn.SendNotification(ctx, acpsdk.AgentMethodSessionCancel, params)
}

func (c *clientConnection) CloseSession(ctx context.Context, params acpsdk.CloseSessionRequest) (acpsdk.CloseSessionResponse, error) {
	return acpsdk.SendRequest[acpsdk.CloseSessionResponse](c.conn, ctx, acpsdk.AgentMethodSessionClose, params)
}

func (c *clientConnection) SetSessionMode(ctx context.Context, params acpsdk.SetSessionModeRequest) (acpsdk.SetSessionModeResponse, error) {
	return acpsdk.SendRequest[acpsdk.SetSessionModeResponse](c.conn, ctx, acpsdk.AgentMethodSessionSetMode, params)
}

func (c *clientConnection) SetSessionConfigOption(ctx context.Context, params acpsdk.SetSessionConfigOptionRequest) (acpsdk.SetSessionConfigOptionResponse, error) {
	return acpsdk.SendRequest[acpsdk.SetSessionConfigOptionResponse](c.conn, ctx, acpsdk.AgentMethodSessionSetConfigOption, params)
}

func (c *clientConnection) CallExtension(ctx context.Context, method string, params any) (json.RawMessage, error) {
	return acpsdk.SendRequest[json.RawMessage](c.conn, ctx, method, params)
}
