package worker

import "time"

// BootstrapRequest is what a worker sends to redeem its one-time ticket.
type BootstrapRequest struct {
	BootstrapToken string   `json:"bootstrapToken"`
	Version        string   `json:"version"`
	Capabilities   []string `json:"capabilities"`
}

// LaunchContext is the durable session context handed to a bootstrapped worker.
type LaunchContext struct {
	SessionID      string   `json:"sessionId"`
	ProjectID      string   `json:"projectId"`
	Kind           string   `json:"kind"`
	Harness        string   `json:"harness"`
	DisplayName    string   `json:"displayName"`
	Branch         string   `json:"branch"`
	Prompt         string   `json:"prompt,omitempty"`
	Mode           string   `json:"mode"`
	DeniedCommands []string `json:"deniedCommands"`
	RepositoryURL  string   `json:"repositoryUrl"`
	DefaultBranch  string   `json:"defaultBranch"`
}

// BootstrapResponse is the control plane's answer to a valid bootstrap ticket.
type BootstrapResponse struct {
	WorkerToken string        `json:"workerToken"`
	WorkerID    string        `json:"workerId"`
	Epoch       int64         `json:"epoch"`
	ExpiresIn   int           `json:"expiresIn"`
	SessionID   string        `json:"sessionId"`
	Launch      LaunchContext `json:"launch"`
}

// HeartbeatRequest reports that a worker is alive and what it can do.
type HeartbeatRequest struct {
	Version      string   `json:"version"`
	Capabilities []string `json:"capabilities"`
}

// HeartbeatResponse renews the worker's short-lived token.
type HeartbeatResponse struct {
	OK          bool   `json:"ok"`
	WorkerToken string `json:"workerToken"`
	ExpiresIn   int    `json:"expiresIn"`
}

// CheckoutGrantResponse carries a repository-scoped, short-lived GitHub App
// credential. Callers must never persist or log Token.
type CheckoutGrantResponse struct {
	CloneURL  string    `json:"cloneUrl"`
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// EventRequest publishes one worker-originated event onto the session stream.
type EventRequest struct {
	Type    string `json:"type"`
	Payload any    `json:"payload,omitempty"`
}

type ClaimTurnRequest struct{}

type Turn struct {
	ID              string   `json:"id"`
	Prompt          string   `json:"prompt"`
	Mode            string   `json:"mode"`
	DeniedCommands  []string `json:"deniedCommands"`
	Harness         string   `json:"harness"`
	Attempt         int      `json:"attempt"`
	CancelRequested bool     `json:"cancelRequested"`
	AgentSessionID  string   `json:"agentSessionId,omitempty"`
}

type ClaimTurnResponse struct {
	Turn *Turn `json:"turn"`
}

type CancellationResponse struct {
	Requested bool `json:"requested"`
}

type FinishTurnRequest struct {
	Attempt   int  `json:"attempt"`
	Cancelled bool `json:"cancelled,omitempty"`
}

type FailTurnRequest struct {
	Attempt int    `json:"attempt"`
	Error   string `json:"error"`
}

type FinishTurnResponse struct {
	OK              bool `json:"ok"`
	AlreadyFinished bool `json:"alreadyFinished"`
}

type CredentialResponse struct {
	Provider       string `json:"provider"`
	CredentialType string `json:"credentialType"`
	Secret         string `json:"secret"`
}

type ReadyEvent struct {
	WorkerID     string   `json:"workerId"`
	Epoch        int64    `json:"epoch"`
	Version      string   `json:"version"`
	Capabilities []string `json:"capabilities"`
}

type OutputEvent struct {
	TurnID  string `json:"turnId"`
	Attempt int    `json:"attempt"`
	Stream  string `json:"stream"`
	Text    string `json:"text"`
}

// TransportRequest is a fenced, durably routed workspace or terminal command.
type TransportRequest struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Attempt int    `json:"attempt"`
	Payload any    `json:"payload"`
}

type ClaimTransportResponse struct {
	Request *TransportRequest `json:"request"`
}

type CompleteTransportRequest struct {
	Attempt  int `json:"attempt"`
	Response any `json:"response"`
}

type FailTransportRequest struct {
	Attempt int    `json:"attempt"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type WorkspaceListRequest struct {
	Path   string `json:"path"`
	Cursor string `json:"cursor,omitempty"`
	Limit  int    `json:"limit"`
}

type WorkspaceReadRequest struct {
	Path string `json:"path"`
}

type WorkspaceWriteRequest struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

type WorkspaceEntry struct {
	Name    string    `json:"name"`
	Path    string    `json:"path"`
	IsDir   bool      `json:"isDir"`
	Size    int64     `json:"size"`
	Mode    string    `json:"mode"`
	ModTime time.Time `json:"modTime"`
}

type WorkspaceEntryPage struct {
	Path       string           `json:"path"`
	Items      []WorkspaceEntry `json:"items"`
	HasMore    bool             `json:"hasMore"`
	NextCursor string           `json:"nextCursor,omitempty"`
}

type WorkspaceFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Size    int64  `json:"size"`
}

type TerminalCommand struct {
	TerminalID string `json:"terminalId"`
	Kind       string `json:"kind,omitempty"`
	Data       []byte `json:"data,omitempty"`
	Columns    uint16 `json:"columns,omitempty"`
	Rows       uint16 `json:"rows,omitempty"`
}

type TerminalOutputRequest struct {
	Data []byte `json:"data"`
}

type TerminalExitRequest struct {
	ExitCode int `json:"exitCode"`
}

type AgentTerminalResponse struct {
	TerminalID string `json:"terminalId"`
}
