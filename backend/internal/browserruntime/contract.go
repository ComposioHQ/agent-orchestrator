package browserruntime

// ReadinessState is the actionable lifecycle state of one session-owned
// browser target. It is derived from the live runtime and is never persisted.
type ReadinessState string

const (
	ReadinessDesktopClosed  ReadinessState = "desktop_closed"
	ReadinessTargetStarting ReadinessState = "target_starting"
	ReadinessPageLoading    ReadinessState = "page_loading"
	ReadinessReady          ReadinessState = "ready"
	ReadinessRecovering     ReadinessState = "recovering"
	ReadinessUnavailable    ReadinessState = "unavailable"
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
	Ref  string `json:"ref"`
	Role string `json:"role"`
	Name string `json:"name"`
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
	InteractiveOnly   bool `json:"interactiveOnly"`
	IncludeScreenshot bool `json:"includeScreenshot"`
	IncludeProblems   bool `json:"includeProblems"`
}
