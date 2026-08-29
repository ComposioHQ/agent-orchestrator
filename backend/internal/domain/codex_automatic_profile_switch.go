package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

var (
	// ErrCodexAutomaticProfileSwitchPolicyRevisionConflict reports a lost policy compare-and-swap.
	ErrCodexAutomaticProfileSwitchPolicyRevisionConflict = errors.New("codex automatic profile switch policy revision conflict")
	// ErrCodexAutomaticProfileSwitchAttemptConflict reports a lost attempt transition or duplicate admission.
	ErrCodexAutomaticProfileSwitchAttemptConflict = errors.New("codex automatic profile switch attempt conflict")
)

// CodexAutomaticProfileSwitchTrigger is the trusted exhaustion source that
// opened one automatic evaluation. Generic provider failures never map here.
type CodexAutomaticProfileSwitchTrigger string

const (
	// CodexAutomaticProfileSwitchUsageLimitFailure is a structured failed-turn signal.
	CodexAutomaticProfileSwitchUsageLimitFailure CodexAutomaticProfileSwitchTrigger = "usage_limit_failure"
	// CodexAutomaticProfileSwitchCapacityEvent is a freshly exhausted bound capacity event.
	CodexAutomaticProfileSwitchCapacityEvent CodexAutomaticProfileSwitchTrigger = "capacity_event"
	// CodexAutomaticProfileSwitchCapacityRead is a freshly exhausted direct read at a TUI boundary.
	CodexAutomaticProfileSwitchCapacityRead CodexAutomaticProfileSwitchTrigger = "capacity_read"
)

// Valid reports whether the trigger may be persisted.
func (t CodexAutomaticProfileSwitchTrigger) Valid() bool {
	switch t {
	case CodexAutomaticProfileSwitchUsageLimitFailure, CodexAutomaticProfileSwitchCapacityEvent, CodexAutomaticProfileSwitchCapacityRead:
		return true
	default:
		return false
	}
}

// CodexAutomaticProfileSwitchState is the durable Phase 6 decision state.
// Once delegated, Phase 5 remains the only execution and recovery authority.
type CodexAutomaticProfileSwitchState string

const (
	// CodexAutomaticProfileSwitchEvaluating performs ordered strict checks.
	CodexAutomaticProfileSwitchEvaluating CodexAutomaticProfileSwitchState = "evaluating"
	// CodexAutomaticProfileSwitchNoCandidate leaves the source unchanged when no approved target qualifies.
	CodexAutomaticProfileSwitchNoCandidate CodexAutomaticProfileSwitchState = "no_candidate"
	// CodexAutomaticProfileSwitchDelegatedToPhase5 transfers execution ownership to Phase 5.
	CodexAutomaticProfileSwitchDelegatedToPhase5 CodexAutomaticProfileSwitchState = "delegated_to_phase5"
	// CodexAutomaticProfileSwitchCompleted records a successful continuation.
	CodexAutomaticProfileSwitchCompleted CodexAutomaticProfileSwitchState = "completed"
	// CodexAutomaticProfileSwitchNeedsAttention exposes the linked Phase 5 recovery flow.
	CodexAutomaticProfileSwitchNeedsAttention CodexAutomaticProfileSwitchState = "needs_attention"
	// CodexAutomaticProfileSwitchCancelled records a safely cancelled evaluation.
	CodexAutomaticProfileSwitchCancelled CodexAutomaticProfileSwitchState = "cancelled"
)

// Valid reports whether the state may be persisted.
func (s CodexAutomaticProfileSwitchState) Valid() bool {
	switch s {
	case CodexAutomaticProfileSwitchEvaluating, CodexAutomaticProfileSwitchNoCandidate,
		CodexAutomaticProfileSwitchDelegatedToPhase5, CodexAutomaticProfileSwitchCompleted,
		CodexAutomaticProfileSwitchNeedsAttention, CodexAutomaticProfileSwitchCancelled:
		return true
	default:
		return false
	}
}

// Terminal reports whether the automatic coordinator owns no future work.
func (s CodexAutomaticProfileSwitchState) Terminal() bool {
	return s == CodexAutomaticProfileSwitchNoCandidate || s == CodexAutomaticProfileSwitchCompleted ||
		s == CodexAutomaticProfileSwitchNeedsAttention || s == CodexAutomaticProfileSwitchCancelled
}

// ValidCodexAutomaticProfileSwitchTransition enforces the durable attempt state machine.
func ValidCodexAutomaticProfileSwitchTransition(from, to CodexAutomaticProfileSwitchState) bool {
	if !from.Valid() || !to.Valid() || from == CodexAutomaticProfileSwitchCompleted || from == CodexAutomaticProfileSwitchNoCandidate || from == CodexAutomaticProfileSwitchCancelled {
		return false
	}
	if from == to {
		return true
	}
	switch from {
	case CodexAutomaticProfileSwitchEvaluating:
		return to == CodexAutomaticProfileSwitchNoCandidate || to == CodexAutomaticProfileSwitchDelegatedToPhase5 || to == CodexAutomaticProfileSwitchCancelled
	case CodexAutomaticProfileSwitchDelegatedToPhase5:
		return to == CodexAutomaticProfileSwitchCompleted || to == CodexAutomaticProfileSwitchNeedsAttention || to == CodexAutomaticProfileSwitchCancelled
	case CodexAutomaticProfileSwitchNeedsAttention:
		return to == CodexAutomaticProfileSwitchCompleted
	default:
		return false
	}
}

