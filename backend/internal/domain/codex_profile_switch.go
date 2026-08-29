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
	// ErrCodexProfileSwitchIdempotencyConflict reports reuse of a key for a different request.
	ErrCodexProfileSwitchIdempotencyConflict = errors.New("codex profile switch idempotency conflict")
	// ErrCodexProfileSwitchInProgress reports a second active continuation for one source.
	ErrCodexProfileSwitchInProgress = errors.New("codex profile switch in progress")
	// ErrCodexProfileSwitchTransitionConflict reports a lost compare-and-swap boundary.
	ErrCodexProfileSwitchTransitionConflict = errors.New("codex profile switch transition conflict")
)

// CodexProfileSwitchID identifies one durable assisted profile continuation.
type CodexProfileSwitchID string

// CodexProfileSwitchRequestFingerprint binds an idempotency key to the exact
// user-visible request. Runtime observations are deliberately excluded.
type CodexProfileSwitchRequestFingerprint string

// ComputeCodexProfileSwitchRequestFingerprint returns the stable v1 request
// identity used by storage idempotency checks.
func ComputeCodexProfileSwitchRequestFingerprint(sessionID SessionID, targetProfileID string, acknowledgeUnknownCapacity bool) CodexProfileSwitchRequestFingerprint {
	payload, _ := json.Marshal(struct {
		SessionID                  SessionID `json:"sessionId"`
		TargetProfileID            string    `json:"targetProfileId"`
		AcknowledgeUnknownCapacity bool      `json:"acknowledgeUnknownCapacity"`
	}{sessionID, strings.TrimSpace(targetProfileID), acknowledgeUnknownCapacity})
	sum := sha256.Sum256(payload)
	return CodexProfileSwitchRequestFingerprint("v1:" + hex.EncodeToString(sum[:]))
}

// Valid reports whether the fingerprint uses the canonical v1 encoding.
func (f CodexProfileSwitchRequestFingerprint) Valid() bool {
	value := string(f)
	if len(value) != 3+sha256.Size*2 || !strings.HasPrefix(value, "v1:") {
		return false
	}
	digest := strings.TrimPrefix(value, "v1:")
	if digest != strings.ToLower(digest) {
		return false
	}
	decoded, err := hex.DecodeString(digest)
	return err == nil && len(decoded) == sha256.Size
}

// CodexProfileSwitchTrigger is the trusted durable reason for a switch.
type CodexProfileSwitchTrigger string

const (
	// CodexProfileSwitchTriggerManual records an explicit action without a capacity signal.
	CodexProfileSwitchTriggerManual CodexProfileSwitchTrigger = "manual"
	// CodexProfileSwitchTriggerNearLimit records a fresh near-limit source observation.
	CodexProfileSwitchTriggerNearLimit CodexProfileSwitchTrigger = "near_limit"
	// CodexProfileSwitchTriggerExhausted records a fresh exhausted source observation.
	CodexProfileSwitchTriggerExhausted CodexProfileSwitchTrigger = "exhausted"
	// CodexProfileSwitchTriggerUsageLimitFailure records a structured provider failure.
	CodexProfileSwitchTriggerUsageLimitFailure CodexProfileSwitchTrigger = "usage_limit_failure"
)

// Valid reports whether the trigger is persistable.
func (t CodexProfileSwitchTrigger) Valid() bool {
	switch t {
	case CodexProfileSwitchTriggerManual, CodexProfileSwitchTriggerNearLimit,
		CodexProfileSwitchTriggerExhausted, CodexProfileSwitchTriggerUsageLimitFailure:
		return true
	default:
		return false
	}
}

// CodexProfileSwitchPhase is the durable saga boundary.
type CodexProfileSwitchPhase string

