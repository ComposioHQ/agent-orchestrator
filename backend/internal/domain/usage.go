package domain

import (
	"errors"
	"time"
)

// UsageSourceKind identifies the native artifact shape that produced usage
// facts. It is deliberately narrower than AgentHarness: only certified usage
// sources get persisted in the V1 usage pipeline.
type UsageSourceKind string

// UsageSourceKind values identify certified native usage artifact shapes.
const (
	UsageSourceClaudeMain     UsageSourceKind = "claude_main"
	UsageSourceClaudeSubagent UsageSourceKind = "claude_subagent"
	UsageSourceCodexRollout   UsageSourceKind = "codex_rollout"
)

// UsageBindingState tracks the root native-session binding lifecycle.
type UsageBindingState string

// UsageBindingState values describe root native-session binding lifecycle.
const (
	UsageBindingDiscovering UsageBindingState = "discovering"
	UsageBindingActive      UsageBindingState = "active"
	UsageBindingFinalizing  UsageBindingState = "finalizing"
	UsageBindingComplete    UsageBindingState = "complete"
	UsageBindingPartial     UsageBindingState = "partial"
)

// UsageSourceState tracks one physical JSONL artifact generation.
type UsageSourceState string

// UsageSourceState values describe one physical source artifact lifecycle.
const (
	UsageSourcePending  UsageSourceState = "pending"
	UsageSourceActive   UsageSourceState = "active"
	UsageSourceComplete UsageSourceState = "complete"
	UsageSourceError    UsageSourceState = "error"
)

// Usage error code constants are safe storage/display identifiers for
// transcript discovery and ingestion failures.
const (
	UsageErrorSourceDiscoveryPending      = "source_discovery_pending"
	UsageErrorArtifactPathRejected        = "artifact_path_rejected"
	UsageErrorArtifactMissing             = "artifact_missing"
	UsageErrorArtifactReplaced            = "artifact_replaced"
	UsageErrorSourceReadFailed            = "source_read_failed"
	UsageErrorRecordTooLarge              = "record_too_large"
	UsageErrorMalformedJSONL              = "malformed_jsonl"
	UsageErrorUnsupportedSourceFormat     = "unsupported_source_format"
	UsageErrorSourceEventConflict         = "source_event_conflict"
	UsageErrorNonMonotonicCumulativeUsage = "non_monotonic_cumulative_usage"
	UsageErrorInvalidParserState          = "invalid_parser_state"
	UsageErrorUnresolvedSpawnCall         = "unresolved_spawn_call"
	UsageErrorCodexSourceBudgetExceeded   = "codex_source_budget_exceeded"
)

// Usage ingestion sentinel errors report replay and cursor conflicts.
var (
	ErrUsageSourceOffsetConflict   = errors.New("usage source cursor offset conflict")
	ErrUsageSourceRevisionConflict = errors.New("usage source revision conflict")
	ErrUsageSourceEventConflict    = errors.New("usage source event conflict")
)

// UsageBindingRecord binds one AO session to one native root session/thread.
type UsageBindingRecord struct {
	ID             int64
	SessionID      SessionID
	Harness        AgentHarness
	NativeRootID   string
	InitialModelID string
	State          UsageBindingState
	LastErrorCode  string
	UpdatedAt      time.Time
}

// UsageSourceRecord tracks one physical JSONL artifact generation and its
// durable read cursor.
type UsageSourceRecord struct {
	ID              int64
	BindingID       int64
	Kind            UsageSourceKind
	NativeSessionID string
	SubagentID      string
	ArtifactPath    string
	FileIdentity    string
	Generation      int64
	ByteOffset      int64
	ParserStateJSON string
	State           UsageSourceState
	FailureCount    int64
	AnomalyCount    int64
	NextRetryAt     *time.Time
	LastErrorCode   string
	UpdatedAt       time.Time
}

// UsageSourceContext is the source row plus immutable binding/session facts the
// ingestor needs while normalizing parser output.
type UsageSourceContext struct {
	Source         UsageSourceRecord
	SessionID      SessionID
	NativeRootID   string
	InitialModelID string
	BindingState   UsageBindingState
}

// UsageProviderID identifies the provider vocabulary normalized into a usage
// event. Provider-specific counters remain separate from the canonical totals.
type UsageProviderID string

