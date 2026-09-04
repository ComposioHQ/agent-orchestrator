package browserruntime

// ReadinessState is the actionable lifecycle state of one session-owned
// browser target. It is derived from the live runtime and is never persisted.
type ReadinessState string

const (
	// ReadinessDesktopClosed means no desktop or hidden browser provider is connected.
	ReadinessDesktopClosed ReadinessState = "desktop_closed"
	// ReadinessRuntimeConnecting means the hidden Electron provider is starting.
	ReadinessRuntimeConnecting ReadinessState = "runtime_connecting"
	// ReadinessTargetStarting means a browser target is being created.
	ReadinessTargetStarting ReadinessState = "target_starting"
	// ReadinessPageLoading means the target is navigating or loading content.
	ReadinessPageLoading ReadinessState = "page_loading"
	// ReadinessReady means the target can accept browser operations.
	ReadinessReady ReadinessState = "ready"
	// ReadinessRecovering means the runtime lost its provider and is reconnecting.
	ReadinessRecovering ReadinessState = "recovering"
	// ReadinessUnavailable means browser operations cannot currently proceed.
	ReadinessUnavailable ReadinessState = "unavailable"
)

// Target describes the exact logical tab observed by the runtime.
type Target struct {
	TabID              string `json:"tabId"`
	URL                string `json:"url"`
	Title              string `json:"title"`
	Loading            bool   `json:"loading"`
	SnapshotGeneration int    `json:"snapshotGeneration"`
}

// Image is visual evidence captured from the target.
type Image struct {
	MIMEType                 string `json:"mimeType"`
	Data                     string `json:"data"`
	Width                    int    `json:"width"`
	Height                   int    `json:"height"`
	URL                      string `json:"url"`
	UntrustedExternalContent bool   `json:"untrustedExternalContent"`
}

// Element is one actionable node exposed by an accessibility snapshot.
type Element struct {
	Ref         string  `json:"ref"`
	Role        string  `json:"role"`
	Name        string  `json:"name"`
	Fingerprint Locator `json:"fingerprint"`
}

// Snapshot is the compact accessibility observation for a target generation.
type Snapshot struct {
	URL                      string    `json:"url"`
	Title                    string    `json:"title"`
	Generation               int       `json:"generation"`
	Text                     string    `json:"text"`
	Elements                 []Element `json:"elements"`
	TotalNodes               int       `json:"totalNodes"`
	Truncated                bool      `json:"truncated"`
	UntrustedExternalContent bool      `json:"untrustedExternalContent"`
}

// LogEntry is one bounded console or page error observation.
type LogEntry struct {
	Level     string `json:"level"`
	Message   string `json:"message"`
	Source    string `json:"source,omitempty"`
	Line      int    `json:"line,omitempty"`
	Timestamp string `json:"timestamp"`
}

// Problems contains diagnostics read explicitly as part of an observation.
// These values are returned to the caller only; they are never pushed into an
// agent session.
type Problems struct {
	Console []LogEntry `json:"console"`
	Errors  []LogEntry `json:"errors"`
}

// Observation combines correlated semantic and optional visual evidence from
// one target.
type Observation struct {
	State                    ReadinessState `json:"state" enum:"page_loading,ready"`
	Provider                 string         `json:"provider"`
	Target                   Target         `json:"target"`
	Snapshot                 Snapshot       `json:"snapshot"`
	Screenshot               *Image         `json:"screenshot,omitempty"`
	Problems                 *Problems      `json:"problems,omitempty"`
	RecommendedAction        string         `json:"recommendedAction,omitempty"`
	UntrustedExternalContent bool           `json:"untrustedExternalContent"`
}

// ObserveOptions controls the evidence included in one atomic observation.
type ObserveOptions struct {
	TabID             string `json:"tabId,omitempty"`
	InteractiveOnly   bool   `json:"interactiveOnly"`
	IncludeScreenshot bool   `json:"includeScreenshot"`
	IncludeProblems   bool   `json:"includeProblems"`
}

// Locator identifies one page element semantically. The runtime rejects zero
// or multiple matches instead of guessing which element the caller intended.
type Locator struct {
	Role        string `json:"role,omitempty"`
	Name        string `json:"name,omitempty"`
	Label       string `json:"label,omitempty"`
	Placeholder string `json:"placeholder,omitempty"`
	Text        string `json:"text,omitempty"`
	TestID      string `json:"testId,omitempty"`
	CSS         string `json:"css,omitempty"`
	Exact       bool   `json:"exact,omitempty"`
}

// ExpectedState pins a mutation to the exact state previously observed. A tab
// selection or navigation between observe and act therefore fails closed.
type ExpectedState struct {
	TabID              string `json:"tabId"`
	ExpectedURL        string `json:"expectedUrl"`
	SnapshotGeneration int    `json:"snapshotGeneration"`
}

// ActionWait is the bounded stabilization performed after a mutation.
type ActionWait struct {
	Load      bool `json:"load,omitempty"`
	StableMS  int  `json:"stableMs,omitempty"`
	TimeoutMS int  `json:"timeoutMs,omitempty"`
}

// ActionState is the compact state captured on either side of a mutation.
type ActionState struct {
	TabID              string `json:"tabId"`
	URL                string `json:"url"`
	SnapshotGeneration int    `json:"snapshotGeneration"`
	Loading            bool   `json:"loading"`
	ErrorCount         int    `json:"errorCount"`
}

// ActionEffects summarizes evidence without including console or page error
// contents. Diagnostics remain explicit, opt-in observations.
type ActionEffects struct {
	Navigated       bool `json:"navigated"`
	DocumentChanged bool `json:"documentChanged"`
	NewErrorCount   int  `json:"newErrorCount"`
}

// ActionEvidence describes the observable effects of one mutation.
type ActionEvidence struct {
	Before            ActionState   `json:"before"`
	After             ActionState   `json:"after"`
	Effects           ActionEffects `json:"effects"`
	Target            *ActionTarget `json:"target,omitempty"`
	RecommendedAction string        `json:"recommendedAction"`
}

// ActionTarget records how the runtime resolved the requested element.
type ActionTarget struct {
	Label    string   `json:"label"`
	Locator  *Locator `json:"locator,omitempty"`
	Remapped bool     `json:"remapped"`
}