const (
	// CodexProfileSwitchRequested is the durable admission boundary.
	CodexProfileSwitchRequested CodexProfileSwitchPhase = "requested"
	// CodexProfileSwitchWaitingForSafeBoundary waits for source work to settle.
	CodexProfileSwitchWaitingForSafeBoundary CodexProfileSwitchPhase = "waiting_for_safe_boundary"
	// CodexProfileSwitchPreparingHandoff builds and verifies continuation context.
	CodexProfileSwitchPreparingHandoff CodexProfileSwitchPhase = "preparing_handoff"
	// CodexProfileSwitchStoppingSource begins irreversible source shutdown.
	CodexProfileSwitchStoppingSource CodexProfileSwitchPhase = "stopping_source"
	// CodexProfileSwitchSourceStopped proves the source no longer owns the workspace.
	CodexProfileSwitchSourceStopped CodexProfileSwitchPhase = "source_stopped"
	// CodexProfileSwitchStartingTarget allocates and launches the related target.
	CodexProfileSwitchStartingTarget CodexProfileSwitchPhase = "starting_target"
	// CodexProfileSwitchTargetReady proves the target controller is live.
	CodexProfileSwitchTargetReady CodexProfileSwitchPhase = "target_ready"
	// CodexProfileSwitchDeliveringHandoff gates target input until acknowledgement.
	CodexProfileSwitchDeliveringHandoff CodexProfileSwitchPhase = "delivering_handoff"
	// CodexProfileSwitchRecoveryRequired retains exclusive ownership after ambiguity.
	CodexProfileSwitchRecoveryRequired CodexProfileSwitchPhase = "recovery_required"
	// CodexProfileSwitchCompleted archives the acknowledged predecessor.
	CodexProfileSwitchCompleted CodexProfileSwitchPhase = "completed"
	// CodexProfileSwitchCancelled is a safe pre-shutdown cancellation.
	CodexProfileSwitchCancelled CodexProfileSwitchPhase = "cancelled"
	// CodexProfileSwitchFailed is a terminal operation without continuation ownership.
	CodexProfileSwitchFailed CodexProfileSwitchPhase = "failed"
)

// Valid reports whether the phase is persistable.
func (p CodexProfileSwitchPhase) Valid() bool {
	switch p {
	case CodexProfileSwitchRequested, CodexProfileSwitchWaitingForSafeBoundary,
		CodexProfileSwitchPreparingHandoff, CodexProfileSwitchStoppingSource,
		CodexProfileSwitchSourceStopped, CodexProfileSwitchStartingTarget,
		CodexProfileSwitchTargetReady, CodexProfileSwitchDeliveringHandoff,
		CodexProfileSwitchRecoveryRequired, CodexProfileSwitchCompleted,
		CodexProfileSwitchCancelled, CodexProfileSwitchFailed:
		return true
	default:
		return false
	}
}

// Terminal reports whether the operation owns no future automatic progress.
func (p CodexProfileSwitchPhase) Terminal() bool {
	return p == CodexProfileSwitchCompleted || p == CodexProfileSwitchCancelled || p == CodexProfileSwitchFailed
}

// Cancellable reports whether source shutdown has not begun.
func (p CodexProfileSwitchPhase) Cancellable() bool {
	return p == CodexProfileSwitchRequested || p == CodexProfileSwitchWaitingForSafeBoundary || p == CodexProfileSwitchPreparingHandoff
}