// CodexAutomaticProfileSwitchOutcomeCode is a display-safe terminal or
// progress explanation. It deliberately carries no provider measurements.
type CodexAutomaticProfileSwitchOutcomeCode string

const (
	// CodexAutomaticSwitchOutcomeEvaluating explains active candidate evaluation.
	CodexAutomaticSwitchOutcomeEvaluating CodexAutomaticProfileSwitchOutcomeCode = "automatic_switch_evaluating"
	// CodexAutomaticSwitchOutcomePolicyDisabled reports that opt-in is no longer active.
	CodexAutomaticSwitchOutcomePolicyDisabled CodexAutomaticProfileSwitchOutcomeCode = "automatic_switch_policy_disabled"
	// CodexAutomaticSwitchOutcomePolicyChanged reports that evaluation restarted on a new revision.
	CodexAutomaticSwitchOutcomePolicyChanged CodexAutomaticProfileSwitchOutcomeCode = "automatic_switch_policy_changed"
	// CodexAutomaticSwitchOutcomeSourceAvailable reports that exhaustion is no longer confirmed.
	CodexAutomaticSwitchOutcomeSourceAvailable CodexAutomaticProfileSwitchOutcomeCode = "automatic_switch_source_available"
	// CodexAutomaticSwitchOutcomeSourceUnverified reports inconclusive source exhaustion.
	CodexAutomaticSwitchOutcomeSourceUnverified CodexAutomaticProfileSwitchOutcomeCode = "automatic_switch_source_unverified"
	// CodexAutomaticSwitchOutcomeSourceNotCurrent reports that the source is no longer the active continuation.
	CodexAutomaticSwitchOutcomeSourceNotCurrent CodexAutomaticProfileSwitchOutcomeCode = "automatic_switch_source_not_current"
	// CodexAutomaticSwitchOutcomeNoCandidate reports that every approved target was skipped.
	CodexAutomaticSwitchOutcomeNoCandidate CodexAutomaticProfileSwitchOutcomeCode = "automatic_switch_no_candidate"
	// CodexAutomaticSwitchOutcomeCancelled reports a safe pre-shutdown cancellation.
	CodexAutomaticSwitchOutcomeCancelled CodexAutomaticProfileSwitchOutcomeCode = "automatic_switch_cancelled"
	// CodexAutomaticSwitchOutcomeDelegated reports that Phase 5 owns the continuation.
	CodexAutomaticSwitchOutcomeDelegated CodexAutomaticProfileSwitchOutcomeCode = "automatic_switch_delegated"
	// CodexAutomaticSwitchOutcomeCompleted reports successful Phase 5 completion.
	CodexAutomaticSwitchOutcomeCompleted CodexAutomaticProfileSwitchOutcomeCode = "automatic_switch_completed"
	// CodexAutomaticSwitchOutcomeNeedsAttention reports linked Phase 5 recovery is required.
	CodexAutomaticSwitchOutcomeNeedsAttention CodexAutomaticProfileSwitchOutcomeCode = "automatic_switch_needs_attention"
)

// CodexExhaustionEvidence contains only the exact, bound identity required to
// coalesce one exhaustion episode. Raw provider payloads never enter it.
type CodexExhaustionEvidence struct {
	SessionID  SessionID
	ProfileID  string
	Generation AgentGenerationID
	EpisodeID  string
	Trigger    CodexAutomaticProfileSwitchTrigger
	ObservedAt time.Time
	Fresh      bool
}

// CodexAutomaticProfileSwitchFingerprint returns the stable identity shared by
// all structured signals attributed to one source generation and episode.
func CodexAutomaticProfileSwitchFingerprint(e CodexExhaustionEvidence) string {
	payload, _ := json.Marshal(struct {
		SessionID  SessionID         `json:"sessionId"`
		ProfileID  string            `json:"profileId"`
		Generation AgentGenerationID `json:"generation"`
		EpisodeID  string            `json:"episodeId"`
	}{e.SessionID, strings.TrimSpace(e.ProfileID), e.Generation, strings.TrimSpace(e.EpisodeID)})
	sum := sha256.Sum256(payload)
	return "v1:" + hex.EncodeToString(sum[:])
}

// CodexAutomaticProfileSwitchPolicyEntry is one configured fallback rendered
// from cached catalog/readiness data. Strict automatic eligibility is always
// re-proved before selection.
type CodexAutomaticProfileSwitchPolicyEntry struct {
	ID             string                          `json:"id"`
	Label          string                          `json:"label"`
	Source         *CodexProfileSource             `json:"source,omitempty"`
	Availability   CodexProfileAvailability        `json:"availability" enum:"available,unavailable,unknown"`
	Authentication *AgentAuthenticationObservation `json:"authentication,omitempty"`
	Capacity       *CodexCapacitySummary           `json:"capacity,omitempty"`
	Current        bool                            `json:"current"`
	ReasonCode     string                          `json:"reasonCode"`
	Reason         string                          `json:"reason"`
}

