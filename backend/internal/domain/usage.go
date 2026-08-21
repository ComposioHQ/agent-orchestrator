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
	ProviderHint   string
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
	ProviderHint   string
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

// UsageEventCosts is the durable nano-USD estimate stored on one event. Every
// field is nil until the event has been priced; a non-nil total is immutable.
type UsageEventCosts struct {
	UncachedInputCostNanos *int64
	CacheReadCostNanos     *int64
	CacheWriteCostNanos    *int64
	OutputCostNanos        *int64
	EstimatedCostNanos     *int64
	PricingVersion         string
}

// ModelUsageEvent is one append-only normalized usage fact.
//
// ProviderID is the provider *vocabulary* the counters were normalized into and
// selects which ProviderDetails block applies. BillingProviderID is the exact
// catalog provider the event is priced against and is empty until attribution
// proves it; the two differ whenever an Anthropic-vocabulary transcript is
// served by another billing provider such as z.ai.
type ModelUsageEvent struct {
	ProviderID        UsageProviderID
	BillingProviderID string
	ModelID           string
	Tokens            UsageTokenMetrics
	ProviderDetails   UsageProviderDetails
	Costs             UsageEventCosts
	CreatedAt         time.Time
	SourceEventKey    string
}

// UsageCostCandidate is one still-total-null event selected for an exact
// provider catalog attempt. Source facts remain immutable and are carried back
// to storage as compare-and-swap guards.
type UsageCostCandidate struct {
	ID                int64
	BindingID         int64
	ProviderID        UsageProviderID
	BillingProviderID string
	ModelID           string
	Tokens            UsageTokenMetrics
	ProviderDetails   UsageProviderDetails
	PricingVersion    string
	SourceEventKey    string
}

// UsageCostUpdate carries one candidate's immutable compare-and-swap facts and
// the result of attempting it against a newer provider catalog version.
type UsageCostUpdate struct {
	Candidate UsageCostCandidate
	Costs     UsageEventCosts
}

// LegacyUsageEvent is one billing-provider-null event selected for transcript
// attribution repair. Its source and generic facts are immutable CAS guards.
type LegacyUsageEvent struct {
	ID              int64
	BindingID       int64
	UsageSourceID   int64
	ProviderID      UsageProviderID
	ModelID         string
	Tokens          UsageTokenMetrics
	ProviderDetails UsageProviderDetails
	PricingVersion  string
	SourceEventKey  string
}

// LegacyUsageRepair carries transcript-derived attribution and the estimate
// made from the same fenced pricing snapshot.
type LegacyUsageRepair struct {
	Candidate               LegacyUsageEvent
	ExpectedFileIdentity    string
	ExpectedByteOffset      int64
	ExpectedParserStateJSON string
	ExpectedSourceUpdatedAt time.Time
	BillingProviderID       string
	Costs                   UsageEventCosts
}

// EstimatedCostCoverage describes how much of a usage scope has a durable
// estimate. Token collection integrity is reported separately.
type EstimatedCostCoverage string

const (
	// EstimatedCostCoverageComplete means every event in the scope has a stored total.
	EstimatedCostCoverageComplete EstimatedCostCoverage = "complete"
	// EstimatedCostCoveragePartial means the scope has a positive known lower bound.
	EstimatedCostCoveragePartial EstimatedCostCoverage = "partial"
)

// EstimatedCost is the user-facing nano-USD estimate for one usage scope.
// Components remain nullable when only part of that component is known.
type EstimatedCost struct {
	TotalNanos         int64
	UncachedInputNanos *int64
	CacheReadNanos     *int64
	CacheWriteNanos    *int64
	OutputNanos        *int64
	Coverage           EstimatedCostCoverage
}

// UsageCostAggregate contains the independent SQL sums and coverage counts
// needed to derive a scope estimate without double-counting priced events.
type UsageCostAggregate struct {
	EventCount       int64
	PricedEventCount int64
	PricedTotalNanos int64

	KnownUncachedInputCount         int64
	KnownUncachedInputNanos         int64
	UnpricedKnownUncachedInputNanos int64
	KnownCacheReadCount             int64
	KnownCacheReadNanos             int64
	UnpricedKnownCacheReadNanos     int64
	KnownCacheWriteCount            int64
	KnownCacheWriteNanos            int64
	UnpricedKnownCacheWriteNanos    int64
	KnownOutputCount                int64
	KnownOutputNanos                int64
	UnpricedKnownOutputNanos        int64
}

// UsageModelAggregate is the raw model-level aggregate read from storage before
// the service applies user-facing coverage rules.
type UsageModelAggregate struct {
	Harness           AgentHarness
	BillingProviderID string
	ModelID           string
	Tokens            UsageTokenMetrics
	ProviderDetails   UsageProviderDetails
	Cost              UsageCostAggregate
}

// CompactSessionUsageAggregate is one batched storage row before checked token
// and cost derivation.
type CompactSessionUsageAggregate struct {
	SessionID       SessionID
	ProcessedTokens *int64
	Incomplete      bool
	Cost            UsageCostAggregate
}

// CompactSessionUsage is the dashboard usage read model.
type CompactSessionUsage struct {
	SessionID       SessionID
	ProcessedTokens *int64
	Incomplete      bool
	EstimatedCost   *EstimatedCost
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
	EstimatedCost       *EstimatedCost
}

// ModelUsageSummary is a per-exact-provider-and-model aggregate.
type ModelUsageSummary struct {
	BillingProviderID string
	ModelID           string
	Totals            UsageMetricTotals
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