// ValidCodexProfileSwitchTransition is the persistence state-machine contract.
func ValidCodexProfileSwitchTransition(from, to CodexProfileSwitchPhase) bool {
	if !from.Valid() || !to.Valid() || from.Terminal() {
		return false
	}
	if from == to {
		return true
	}
	if to == CodexProfileSwitchRecoveryRequired {
		return from != CodexProfileSwitchRequested && from != CodexProfileSwitchWaitingForSafeBoundary
	}
	if to == CodexProfileSwitchFailed {
		return true
	}
	if to == CodexProfileSwitchCancelled {
		return from.Cancellable()
	}
	switch from {
	case CodexProfileSwitchRequested:
		return to == CodexProfileSwitchWaitingForSafeBoundary || to == CodexProfileSwitchPreparingHandoff
	case CodexProfileSwitchWaitingForSafeBoundary:
		return to == CodexProfileSwitchPreparingHandoff
	case CodexProfileSwitchPreparingHandoff:
		return to == CodexProfileSwitchStoppingSource
	case CodexProfileSwitchStoppingSource:
		return to == CodexProfileSwitchSourceStopped
	case CodexProfileSwitchSourceStopped:
		return to == CodexProfileSwitchStartingTarget
	case CodexProfileSwitchStartingTarget:
		return to == CodexProfileSwitchTargetReady
	case CodexProfileSwitchTargetReady:
		return to == CodexProfileSwitchDeliveringHandoff
	case CodexProfileSwitchDeliveringHandoff:
		return to == CodexProfileSwitchCompleted
	case CodexProfileSwitchRecoveryRequired:
		return to == CodexProfileSwitchStoppingSource || to == CodexProfileSwitchSourceStopped ||
			to == CodexProfileSwitchStartingTarget || to == CodexProfileSwitchTargetReady ||
			to == CodexProfileSwitchDeliveringHandoff
	default:
		return false
	}
}

// CodexProfileSwitchWorkspaceOwner records the only actor permitted to mutate
// the shared workspace during a continuation.
type CodexProfileSwitchWorkspaceOwner string

const (
	// CodexProfileSwitchOwnerSource leaves workspace mutation with the predecessor.
	CodexProfileSwitchOwnerSource CodexProfileSwitchWorkspaceOwner = "source"
	// CodexProfileSwitchOwnerSwitch lets only the coordinator mutate during handoff.
	CodexProfileSwitchOwnerSwitch CodexProfileSwitchWorkspaceOwner = "switch"
	// CodexProfileSwitchOwnerTarget transfers mutation to the acknowledged continuation.
	CodexProfileSwitchOwnerTarget CodexProfileSwitchWorkspaceOwner = "target"
	// CodexProfileSwitchOwnerRecovery keeps both session input gates closed.
	CodexProfileSwitchOwnerRecovery CodexProfileSwitchWorkspaceOwner = "recovery"
)

// CodexProfileSwitchErrorCode is the stable safe recovery/failure category.
type CodexProfileSwitchErrorCode string

const (
	// CodexProfileSwitchErrorSourceStopUnconfirmed reports ambiguous predecessor shutdown.
	CodexProfileSwitchErrorSourceStopUnconfirmed CodexProfileSwitchErrorCode = "source_stop_unconfirmed"
	// CodexProfileSwitchErrorTargetStartUnconfirmed reports ambiguous target startup.
	CodexProfileSwitchErrorTargetStartUnconfirmed CodexProfileSwitchErrorCode = "target_start_unconfirmed"
	// CodexProfileSwitchErrorDeliveryUnconfirmed reports missing exact target acknowledgement.
	CodexProfileSwitchErrorDeliveryUnconfirmed CodexProfileSwitchErrorCode = "delivery_unconfirmed"
	// CodexProfileSwitchErrorWorkspaceRecoveryRequired reports ambiguous workspace ownership.
	CodexProfileSwitchErrorWorkspaceRecoveryRequired CodexProfileSwitchErrorCode = "workspace_recovery_required"
	// CodexProfileSwitchErrorTargetUsageLimited reports a structured target quota boundary.
	CodexProfileSwitchErrorTargetUsageLimited CodexProfileSwitchErrorCode = "target_usage_limited"
	// CodexProfileSwitchErrorTargetUnavailable reports a target that could not continue.
	CodexProfileSwitchErrorTargetUnavailable CodexProfileSwitchErrorCode = "target_unavailable"
	// CodexProfileSwitchErrorSourceRestoreUnconfirmed reports ambiguous predecessor restoration.
	CodexProfileSwitchErrorSourceRestoreUnconfirmed CodexProfileSwitchErrorCode = "source_restore_unconfirmed"
	// CodexProfileSwitchErrorRequestCancelled records an explicit safe cancellation.
	CodexProfileSwitchErrorRequestCancelled CodexProfileSwitchErrorCode = "request_cancelled"
	// CodexProfileSwitchErrorDaemonRestart records interrupted daemon-owned work.
	CodexProfileSwitchErrorDaemonRestart CodexProfileSwitchErrorCode = "daemon_restart"
	// CodexProfileSwitchErrorFailed is the generic safe terminal category.
	CodexProfileSwitchErrorFailed CodexProfileSwitchErrorCode = "switch_failed"
)