// CodexAutomaticProfileSwitchPolicy is explicit authorization scoped to one
// profile-continuation chain. ProfileIDs is internal storage input only.
type CodexAutomaticProfileSwitchPolicy struct {
	ChainRootSessionID SessionID                                `json:"chainRootSessionId"`
	Enabled            bool                                     `json:"enabled"`
	Revision           int64                                    `json:"revision"`
	CurrentProfile     CodexSessionProfileSummary               `json:"currentProfile"`
	Profiles           []CodexAutomaticProfileSwitchPolicyEntry `json:"profiles"`
	ProfileIDs         []string                                 `json:"-"`
	CreatedAt          *time.Time                               `json:"createdAt,omitempty"`
	UpdatedAt          *time.Time                               `json:"updatedAt,omitempty"`
}

// CodexAutomaticProfileSwitchAttemptCandidate records one safe ordered
// decision. It never records provider state or filesystem identity.
type CodexAutomaticProfileSwitchAttemptCandidate struct {
	ProfileID   string    `json:"profileId"`
	Label       string    `json:"label"`
	Position    int64     `json:"position"`
	ReasonCode  string    `json:"reasonCode"`
	Reason      string    `json:"reason"`
	EvaluatedAt time.Time `json:"evaluatedAt"`
}

// CodexAutomaticProfileSwitchAttempt is one durable Phase 6 decision. Private
// evidence and idempotency fields are never serialized.
type CodexAutomaticProfileSwitchAttempt struct {
	ID                      string                                        `json:"id"`
	ChainRootSessionID      SessionID                                     `json:"-"`
	SourceSessionID         SessionID                                     `json:"sourceSessionId"`
	SourceProfileID         string                                        `json:"sourceProfileId"`
	SourceGenerationID      AgentGenerationID                             `json:"-"`
	SourceEpisodeID         string                                        `json:"-"`
	Trigger                 CodexAutomaticProfileSwitchTrigger            `json:"trigger" enum:"usage_limit_failure,capacity_event,capacity_read"`
	ExhaustionFingerprint   string                                        `json:"-"`
	PolicyRevision          int64                                         `json:"policyRevision"`
	SelectedProfileID       *string                                       `json:"selectedProfileId,omitempty"`
	SelectedProfilePosition *int64                                        `json:"selectedProfilePosition,omitempty"`
	ProfileSwitchID         *CodexProfileSwitchID                         `json:"-"`
	State                   CodexAutomaticProfileSwitchState              `json:"state" enum:"evaluating,no_candidate,delegated_to_phase5,completed,needs_attention,cancelled"`
	OutcomeCode             CodexAutomaticProfileSwitchOutcomeCode        `json:"outcomeCode"`
	Candidates              []CodexAutomaticProfileSwitchAttemptCandidate `json:"candidates"`
	SourceProfile           *CodexSessionProfileSummary                   `json:"sourceProfile,omitempty"`
	TargetProfile           *CodexSessionProfileSummary                   `json:"targetProfile,omitempty"`
	ProfileSwitch           *CodexProfileSwitch                           `json:"profileSwitch,omitempty"`
	Reason                  string                                        `json:"reason"`
	CanCancel               bool                                          `json:"canCancel"`
	CreatedAt               time.Time                                     `json:"createdAt"`
	UpdatedAt               time.Time                                     `json:"updatedAt"`
	CompletedAt             *time.Time                                    `json:"completedAt,omitempty"`
}

// Stable display-safe policy/candidate decisions.
const (
	CodexAutomaticReasonCurrentProfile           = "automatic_profile_switch_current_profile"
	CodexAutomaticReasonProfileAvailable         = "automatic_profile_switch_profile_available"
	CodexAutomaticReasonProfileMissing           = "automatic_profile_switch_profile_missing"
	CodexAutomaticReasonProfileUnavailable       = "automatic_profile_switch_profile_unavailable"
	CodexAutomaticReasonAuthenticationRequired   = "automatic_profile_switch_authentication_required"
	CodexAutomaticReasonAuthenticationUnverified = "automatic_profile_switch_authentication_unverified"
	CodexAutomaticReasonCapacityNearLimit        = "automatic_profile_switch_capacity_near_limit"
	CodexAutomaticReasonCapacityExhausted        = "automatic_profile_switch_capacity_exhausted"
	CodexAutomaticReasonCapacityUnknown          = "automatic_profile_switch_capacity_unknown"
	CodexAutomaticReasonCapacityUnsupported      = "automatic_profile_switch_capacity_unsupported"
	CodexAutomaticReasonCapacityCheckFailed      = "automatic_profile_switch_capacity_check_failed"
	CodexAutomaticReasonSelected                 = "automatic_profile_switch_selected"
	CodexAutomaticReasonNoCandidate              = "automatic_profile_switch_no_candidate"
)
