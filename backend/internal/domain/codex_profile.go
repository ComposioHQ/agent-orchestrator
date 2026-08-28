package domain

// CodexProfileSource identifies who owns a Codex profile's home directory.
type CodexProfileSource string

const (
	// CodexProfileSourceExisting identifies the user's pre-existing Codex home.
	CodexProfileSourceExisting CodexProfileSource = "existing"
	// CodexProfileSourceManaged identifies an isolated profile created by AO.
	CodexProfileSourceManaged CodexProfileSource = "managed"
)

// CodexProfileStatus reports whether AO can safely inspect a profile with
// Codex. Broken profiles remain visible so users are not left with a silently
// missing identity.
type CodexProfileStatus string

const (
	// CodexProfileStatusValid permits native account operations for a profile.
	CodexProfileStatusValid CodexProfileStatus = "valid"
	// CodexProfileStatusBroken keeps an unsafe or malformed profile visible without probing it.
	CodexProfileStatusBroken CodexProfileStatus = "broken"
)

// CodexAuthMethod is the display-safe account kind returned by app-server.
type CodexAuthMethod string

const (
	// CodexAuthMethodChatGPT is browser-based ChatGPT authentication.
	CodexAuthMethodChatGPT CodexAuthMethod = "chatgpt"
	// CodexAuthMethodAPIKey is authentication owned by Codex's API key store.
	CodexAuthMethodAPIKey CodexAuthMethod = "api_key"
	// CodexAuthMethodOther is a recognized account with an unclassified method.
	CodexAuthMethodOther CodexAuthMethod = "other"
	// CodexAuthMethodUnknown means no safe authentication method was observed.
	CodexAuthMethodUnknown CodexAuthMethod = "unknown"
)

// CodexCapabilityState reports whether an installed Codex exposes a protocol
// surface. Unknown is deliberately distinct from unsupported.
type CodexCapabilityState string

const (
	// CodexCapabilitySupported confirms the installed protocol exposes a surface.
	CodexCapabilitySupported CodexCapabilityState = "supported"
	// CodexCapabilityUnsupported confirms the installed protocol omits a surface.
	CodexCapabilityUnsupported CodexCapabilityState = "unsupported"
	// CodexCapabilityUnknown means capability detection was inconclusive.
	CodexCapabilityUnknown CodexCapabilityState = "unknown"
)

// CodexCapabilityObservation is safe to expose to renderer clients.
type CodexCapabilityObservation struct {
	State      CodexCapabilityState `json:"state" enum:"supported,unsupported,unknown"`
	ReasonCode string               `json:"reasonCode"`
	Reason     string               `json:"reason"`
}

// CodexProfileCapabilities describes the structured account surfaces supported
// by the installed Codex binary.
type CodexProfileCapabilities struct {
	AccountRead  CodexCapabilityObservation `json:"accountRead"`
	BrowserLogin CodexCapabilityObservation `json:"browserLogin"`
}

// CodexProfileSnapshot is the public, display-safe view of one profile. Home
// paths and provider-owned credentials intentionally do not cross this boundary.
type CodexProfileSnapshot struct {
	ID                      string                         `json:"id"`
	Label                   string                         `json:"label"`
	Source                  CodexProfileSource             `json:"source" enum:"existing,managed"`
	Status                  CodexProfileStatus             `json:"status" enum:"valid,broken"`
	ReasonCode              string                         `json:"reasonCode"`
	Reason                  string                         `json:"reason"`
	Authentication          AgentAuthenticationObservation `json:"authentication"`
	AuthMethod              CodexAuthMethod                `json:"authMethod" enum:"chatgpt,api_key,other,unknown"`
	AccountEmail            *string                        `json:"accountEmail,omitempty"`
	UsableByCurrentLaunches bool                           `json:"usableByCurrentLaunches"`
}

const (
	// CodexProfileReasonValid reports a profile that is safe to inspect.
	CodexProfileReasonValid = "profile_valid"
	// CodexProfileReasonDescriptorInvalid reports an invalid managed descriptor.
	CodexProfileReasonDescriptorInvalid = "profile_descriptor_invalid"
	// CodexProfileReasonHomeMissing reports a missing managed home.
	CodexProfileReasonHomeMissing = "profile_home_missing"
	// CodexProfileReasonUnsafePath reports a symlinked or permission-unsafe profile path.
	CodexProfileReasonUnsafePath = "profile_unsafe_path"
	// CodexCapabilityReasonSupported reports a confirmed protocol capability.
	CodexCapabilityReasonSupported = "supported"
	// CodexCapabilityReasonUnsupported reports a confirmed missing protocol capability.
	CodexCapabilityReasonUnsupported = "unsupported"
	// CodexCapabilityReasonUnknown reports inconclusive capability detection.
	CodexCapabilityReasonUnknown = "unknown"
	// CodexProfileLoginReasonPending reports a login awaiting browser completion.
	CodexProfileLoginReasonPending = "login_pending"
	// CodexProfileLoginReasonCompleted reports verified authorization after login.
	CodexProfileLoginReasonCompleted = "login_completed"
	// CodexProfileLoginReasonCancelled reports cancellation of a pending login.
	CodexProfileLoginReasonCancelled = "login_cancelled"
	// CodexProfileLoginReasonFailed reports a safely categorized login failure.
	CodexProfileLoginReasonFailed = "login_failed"
)

// CodexProfileLoginStatus is the lifecycle of an in-memory browser login.
type CodexProfileLoginStatus string

const (
	// CodexProfileLoginPending is an active browser-login operation.
	CodexProfileLoginPending CodexProfileLoginStatus = "pending"
	// CodexProfileLoginCompleted is a terminal, verified login operation.
	CodexProfileLoginCompleted CodexProfileLoginStatus = "completed"
	// CodexProfileLoginCancelled is a terminal cancelled login operation.
	CodexProfileLoginCancelled CodexProfileLoginStatus = "cancelled"
	// CodexProfileLoginFailed is a terminal failed login operation.
	CodexProfileLoginFailed CodexProfileLoginStatus = "failed"
)

// CodexProfileLoginEvent is both the SSE payload and the terminal snapshot
// returned by cancellation.
type CodexProfileLoginEvent struct {
	OperationID string                  `json:"operationId"`
	ProfileID   string                  `json:"profileId"`
	Status      CodexProfileLoginStatus `json:"status" enum:"pending,completed,cancelled,failed"`
	ReasonCode  string                  `json:"reasonCode"`
	Reason      string                  `json:"reason"`
	Profile     *CodexProfileSnapshot   `json:"profile"`
}