// CodexProfileSwitchHandoffClassification describes the bounded context source.
type CodexProfileSwitchHandoffClassification string

const (
	// CodexProfileSwitchHandoffPending means the immutable artifact is not finalized yet.
	CodexProfileSwitchHandoffPending CodexProfileSwitchHandoffClassification = "pending"
	// CodexProfileSwitchHandoffSemantic includes validated source-authored enrichment.
	CodexProfileSwitchHandoffSemantic CodexProfileSwitchHandoffClassification = "semantic"
	// CodexProfileSwitchHandoffFallback contains deterministic AO-owned context only.
	CodexProfileSwitchHandoffFallback CodexProfileSwitchHandoffClassification = "fallback"
)

// CodexProfileSwitch is one durable assisted continuation. Private process and
// artifact identity is never serialized.
type CodexProfileSwitch struct {
	ID                         CodexProfileSwitchID                    `json:"id"`
	SourceSessionID            SessionID                               `json:"sourceSessionId"`
	TargetSessionID            *SessionID                              `json:"targetSessionId,omitempty"`
	SourceProfileID            string                                  `json:"sourceProfileId"`
	TargetProfileID            string                                  `json:"targetProfileId"`
	IdempotencyKey             string                                  `json:"-"`
	RequestFingerprint         CodexProfileSwitchRequestFingerprint    `json:"-"`
	Trigger                    CodexProfileSwitchTrigger               `json:"trigger" enum:"manual,near_limit,exhausted,usage_limit_failure"`
	Phase                      CodexProfileSwitchPhase                 `json:"phase" enum:"requested,waiting_for_safe_boundary,preparing_handoff,stopping_source,source_stopped,starting_target,target_ready,delivering_handoff,recovery_required,completed,cancelled,failed"`
	RecoveryOriginPhase        *CodexProfileSwitchPhase                `json:"recoveryOriginPhase,omitempty"`
	WorkspaceOwner             CodexProfileSwitchWorkspaceOwner        `json:"-"`
	SourceGenerationID         AgentGenerationID                       `json:"-"`
	TargetGenerationID         AgentGenerationID                       `json:"-"`
	TargetRuntimeHandleID      string                                  `json:"-"`
	TargetControllerGeneration string                                  `json:"-"`
	TargetProviderThreadID     string                                  `json:"-"`
	SemanticHandoffStatus      AgentHandoffStatus                      `json:"-"`
	HandoffClassification      CodexProfileSwitchHandoffClassification `json:"handoffClassification" enum:"pending,semantic,fallback"`
	FinalHandoffPath           string                                  `json:"-"`
	FinalHandoffHash           string                                  `json:"-"`
	AcknowledgeUnknownCapacity bool                                    `json:"acknowledgeUnknownCapacity"`
	TargetAcknowledgedAt       *time.Time                              `json:"targetAcknowledgedAt,omitempty"`
	SourceArchivedAt           *time.Time                              `json:"sourceArchivedAt,omitempty"`
	RequestedAt                time.Time                               `json:"requestedAt"`
	UpdatedAt                  time.Time                               `json:"updatedAt"`
	CompletedAt                *time.Time                              `json:"completedAt,omitempty"`
	ErrorCode                  CodexProfileSwitchErrorCode             `json:"errorCode,omitempty"`
	SourceProfile              *CodexSessionProfileSummary             `json:"sourceProfile,omitempty"`
	TargetProfile              *CodexSessionProfileSummary             `json:"targetProfile,omitempty"`
	ProgressReason             string                                  `json:"progressReason"`
	CanCancel                  bool                                    `json:"canCancel"`
	CanRecover                 bool                                    `json:"canRecover"`
	CanRestoreSource           bool                                    `json:"canRestoreSource"`
}