// Usage provider identifiers.
const (
	UsageProviderOpenAI    UsageProviderID = "openai"
	UsageProviderAnthropic UsageProviderID = "anthropic"
)

// UsageMetricProvenance describes how one canonical metric was obtained.
type UsageMetricProvenance string

// Usage metric provenance values.
const (
	UsageMetricReported    UsageMetricProvenance = "reported"
	UsageMetricDerived     UsageMetricProvenance = "derived"
	UsageMetricUnsupported UsageMetricProvenance = "unsupported"
	UsageMetricUnknown     UsageMetricProvenance = "unknown"
)

// UsageMetricProvenanceSet records provenance independently for each canonical
// metric so a known zero is distinguishable from unavailable data.
type UsageMetricProvenanceSet struct {
	InputTokens         UsageMetricProvenance
	CachedInputTokens   UsageMetricProvenance
	UncachedInputTokens UsageMetricProvenance
	OutputTokens        UsageMetricProvenance
}

// UsageTokenMetrics is the provider-neutral token vector stored on every usage
// event. Nil means unknown; a non-nil zero is a known zero.
type UsageTokenMetrics struct {
	InputTokens         *int64
	CachedInputTokens   *int64
	UncachedInputTokens *int64
	OutputTokens        *int64
	Provenance          UsageMetricProvenanceSet
}

// OpenAIUsageDetails retains provider counters that are not part of the shared
// four-metric vocabulary.
type OpenAIUsageDetails struct {
	ReasoningOutputTokens *int64
	CacheWriteInputTokens *int64
	ReportedTotalTokens   *int64
}

// AnthropicUsageDetails retains direct input and cache-creation counters. The
// TTL buckets can be nil when an older transcript did not report them.
type AnthropicUsageDetails struct {
	DirectUncachedInputTokens  *int64
	CacheCreationInputTokens   *int64
	CacheCreation5mInputTokens *int64
	CacheCreation1hInputTokens *int64
}

// UsageProviderDetails contains at most the detail block matching ProviderID.
type UsageProviderDetails struct {
	OpenAI    *OpenAIUsageDetails
	Anthropic *AnthropicUsageDetails
}

// ModelUsageEvent is one append-only normalized usage fact.
type ModelUsageEvent struct {
	ProviderID      UsageProviderID
	ModelID         string
	Tokens          UsageTokenMetrics
	ProviderDetails UsageProviderDetails
	CreatedAt       time.Time
	SourceEventKey  string
}

// UsageModelAggregate is the raw model-level aggregate read from storage before
// the service applies user-facing coverage rules.
type UsageModelAggregate struct {
	Harness         AgentHarness
	ModelID         string
	Tokens          UsageTokenMetrics
	ProviderDetails UsageProviderDetails
}

// CompactSessionUsage is the token-only dashboard read model.
type CompactSessionUsage struct {
	SessionID       SessionID
	ProcessedTokens *int64
	Incomplete      bool
}

// UsageMetricTotals is the aggregate metric block used by session, harness,
// and model summaries.
type UsageMetricTotals struct {
	InputTokens         *int64
	CachedInputTokens   *int64
	UncachedInputTokens *int64
	OutputTokens        *int64
	ProcessedTokens     *int64
	Provenance          UsageMetricProvenanceSet
	ProviderDetails     UsageProviderDetails
}

// ModelUsageSummary is a per-exact-model aggregate.
type ModelUsageSummary struct {
	ModelID string
	Totals  UsageMetricTotals
}

// HarnessUsageSummary groups model summaries by AO harness.
type HarnessUsageSummary struct {
	Harness AgentHarness
	Totals  UsageMetricTotals
	Models  []ModelUsageSummary
}

// SessionUsageSummary is the read model returned by the session usage service.
type SessionUsageSummary struct {
	SessionID  SessionID
	Incomplete bool
	Totals     UsageMetricTotals
	Harnesses  []HarnessUsageSummary
}

// SourceCursorState is the durable source state to commit after parsing a
// chunk. ApplyUsageChunk writes it atomically with the emitted events.
type SourceCursorState struct {
	ByteOffset      int64
	State           UsageSourceState
	ParserStateJSON string
	FailureCount    int64
	AnomalyCount    int64
	NextRetryAt     *time.Time
	LastErrorCode   string
	UpdatedAt       time.Time
}
