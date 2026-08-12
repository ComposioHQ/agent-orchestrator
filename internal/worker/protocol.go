package worker

// BootstrapRequest is what a worker sends to redeem its one-time ticket.
type BootstrapRequest struct {
	BootstrapToken string   `json:"bootstrapToken"`
	Version        string   `json:"version"`
	Capabilities   []string `json:"capabilities"`
}

// LaunchContext is the durable session context handed to a bootstrapped worker.
type LaunchContext struct {
	SessionID     string `json:"sessionId"`
	ProjectID     string `json:"projectId"`
	Kind          string `json:"kind"`
	Harness       string `json:"harness"`
	DisplayName   string `json:"displayName"`
	Branch        string `json:"branch"`
	RepositoryURL string `json:"repositoryUrl"`
	DefaultBranch string `json:"defaultBranch"`
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