// CodexProfileSwitchCandidate is a display-safe target option.
type CodexProfileSwitchCandidate struct {
	ID                              string                         `json:"id"`
	Label                           string                         `json:"label"`
	Source                          CodexProfileSource             `json:"source" enum:"existing,managed"`
	Authentication                  AgentAuthenticationObservation `json:"authentication"`
	Capacity                        CodexCapacitySnapshot          `json:"capacity"`
	Recommended                     bool                           `json:"recommended"`
	Selectable                      bool                           `json:"selectable"`
	RequiresCapacityAcknowledgement bool                           `json:"requiresCapacityAcknowledgement"`
	ReasonCode                      string                         `json:"reasonCode"`
	Reason                          string                         `json:"reason"`
}

// CodexProfileSwitchOptions is the cached/ensured assisted-switch surface.
type CodexProfileSwitchOptions struct {
	SourceProfile        CodexSessionProfileSummary    `json:"sourceProfile"`
	RecommendedProfileID *string                       `json:"recommendedProfileId,omitempty"`
	Candidates           []CodexProfileSwitchCandidate `json:"candidates"`
}

// CodexProfileSwitchVerification is the strict internal target proof used
// immediately before source shutdown.
type CodexProfileSwitchVerification struct {
	LaunchContext CodexLaunchContext
	Profile       CodexProfileSnapshot
}

// CodexSessionContinuationSummary is a safe predecessor/target relation.
type CodexSessionContinuationSummary struct {
	SessionID SessionID                  `json:"sessionId"`
	Label     string                     `json:"label"`
	Profile   CodexSessionProfileSummary `json:"profile"`
}

// Candidate reason codes are stable and safe for every client.
const (
	// CodexProfileSwitchReasonRecommendedAvailable marks the best available target.
	CodexProfileSwitchReasonRecommendedAvailable = "profile_switch_recommended_available"
	// CodexProfileSwitchReasonRecommendedNearLimit marks the best fallback near-limit target.
	CodexProfileSwitchReasonRecommendedNearLimit = "profile_switch_recommended_near_limit"
	// CodexProfileSwitchReasonSelectableAvailable marks another eligible available target.
	CodexProfileSwitchReasonSelectableAvailable = "profile_switch_selectable_available"
	// CodexProfileSwitchReasonSelectableNearLimit marks another eligible near-limit target.
	CodexProfileSwitchReasonSelectableNearLimit = "profile_switch_selectable_near_limit"
	// CodexProfileSwitchReasonCapacityAckRequired requires explicit uncertainty acknowledgement.
	CodexProfileSwitchReasonCapacityAckRequired = "profile_switch_capacity_ack_required"
	// CodexProfileSwitchReasonSourceProfile identifies the immutable current binding.
	CodexProfileSwitchReasonSourceProfile = "profile_switch_source_profile"
	// CodexProfileSwitchReasonProfileUnavailable marks a broken or missing target.
	CodexProfileSwitchReasonProfileUnavailable = "profile_switch_profile_unavailable"
	// CodexProfileSwitchReasonAuthenticationRequired marks a fresh signed-out target.
	CodexProfileSwitchReasonAuthenticationRequired = "profile_switch_authentication_required"
	// CodexProfileSwitchReasonAuthenticationUnverified marks non-fresh authentication.
	CodexProfileSwitchReasonAuthenticationUnverified = "profile_switch_authentication_unverified"
	// CodexProfileSwitchReasonCapacityExhausted marks a non-selectable exhausted target.
	CodexProfileSwitchReasonCapacityExhausted = "profile_switch_capacity_exhausted"
	// CodexProfileSwitchReasonCapacityChecking marks a target with an active capacity read.
	CodexProfileSwitchReasonCapacityChecking = "profile_switch_capacity_checking"
	// CodexProfileSwitchReasonNoCandidate reports an empty eligible candidate set.
	CodexProfileSwitchReasonNoCandidate = "profile_switch_no_candidate"
)
