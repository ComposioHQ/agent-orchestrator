package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// AgentSwitchFailureProductionEnabled is intentionally false until the
// rollout's consent, privacy, and provider-configuration gates are complete.
const AgentSwitchFailureProductionEnabled = false

const (
	AgentSwitchCanonicalEventMaxBytes = 60 << 10
	AgentSwitchEnvelopeEncodingV1     = 1
	agentSwitchStackMaxBytes          = 16 << 10
)

// AgentSwitchReportKind is the stable remote incident class.
type AgentSwitchReportKind string

const (
	AgentSwitchReportTerminalFailure        AgentSwitchReportKind = "terminal_failure"
	AgentSwitchReportRecoveryRequired       AgentSwitchReportKind = "recovery_required"
	AgentSwitchReportPanic                  AgentSwitchReportKind = "panic"
	AgentSwitchReportRecoveryAttemptFailed  AgentSwitchReportKind = "recovery_attempt_failed"
	AgentSwitchReportMaintenanceFailure     AgentSwitchReportKind = "maintenance_failure"
	AgentSwitchReportDaemonLifecycleFailure AgentSwitchReportKind = "daemon_lifecycle_failure"
	AgentSwitchReportVisibilityFailure      AgentSwitchReportKind = "visibility_failure"
	AgentSwitchReportNotApplicable          AgentSwitchReportKind = "not_applicable"
)

func (k AgentSwitchReportKind) valid() bool {
	switch k {
	case AgentSwitchReportTerminalFailure, AgentSwitchReportRecoveryRequired,
		AgentSwitchReportPanic, AgentSwitchReportRecoveryAttemptFailed,
		AgentSwitchReportMaintenanceFailure, AgentSwitchReportDaemonLifecycleFailure,
		AgentSwitchReportVisibilityFailure, AgentSwitchReportNotApplicable:
		return true
	default:
		return false
	}
}

// AgentSwitchFaultCode classifies operational incidents which are not a new
// durable switch error.
type AgentSwitchFaultCode string

const (
	AgentSwitchFaultNotApplicable           AgentSwitchFaultCode = "not_applicable"
	AgentSwitchFaultWorkerPanic             AgentSwitchFaultCode = "worker_panic"
	AgentSwitchFaultRecoveryUnresolved      AgentSwitchFaultCode = "recovery_unresolved"
	AgentSwitchFaultTerminalCleanupFailed   AgentSwitchFaultCode = "terminal_cleanup_failed"
	AgentSwitchFaultShutdownWorkersTimedOut AgentSwitchFaultCode = "shutdown_workers_timed_out"
)

func (c AgentSwitchFaultCode) valid() bool {
	switch c {
	case AgentSwitchFaultNotApplicable, AgentSwitchFaultWorkerPanic,
		AgentSwitchFaultRecoveryUnresolved, AgentSwitchFaultTerminalCleanupFailed,
		AgentSwitchFaultShutdownWorkersTimedOut:
		return true
	default:
		return false
	}
}

// AgentSwitchErrorNotApplicable is used only in the observability boundary.
// Persisted switch rows continue to use the existing domain error vocabulary.
const AgentSwitchErrorNotApplicable AgentSwitchErrorCode = "not_applicable"

// Explicit not-applicable values keep daemon and visibility events free from
// ambiguous empty fields.
const (
	AgentSwitchStateNotApplicable         AgentSwitchState           = "not_applicable"
	AgentSwitchTargetStartReportedPending AgentSwitchTargetStartMode = "pending"
	AgentSwitchTargetStartNotApplicable   AgentSwitchTargetStartMode = "not_applicable"
	SessionModeNotApplicable              SessionMode                = "not_applicable"
	HarnessNotApplicable                  AgentHarness               = "not_applicable"
)

// AgentSwitchCallOutcome is the side-effect-aware result of one boundary.
type AgentSwitchCallOutcome string

const (
	AgentSwitchCallOK                    AgentSwitchCallOutcome = "ok"
	AgentSwitchCallExpectedRejection     AgentSwitchCallOutcome = "expected_rejection"
	AgentSwitchCallNoEffectFailure       AgentSwitchCallOutcome = "no_effect_failure"
	AgentSwitchCallCommittedResponseLost AgentSwitchCallOutcome = "committed_response_lost"
	AgentSwitchCallEffectUnknown         AgentSwitchCallOutcome = "effect_unknown"
	AgentSwitchCallStale                 AgentSwitchCallOutcome = "stale"
	AgentSwitchCallTimedOut              AgentSwitchCallOutcome = "timed_out"
	AgentSwitchCallCancelled             AgentSwitchCallOutcome = "cancelled"
	AgentSwitchCallPanic                 AgentSwitchCallOutcome = "panic"
	AgentSwitchCallCleanupFailed         AgentSwitchCallOutcome = "cleanup_failed"
)

func (o AgentSwitchCallOutcome) valid() bool {
	switch o {
	case AgentSwitchCallOK, AgentSwitchCallExpectedRejection,
		AgentSwitchCallNoEffectFailure, AgentSwitchCallCommittedResponseLost,
		AgentSwitchCallEffectUnknown, AgentSwitchCallStale, AgentSwitchCallTimedOut,
		AgentSwitchCallCancelled, AgentSwitchCallPanic, AgentSwitchCallCleanupFailed:
		return true
	default:
		return false
	}
}

type AgentSwitchOwnership string

const (
	AgentSwitchOwnershipSource        AgentSwitchOwnership = "source"
	AgentSwitchOwnershipNone          AgentSwitchOwnership = "none"
	AgentSwitchOwnershipTarget        AgentSwitchOwnership = "target"
	AgentSwitchOwnershipAmbiguous     AgentSwitchOwnership = "ambiguous"
	AgentSwitchOwnershipNotApplicable AgentSwitchOwnership = "not_applicable"
)

func (o AgentSwitchOwnership) valid() bool {
	switch o {
	case AgentSwitchOwnershipSource, AgentSwitchOwnershipNone,
		AgentSwitchOwnershipTarget, AgentSwitchOwnershipAmbiguous,
		AgentSwitchOwnershipNotApplicable:
		return true
	default:
		return false
	}
}

type AgentSwitchCompensation string

const (
	AgentSwitchCompensationNotNeeded     AgentSwitchCompensation = "not_needed"
	AgentSwitchCompensationSucceeded     AgentSwitchCompensation = "succeeded"
	AgentSwitchCompensationFailed        AgentSwitchCompensation = "failed"
	AgentSwitchCompensationUncertain     AgentSwitchCompensation = "uncertain"
	AgentSwitchCompensationNotApplicable AgentSwitchCompensation = "not_applicable"
)

func (c AgentSwitchCompensation) valid() bool {
	switch c {
	case AgentSwitchCompensationNotNeeded, AgentSwitchCompensationSucceeded,
		AgentSwitchCompensationFailed, AgentSwitchCompensationUncertain,
		AgentSwitchCompensationNotApplicable:
		return true
	default:
		return false
	}
}

type AgentSwitchExecution string

const (
	AgentSwitchExecutionLive             AgentSwitchExecution = "live"
	AgentSwitchExecutionStartupReconcile AgentSwitchExecution = "startup_reconcile"
	AgentSwitchExecutionExplicitRecovery AgentSwitchExecution = "explicit_recovery"
	AgentSwitchExecutionDaemonShutdown   AgentSwitchExecution = "daemon_shutdown"
)

func (e AgentSwitchExecution) valid() bool {
	switch e {
	case AgentSwitchExecutionLive, AgentSwitchExecutionStartupReconcile,
		AgentSwitchExecutionExplicitRecovery, AgentSwitchExecutionDaemonShutdown:
		return true
	default:
		return false
	}
}

type AgentSwitchUserImpact string

const (
	AgentSwitchUserImpactSourceAvailable    AgentSwitchUserImpact = "source_available"
	AgentSwitchUserImpactNoLiveOwner        AgentSwitchUserImpact = "no_live_owner"
	AgentSwitchUserImpactTargetUnavailable  AgentSwitchUserImpact = "target_unavailable"
	AgentSwitchUserImpactDeliveryUnknown    AgentSwitchUserImpact = "delivery_unknown"
	AgentSwitchUserImpactOwnershipAmbiguous AgentSwitchUserImpact = "ownership_ambiguous"
	AgentSwitchUserImpactGateRetained       AgentSwitchUserImpact = "gate_retained"
	AgentSwitchUserImpactVisibilityImpaired AgentSwitchUserImpact = "visibility_impaired"
	AgentSwitchUserImpactNotApplicable      AgentSwitchUserImpact = "not_applicable"
)

func (i AgentSwitchUserImpact) valid() bool {
	switch i {
	case AgentSwitchUserImpactSourceAvailable, AgentSwitchUserImpactNoLiveOwner,
		AgentSwitchUserImpactTargetUnavailable, AgentSwitchUserImpactDeliveryUnknown,
		AgentSwitchUserImpactOwnershipAmbiguous, AgentSwitchUserImpactGateRetained,
		AgentSwitchUserImpactVisibilityImpaired, AgentSwitchUserImpactNotApplicable:
		return true
	default:
		return false
	}
}

type AgentSwitchSeverity string

const (
	AgentSwitchSeverityFatal   AgentSwitchSeverity = "fatal"
	AgentSwitchSeverityError   AgentSwitchSeverity = "error"
	AgentSwitchSeverityWarning AgentSwitchSeverity = "warning"
	AgentSwitchSeverityNone    AgentSwitchSeverity = "none"
)

func (s AgentSwitchSeverity) Valid() bool {
	switch s {
	case AgentSwitchSeverityFatal, AgentSwitchSeverityError,
		AgentSwitchSeverityWarning, AgentSwitchSeverityNone:
		return true
	default:
		return false
	}
}

type AgentSwitchRuntimeBackend string

const (
	AgentSwitchRuntimeTMUX           AgentSwitchRuntimeBackend = "tmux"
	AgentSwitchRuntimeConPTY         AgentSwitchRuntimeBackend = "conpty"
	AgentSwitchRuntimeChatController AgentSwitchRuntimeBackend = "chat_controller"
	AgentSwitchRuntimeNotApplicable  AgentSwitchRuntimeBackend = "not_applicable"
)

func (b AgentSwitchRuntimeBackend) valid() bool {
	switch b {
	case AgentSwitchRuntimeTMUX, AgentSwitchRuntimeConPTY,
		AgentSwitchRuntimeChatController, AgentSwitchRuntimeNotApplicable:
		return true
	default:
		return false
	}
}

// AgentSwitchClassifierCallsite is a stable, privacy-safe name for the code
// location which owns the semantic classification.
type AgentSwitchClassifierCallsite string

const (
	AgentSwitchClassifierAdmission           AgentSwitchClassifierCallsite = "session_manager.admit_agent_switch"
	AgentSwitchClassifierSettle              AgentSwitchClassifierCallsite = "session_manager.settle_agent_switch_fault"
	AgentSwitchClassifierExecuteTUI          AgentSwitchClassifierCallsite = "session_manager.execute_agent_switch"
	AgentSwitchClassifierExecuteChat         AgentSwitchClassifierCallsite = "session_manager.execute_chat_agent_switch"
	AgentSwitchClassifierReconcile           AgentSwitchClassifierCallsite = "session_manager.reconcile_agent_switch"
	AgentSwitchClassifierLiveWorkerPanic     AgentSwitchClassifierCallsite = "session_manager.live_agent_switch_worker_panic"
	AgentSwitchClassifierRecoveryWorkerPanic AgentSwitchClassifierCallsite = "session_manager.recovery_agent_switch_worker_panic"
	AgentSwitchClassifierTerminalMaintenance AgentSwitchClassifierCallsite = "session_manager.cleanup_terminal_agent_switch"
	AgentSwitchClassifierDaemonShutdown      AgentSwitchClassifierCallsite = "daemon.wait_agent_switch_workers"
	AgentSwitchClassifierVisibility          AgentSwitchClassifierCallsite = "electron_main.agent_switch_visibility"
	AgentSwitchClassifierOutbox              AgentSwitchClassifierCallsite = "agentswitch.dispatch_outbox"
	AgentSwitchClassifierInvariant           AgentSwitchClassifierCallsite = "agentswitch.classification_invariant"
)

func (c AgentSwitchClassifierCallsite) valid() bool {
	switch c {
	case AgentSwitchClassifierAdmission, AgentSwitchClassifierSettle, AgentSwitchClassifierExecuteTUI,
		AgentSwitchClassifierExecuteChat, AgentSwitchClassifierReconcile,
		AgentSwitchClassifierLiveWorkerPanic, AgentSwitchClassifierRecoveryWorkerPanic,
		AgentSwitchClassifierTerminalMaintenance, AgentSwitchClassifierDaemonShutdown,
		AgentSwitchClassifierVisibility, AgentSwitchClassifierOutbox,
		AgentSwitchClassifierInvariant:
		return true
	default:
		return false
	}
}

type AgentSwitchTriState string

const (
	AgentSwitchTriTrue          AgentSwitchTriState = "true"
	AgentSwitchTriFalse         AgentSwitchTriState = "false"
	AgentSwitchTriNotApplicable AgentSwitchTriState = "not_applicable"
)

func (s AgentSwitchTriState) valid() bool {
	return s == AgentSwitchTriTrue || s == AgentSwitchTriFalse || s == AgentSwitchTriNotApplicable
}

// AgentSwitchReportingAuthorization is the exact transaction-bound authority
// snapshot supplied by the policy coordinator.
type AgentSwitchReportingAuthorization struct {
	Enabled                bool
	ConsentGeneration      string
	DestinationFingerprint string
}

type AgentSwitchEnrollmentStatus string

const (
	AgentSwitchEnrollmentEnrolled             AgentSwitchEnrollmentStatus = "enrolled"
	AgentSwitchEnrollmentDisabled             AgentSwitchEnrollmentStatus = "disabled"
	AgentSwitchEnrollmentStaleGeneration      AgentSwitchEnrollmentStatus = "stale_generation"
	AgentSwitchEnrollmentDeduped              AgentSwitchEnrollmentStatus = "deduped"
	AgentSwitchEnrollmentLocalInvariantFailed AgentSwitchEnrollmentStatus = "local_invariant_failed"
)

func AllAgentSwitchEnrollmentStatuses() []AgentSwitchEnrollmentStatus {
	return []AgentSwitchEnrollmentStatus{
		AgentSwitchEnrollmentEnrolled,
		AgentSwitchEnrollmentDisabled,
		AgentSwitchEnrollmentStaleGeneration,
		AgentSwitchEnrollmentDeduped,
		AgentSwitchEnrollmentLocalInvariantFailed,
	}
}

type AgentSwitchFailurePoint string

const (
	AgentSwitchFailureAdmissionSagaCreate          AgentSwitchFailurePoint = "admission_saga_create"
	AgentSwitchFailureAdmissionCommitReadback      AgentSwitchFailurePoint = "admission_commit_readback"
	AgentSwitchFailureAdmissionChatHandoffArm      AgentSwitchFailurePoint = "admission_chat_handoff_arm"
	AgentSwitchFailureWorkerStartRefused           AgentSwitchFailurePoint = "worker_start_refused"
	AgentSwitchFailureSourceNativePreserve         AgentSwitchFailurePoint = "source_native_preserve"
	AgentSwitchFailureTargetPreflight              AgentSwitchFailurePoint = "target_preflight"
	AgentSwitchFailureTargetResumeLookup           AgentSwitchFailurePoint = "target_resume_lookup"
	AgentSwitchFailureHandoffDirectoryPrepare      AgentSwitchFailurePoint = "handoff_directory_prepare"
	AgentSwitchFailureHandoffCollection            AgentSwitchFailurePoint = "handoff_collection"
	AgentSwitchFailureHandoffSettlement            AgentSwitchFailurePoint = "handoff_settlement"
	AgentSwitchFailureDecisionInputClose           AgentSwitchFailurePoint = "decision_input_close"
	AgentSwitchFailureSourceHandoffInterrupt       AgentSwitchFailurePoint = "source_handoff_interrupt"
	AgentSwitchFailureChatSourceQuiesce            AgentSwitchFailurePoint = "chat_source_quiesce"
	AgentSwitchFailureTargetLaunchGatePrepare      AgentSwitchFailurePoint = "target_launch_gate_prepare"
	AgentSwitchFailureStoppingSourceCommit         AgentSwitchFailurePoint = "stopping_source_commit"
	AgentSwitchFailureSourceRuntimeDestroy         AgentSwitchFailurePoint = "source_runtime_destroy"
	AgentSwitchFailureSourceRuntimeProbe           AgentSwitchFailurePoint = "source_runtime_probe"
	AgentSwitchFailureSourceControllerStop         AgentSwitchFailurePoint = "source_controller_stop"
	AgentSwitchFailureSourceControllerDrain        AgentSwitchFailurePoint = "source_controller_drain"
	AgentSwitchFailureSourceStopCommit             AgentSwitchFailurePoint = "source_stop_commit"
	AgentSwitchFailureSourceStopReadback           AgentSwitchFailurePoint = "source_stop_readback"
	AgentSwitchFailureSourceMetadataRefresh        AgentSwitchFailurePoint = "source_metadata_refresh"
	AgentSwitchFailureSemanticArtifactVerify       AgentSwitchFailurePoint = "semantic_artifact_verify"
	AgentSwitchFailureSourceTranscriptCapture      AgentSwitchFailurePoint = "source_transcript_capture"
	AgentSwitchFailureContinuationBuild            AgentSwitchFailurePoint = "continuation_build"
	AgentSwitchFailureFinalArtifactPublish         AgentSwitchFailurePoint = "final_artifact_publish"
	AgentSwitchFailureFinalArtifactVerify          AgentSwitchFailurePoint = "final_artifact_verify"
	AgentSwitchFailureFinalArtifactCommit          AgentSwitchFailurePoint = "final_artifact_commit"
	AgentSwitchFailureTargetPromptPrepare          AgentSwitchFailurePoint = "target_prompt_prepare"
	AgentSwitchFailureTargetWorkspacePrepare       AgentSwitchFailurePoint = "target_workspace_prepare"
	AgentSwitchFailureTargetNativePrepare          AgentSwitchFailurePoint = "target_native_prepare"
	AgentSwitchFailureTargetNativeCommit           AgentSwitchFailurePoint = "target_native_commit"
	AgentSwitchFailureTargetRuntimeCreate          AgentSwitchFailurePoint = "target_runtime_create"
	AgentSwitchFailureTargetHandleCommit           AgentSwitchFailurePoint = "target_handle_commit"
	AgentSwitchFailureTargetGenerationProbe        AgentSwitchFailurePoint = "target_generation_probe"
	AgentSwitchFailureTargetNativeIdentityWait     AgentSwitchFailurePoint = "target_native_identity_wait"
	AgentSwitchFailureTargetActivationCommit       AgentSwitchFailurePoint = "target_activation_commit"
	AgentSwitchFailureTargetActivationReadback     AgentSwitchFailurePoint = "target_activation_readback"
	AgentSwitchFailureChatProviderStart            AgentSwitchFailurePoint = "chat_provider_start"
	AgentSwitchFailureChatProviderResume           AgentSwitchFailurePoint = "chat_provider_resume"
	AgentSwitchFailureChatNativeIdentityCommit     AgentSwitchFailurePoint = "chat_native_identity_commit"
	AgentSwitchFailureChatProviderBoundaryCommit   AgentSwitchFailurePoint = "chat_provider_boundary_commit"
	AgentSwitchFailureChatTargetActivationCommit   AgentSwitchFailurePoint = "chat_target_activation_commit"
	AgentSwitchFailureChatTargetActivationReadback AgentSwitchFailurePoint = "chat_target_activation_readback"
	AgentSwitchFailureChatControllerPublish        AgentSwitchFailurePoint = "chat_controller_publish"
	AgentSwitchFailureDeliveryOpenCommit           AgentSwitchFailurePoint = "delivery_open_commit"
	AgentSwitchFailureTUITargetHookWait            AgentSwitchFailurePoint = "tui_target_hook_wait"
	AgentSwitchFailureTUITargetAckCommit           AgentSwitchFailurePoint = "tui_target_ack_commit"
	AgentSwitchFailureChatContinuationRelay        AgentSwitchFailurePoint = "chat_continuation_relay"
	AgentSwitchFailureChatTargetAckCommit          AgentSwitchFailurePoint = "chat_target_ack_commit"
	AgentSwitchFailureCompletionCommit             AgentSwitchFailurePoint = "completion_commit"
	AgentSwitchFailureTargetRuntimeCleanup         AgentSwitchFailurePoint = "target_runtime_cleanup"
	AgentSwitchFailureTargetWorkspaceCleanup       AgentSwitchFailurePoint = "target_workspace_cleanup"
	AgentSwitchFailureSourceRuntimeRestore         AgentSwitchFailurePoint = "source_runtime_restore"
	AgentSwitchFailureSourceControllerRestore      AgentSwitchFailurePoint = "source_controller_restore"
	AgentSwitchFailureRecoverySessionLoad          AgentSwitchFailurePoint = "recovery_session_load"
	AgentSwitchFailureRecoveryRuntimeProbe         AgentSwitchFailurePoint = "recovery_runtime_probe"
	AgentSwitchFailureRecoveryNativeIdentity       AgentSwitchFailurePoint = "recovery_native_identity"
	AgentSwitchFailureRecoveryArtifactVerify       AgentSwitchFailurePoint = "recovery_artifact_verify"
	AgentSwitchFailureRecoveryActivation           AgentSwitchFailurePoint = "recovery_activation"
	AgentSwitchFailureRecoverySettlement           AgentSwitchFailurePoint = "recovery_settlement"
	AgentSwitchFailureRecoveryExistingMarker       AgentSwitchFailurePoint = "recovery_existing_marker"
	AgentSwitchFailureLiveWorkerPanic              AgentSwitchFailurePoint = "live_worker_panic"
	AgentSwitchFailureRecoveryWorkerPanic          AgentSwitchFailurePoint = "recovery_worker_panic"
	AgentSwitchFailureShutdownWorkerTimeout        AgentSwitchFailurePoint = "shutdown_worker_timeout"
	AgentSwitchFailureTerminalArtifactCleanup      AgentSwitchFailurePoint = "terminal_artifact_cleanup"
	AgentSwitchFailureVisibilityTransport          AgentSwitchFailurePoint = "visibility_transport"
	AgentSwitchFailureVisibilityQuery              AgentSwitchFailurePoint = "visibility_query"
	AgentSwitchFailureVisibilityPresentation       AgentSwitchFailurePoint = "visibility_presentation"
	AgentSwitchFailureOutboxDelivery               AgentSwitchFailurePoint = "outbox_delivery"
	AgentSwitchFailureClassificationUnknown        AgentSwitchFailurePoint = "classification_unknown"
)

var allAgentSwitchFailurePoints = []AgentSwitchFailurePoint{
	AgentSwitchFailureAdmissionChatHandoffArm, AgentSwitchFailureAdmissionCommitReadback,
	AgentSwitchFailureAdmissionSagaCreate, AgentSwitchFailureChatContinuationRelay,
	AgentSwitchFailureChatControllerPublish, AgentSwitchFailureChatNativeIdentityCommit,
	AgentSwitchFailureChatProviderBoundaryCommit, AgentSwitchFailureChatProviderResume,
	AgentSwitchFailureChatProviderStart, AgentSwitchFailureChatSourceQuiesce,
	AgentSwitchFailureChatTargetAckCommit, AgentSwitchFailureChatTargetActivationCommit,
	AgentSwitchFailureChatTargetActivationReadback, AgentSwitchFailureClassificationUnknown,
	AgentSwitchFailureCompletionCommit, AgentSwitchFailureContinuationBuild,
	AgentSwitchFailureDecisionInputClose, AgentSwitchFailureDeliveryOpenCommit,
	AgentSwitchFailureFinalArtifactCommit, AgentSwitchFailureFinalArtifactPublish,
	AgentSwitchFailureFinalArtifactVerify, AgentSwitchFailureHandoffCollection,
	AgentSwitchFailureHandoffDirectoryPrepare, AgentSwitchFailureHandoffSettlement,
	AgentSwitchFailureLiveWorkerPanic, AgentSwitchFailureOutboxDelivery,
	AgentSwitchFailureRecoveryActivation, AgentSwitchFailureRecoveryArtifactVerify,
	AgentSwitchFailureRecoveryExistingMarker, AgentSwitchFailureRecoveryNativeIdentity,
	AgentSwitchFailureRecoveryRuntimeProbe, AgentSwitchFailureRecoverySessionLoad,
	AgentSwitchFailureRecoverySettlement, AgentSwitchFailureRecoveryWorkerPanic,
	AgentSwitchFailureSemanticArtifactVerify, AgentSwitchFailureShutdownWorkerTimeout,
	AgentSwitchFailureSourceControllerDrain, AgentSwitchFailureSourceControllerRestore,
	AgentSwitchFailureSourceControllerStop, AgentSwitchFailureSourceHandoffInterrupt,
	AgentSwitchFailureSourceMetadataRefresh, AgentSwitchFailureSourceNativePreserve,
	AgentSwitchFailureSourceRuntimeDestroy, AgentSwitchFailureSourceRuntimeProbe,
	AgentSwitchFailureSourceRuntimeRestore, AgentSwitchFailureSourceStopCommit,
	AgentSwitchFailureSourceStopReadback, AgentSwitchFailureSourceTranscriptCapture,
	AgentSwitchFailureStoppingSourceCommit, AgentSwitchFailureTargetActivationCommit,
	AgentSwitchFailureTargetActivationReadback, AgentSwitchFailureTargetGenerationProbe,
	AgentSwitchFailureTargetHandleCommit, AgentSwitchFailureTargetLaunchGatePrepare,
	AgentSwitchFailureTargetNativeCommit, AgentSwitchFailureTargetNativeIdentityWait,
	AgentSwitchFailureTargetNativePrepare, AgentSwitchFailureTargetPreflight,
	AgentSwitchFailureTargetPromptPrepare, AgentSwitchFailureTargetResumeLookup,
	AgentSwitchFailureTargetRuntimeCleanup, AgentSwitchFailureTargetRuntimeCreate,
	AgentSwitchFailureTargetWorkspaceCleanup, AgentSwitchFailureTargetWorkspacePrepare,
	AgentSwitchFailureTerminalArtifactCleanup, AgentSwitchFailureTUITargetAckCommit,
	AgentSwitchFailureTUITargetHookWait, AgentSwitchFailureVisibilityPresentation,
	AgentSwitchFailureVisibilityQuery, AgentSwitchFailureVisibilityTransport,
	AgentSwitchFailureWorkerStartRefused,
}

func init() {
	sort.Slice(allAgentSwitchFailurePoints, func(i, j int) bool {
		return allAgentSwitchFailurePoints[i] < allAgentSwitchFailurePoints[j]
	})
}

func AllAgentSwitchFailurePoints() []AgentSwitchFailurePoint {
	return append([]AgentSwitchFailurePoint(nil), allAgentSwitchFailurePoints...)
}

type AgentSwitchFailureTaxonomyEntry struct {
	Subsystem          string
	ReportKind         AgentSwitchReportKind
	AllowedReportKinds []AgentSwitchReportKind
	DefaultSeverity    AgentSwitchSeverity
	AllowedPhases      []AgentSwitchState
	AllowedErrorCodes  []AgentSwitchErrorCode
	AllowedFaultCodes  []AgentSwitchFaultCode
	ClassifierCallsite AgentSwitchClassifierCallsite
	Title              string
	RunbookAnchor      string
	LocalOnly          bool
}

var agentSwitchFailureTaxonomy = buildAgentSwitchFailureTaxonomy()

func AgentSwitchFailureTaxonomy(point AgentSwitchFailurePoint) (AgentSwitchFailureTaxonomyEntry, bool) {
	entry, ok := agentSwitchFailureTaxonomy[point]
	if !ok {
		return AgentSwitchFailureTaxonomyEntry{}, false
	}
	entry.AllowedReportKinds = append([]AgentSwitchReportKind(nil), entry.AllowedReportKinds...)
	entry.AllowedPhases = append([]AgentSwitchState(nil), entry.AllowedPhases...)
	entry.AllowedErrorCodes = append([]AgentSwitchErrorCode(nil), entry.AllowedErrorCodes...)
	entry.AllowedFaultCodes = append([]AgentSwitchFaultCode(nil), entry.AllowedFaultCodes...)
	return entry, true
}

func buildAgentSwitchFailureTaxonomy() map[AgentSwitchFailurePoint]AgentSwitchFailureTaxonomyEntry {
	taxonomy := make(map[AgentSwitchFailurePoint]AgentSwitchFailureTaxonomyEntry, len(allAgentSwitchFailurePoints))
	semanticReports := []AgentSwitchReportKind{AgentSwitchReportTerminalFailure, AgentSwitchReportRecoveryRequired}
	operationalReports := []AgentSwitchReportKind{AgentSwitchReportTerminalFailure, AgentSwitchReportRecoveryRequired, AgentSwitchReportRecoveryAttemptFailed}
	allErrors := []AgentSwitchErrorCode{
		AgentSwitchErrorNotApplicable, AgentSwitchErrorDaemonRestartPreStop,
		AgentSwitchErrorDaemonRestartPostStop, AgentSwitchErrorDaemonRestartUnrecoverableTarget,
		AgentSwitchErrorDaemonRestartBeforeDelivery, AgentSwitchErrorDeliveryUnconfirmed,
		AgentSwitchErrorSourceSessionTerminated, AgentSwitchErrorSourceStopUnconfirmed,
		AgentSwitchErrorTargetBinaryMissing, AgentSwitchErrorTargetAgentUnauthorized,
		AgentSwitchErrorTargetStartUnconfirmed, AgentSwitchErrorSourceRestoreUnconfirmed,
		AgentSwitchErrorRequestCancelled, AgentSwitchErrorSourceBlocked,
		AgentSwitchErrorFailedPreStop, AgentSwitchErrorFailedPostStop,
		AgentSwitchErrorTargetReadyFailed, AgentSwitchErrorDeliveryFailed,
		AgentSwitchErrorSwitchFailed,
	}
	allFaults := []AgentSwitchFaultCode{
		AgentSwitchFaultNotApplicable, AgentSwitchFaultWorkerPanic,
		AgentSwitchFaultRecoveryUnresolved, AgentSwitchFaultTerminalCleanupFailed,
		AgentSwitchFaultShutdownWorkersTimedOut,
	}
	preStopErrors := []AgentSwitchErrorCode{
		AgentSwitchErrorRequestCancelled, AgentSwitchErrorSourceBlocked,
		AgentSwitchErrorTargetBinaryMissing, AgentSwitchErrorTargetAgentUnauthorized,
		AgentSwitchErrorFailedPreStop, AgentSwitchErrorSwitchFailed,
	}
	sourceStopErrors := []AgentSwitchErrorCode{
		AgentSwitchErrorDaemonRestartPreStop, AgentSwitchErrorDaemonRestartPostStop,
		AgentSwitchErrorSourceSessionTerminated, AgentSwitchErrorSourceStopUnconfirmed,
		AgentSwitchErrorRequestCancelled, AgentSwitchErrorFailedPostStop, AgentSwitchErrorSwitchFailed,
	}
	artifactErrors := []AgentSwitchErrorCode{
		AgentSwitchErrorDaemonRestartPostStop, AgentSwitchErrorRequestCancelled,
		AgentSwitchErrorFailedPreStop, AgentSwitchErrorFailedPostStop, AgentSwitchErrorSwitchFailed,
	}
	targetErrors := []AgentSwitchErrorCode{
		AgentSwitchErrorDaemonRestartUnrecoverableTarget, AgentSwitchErrorTargetBinaryMissing,
		AgentSwitchErrorTargetAgentUnauthorized, AgentSwitchErrorTargetStartUnconfirmed,
		AgentSwitchErrorSourceRestoreUnconfirmed, AgentSwitchErrorRequestCancelled,
		AgentSwitchErrorFailedPostStop, AgentSwitchErrorTargetReadyFailed, AgentSwitchErrorSwitchFailed,
	}
	deliveryErrors := []AgentSwitchErrorCode{
		AgentSwitchErrorDaemonRestartBeforeDelivery, AgentSwitchErrorDeliveryUnconfirmed,
		AgentSwitchErrorRequestCancelled, AgentSwitchErrorDeliveryFailed, AgentSwitchErrorSwitchFailed,
	}
	recoveryErrors := []AgentSwitchErrorCode{
		AgentSwitchErrorNotApplicable, AgentSwitchErrorDaemonRestartPreStop,
		AgentSwitchErrorDaemonRestartPostStop, AgentSwitchErrorDaemonRestartUnrecoverableTarget,
		AgentSwitchErrorDaemonRestartBeforeDelivery, AgentSwitchErrorDeliveryUnconfirmed,
		AgentSwitchErrorSourceSessionTerminated, AgentSwitchErrorSourceStopUnconfirmed,
		AgentSwitchErrorTargetStartUnconfirmed, AgentSwitchErrorSourceRestoreUnconfirmed,
		AgentSwitchErrorFailedPostStop, AgentSwitchErrorTargetReadyFailed,
		AgentSwitchErrorDeliveryFailed, AgentSwitchErrorSwitchFailed,
	}
	add := func(points []AgentSwitchFailurePoint, subsystem string, report AgentSwitchReportKind, reports []AgentSwitchReportKind, severity AgentSwitchSeverity, phases []AgentSwitchState, callsite AgentSwitchClassifierCallsite) {
		for _, point := range points {
			taxonomy[point] = AgentSwitchFailureTaxonomyEntry{
				Subsystem: subsystem, ReportKind: report,
				AllowedReportKinds: append([]AgentSwitchReportKind(nil), reports...),
				DefaultSeverity:    severity, AllowedPhases: append([]AgentSwitchState(nil), phases...),
				AllowedErrorCodes:  append([]AgentSwitchErrorCode(nil), allErrors...),
				AllowedFaultCodes:  append([]AgentSwitchFaultCode(nil), allFaults...),
				ClassifierCallsite: callsite,
				Title:              "Agent switch failure at " + strings.ReplaceAll(string(point), "_", " "),
				RunbookAnchor:      "agent-switch-" + string(point),
			}
		}
	}
	add([]AgentSwitchFailurePoint{
		AgentSwitchFailureAdmissionSagaCreate, AgentSwitchFailureAdmissionCommitReadback,
		AgentSwitchFailureAdmissionChatHandoffArm, AgentSwitchFailureWorkerStartRefused,
	}, "admission", AgentSwitchReportTerminalFailure, semanticReports, AgentSwitchSeverityWarning,
		[]AgentSwitchState{AgentSwitchPreparingHandoff, AgentSwitchFailed}, AgentSwitchClassifierAdmission)
	add([]AgentSwitchFailurePoint{
		AgentSwitchFailureSourceNativePreserve, AgentSwitchFailureTargetPreflight,
		AgentSwitchFailureTargetResumeLookup, AgentSwitchFailureHandoffDirectoryPrepare,
		AgentSwitchFailureHandoffCollection, AgentSwitchFailureHandoffSettlement,
		AgentSwitchFailureDecisionInputClose, AgentSwitchFailureSourceHandoffInterrupt,
		AgentSwitchFailureTargetLaunchGatePrepare, AgentSwitchFailureStoppingSourceCommit,
	}, "preflight_handoff", AgentSwitchReportTerminalFailure, semanticReports, AgentSwitchSeverityWarning,
		[]AgentSwitchState{AgentSwitchPreparingHandoff, AgentSwitchStoppingSource, AgentSwitchFailed}, AgentSwitchClassifierSettle)
	add([]AgentSwitchFailurePoint{AgentSwitchFailureChatSourceQuiesce}, "preflight_handoff", AgentSwitchReportTerminalFailure,
		semanticReports, AgentSwitchSeverityWarning, []AgentSwitchState{AgentSwitchPreparingHandoff, AgentSwitchStoppingSource, AgentSwitchFailed}, AgentSwitchClassifierExecuteChat)
	add([]AgentSwitchFailurePoint{AgentSwitchFailureSourceRuntimeDestroy, AgentSwitchFailureSourceRuntimeProbe},
		"source_stop", AgentSwitchReportTerminalFailure, semanticReports, AgentSwitchSeverityError,
		[]AgentSwitchState{AgentSwitchStoppingSource, AgentSwitchSourceStopped, AgentSwitchFailed}, AgentSwitchClassifierExecuteTUI)
	add([]AgentSwitchFailurePoint{AgentSwitchFailureSourceControllerStop, AgentSwitchFailureSourceControllerDrain},
		"source_stop", AgentSwitchReportTerminalFailure, semanticReports, AgentSwitchSeverityError,
		[]AgentSwitchState{AgentSwitchStoppingSource, AgentSwitchSourceStopped, AgentSwitchFailed}, AgentSwitchClassifierExecuteChat)
	add([]AgentSwitchFailurePoint{AgentSwitchFailureSourceStopCommit, AgentSwitchFailureSourceStopReadback},
		"source_stop", AgentSwitchReportTerminalFailure, semanticReports, AgentSwitchSeverityError,
		[]AgentSwitchState{AgentSwitchStoppingSource, AgentSwitchSourceStopped, AgentSwitchFailed}, AgentSwitchClassifierSettle)
	add([]AgentSwitchFailurePoint{
		AgentSwitchFailureSourceMetadataRefresh, AgentSwitchFailureSemanticArtifactVerify,
		AgentSwitchFailureSourceTranscriptCapture, AgentSwitchFailureContinuationBuild,
		AgentSwitchFailureFinalArtifactPublish, AgentSwitchFailureFinalArtifactVerify,
		AgentSwitchFailureFinalArtifactCommit, AgentSwitchFailureTargetPromptPrepare,
		AgentSwitchFailureTargetWorkspacePrepare,
	}, "artifact_context", AgentSwitchReportTerminalFailure, semanticReports, AgentSwitchSeverityError,
		[]AgentSwitchState{AgentSwitchPreparingHandoff, AgentSwitchSourceStopped, AgentSwitchStartingTarget, AgentSwitchFailed}, AgentSwitchClassifierSettle)
	add([]AgentSwitchFailurePoint{
		AgentSwitchFailureTargetNativePrepare, AgentSwitchFailureTargetNativeCommit,
		AgentSwitchFailureTargetRuntimeCreate, AgentSwitchFailureTargetHandleCommit,
		AgentSwitchFailureTargetGenerationProbe, AgentSwitchFailureTargetNativeIdentityWait,
		AgentSwitchFailureTargetActivationCommit, AgentSwitchFailureTargetActivationReadback,
	}, "tui_target_start", AgentSwitchReportTerminalFailure, semanticReports, AgentSwitchSeverityError,
		[]AgentSwitchState{AgentSwitchStartingTarget, AgentSwitchTargetReady, AgentSwitchFailed}, AgentSwitchClassifierExecuteTUI)
	add([]AgentSwitchFailurePoint{
		AgentSwitchFailureChatProviderStart, AgentSwitchFailureChatProviderResume,
		AgentSwitchFailureChatNativeIdentityCommit, AgentSwitchFailureChatProviderBoundaryCommit,
		AgentSwitchFailureChatTargetActivationCommit, AgentSwitchFailureChatTargetActivationReadback,
		AgentSwitchFailureChatControllerPublish,
	}, "chat_target_start", AgentSwitchReportTerminalFailure, semanticReports, AgentSwitchSeverityError,
		[]AgentSwitchState{AgentSwitchStartingTarget, AgentSwitchTargetReady, AgentSwitchFailed}, AgentSwitchClassifierExecuteChat)
	add([]AgentSwitchFailurePoint{AgentSwitchFailureDeliveryOpenCommit, AgentSwitchFailureCompletionCommit},
		"delivery", AgentSwitchReportTerminalFailure, semanticReports, AgentSwitchSeverityError,
		[]AgentSwitchState{AgentSwitchTargetReady, AgentSwitchDelivering, AgentSwitchFailed}, AgentSwitchClassifierSettle)
	add([]AgentSwitchFailurePoint{AgentSwitchFailureTUITargetHookWait, AgentSwitchFailureTUITargetAckCommit},
		"delivery", AgentSwitchReportTerminalFailure, semanticReports, AgentSwitchSeverityError,
		[]AgentSwitchState{AgentSwitchTargetReady, AgentSwitchDelivering, AgentSwitchFailed}, AgentSwitchClassifierExecuteTUI)
	add([]AgentSwitchFailurePoint{
		AgentSwitchFailureChatContinuationRelay, AgentSwitchFailureChatTargetAckCommit,
	}, "delivery", AgentSwitchReportTerminalFailure, semanticReports, AgentSwitchSeverityError,
		[]AgentSwitchState{AgentSwitchTargetReady, AgentSwitchDelivering, AgentSwitchFailed}, AgentSwitchClassifierExecuteChat)
	add([]AgentSwitchFailurePoint{
		AgentSwitchFailureTargetRuntimeCleanup, AgentSwitchFailureTargetWorkspaceCleanup,
		AgentSwitchFailureSourceRuntimeRestore,
	}, "compensation_recovery", AgentSwitchReportRecoveryRequired, operationalReports, AgentSwitchSeverityError,
		[]AgentSwitchState{AgentSwitchStoppingSource, AgentSwitchSourceStopped, AgentSwitchStartingTarget, AgentSwitchFailed}, AgentSwitchClassifierExecuteTUI)
	add([]AgentSwitchFailurePoint{AgentSwitchFailureSourceControllerRestore}, "compensation_recovery",
		AgentSwitchReportRecoveryRequired, operationalReports, AgentSwitchSeverityError,
		[]AgentSwitchState{AgentSwitchStoppingSource, AgentSwitchSourceStopped, AgentSwitchStartingTarget, AgentSwitchFailed}, AgentSwitchClassifierExecuteChat)
	add([]AgentSwitchFailurePoint{
		AgentSwitchFailureRecoverySessionLoad, AgentSwitchFailureRecoveryRuntimeProbe,
		AgentSwitchFailureRecoveryNativeIdentity, AgentSwitchFailureRecoveryArtifactVerify,
		AgentSwitchFailureRecoveryActivation, AgentSwitchFailureRecoverySettlement,
		AgentSwitchFailureRecoveryExistingMarker,
	}, "compensation_recovery", AgentSwitchReportRecoveryAttemptFailed, operationalReports, AgentSwitchSeverityError,
		[]AgentSwitchState{AgentSwitchPreparingHandoff, AgentSwitchStoppingSource, AgentSwitchSourceStopped, AgentSwitchStartingTarget, AgentSwitchTargetReady, AgentSwitchDelivering, AgentSwitchFailed}, AgentSwitchClassifierReconcile)
	add([]AgentSwitchFailurePoint{AgentSwitchFailureLiveWorkerPanic}, "process", AgentSwitchReportPanic,
		[]AgentSwitchReportKind{AgentSwitchReportPanic}, AgentSwitchSeverityError,
		[]AgentSwitchState{AgentSwitchPreparingHandoff, AgentSwitchStoppingSource, AgentSwitchSourceStopped, AgentSwitchStartingTarget, AgentSwitchTargetReady, AgentSwitchDelivering, AgentSwitchFailed}, AgentSwitchClassifierLiveWorkerPanic)
	add([]AgentSwitchFailurePoint{AgentSwitchFailureRecoveryWorkerPanic}, "process", AgentSwitchReportPanic,
		[]AgentSwitchReportKind{AgentSwitchReportPanic}, AgentSwitchSeverityError,
		[]AgentSwitchState{AgentSwitchPreparingHandoff, AgentSwitchStoppingSource, AgentSwitchSourceStopped, AgentSwitchStartingTarget, AgentSwitchTargetReady, AgentSwitchDelivering, AgentSwitchFailed}, AgentSwitchClassifierRecoveryWorkerPanic)
	add([]AgentSwitchFailurePoint{AgentSwitchFailureShutdownWorkerTimeout}, "process", AgentSwitchReportDaemonLifecycleFailure,
		[]AgentSwitchReportKind{AgentSwitchReportDaemonLifecycleFailure}, AgentSwitchSeverityError,
		[]AgentSwitchState{AgentSwitchStateNotApplicable}, AgentSwitchClassifierDaemonShutdown)
	add([]AgentSwitchFailurePoint{AgentSwitchFailureTerminalArtifactCleanup}, "maintenance", AgentSwitchReportMaintenanceFailure,
		[]AgentSwitchReportKind{AgentSwitchReportMaintenanceFailure}, AgentSwitchSeverityWarning,
		[]AgentSwitchState{AgentSwitchCompleted, AgentSwitchFailed}, AgentSwitchClassifierTerminalMaintenance)
	add([]AgentSwitchFailurePoint{AgentSwitchFailureVisibilityTransport, AgentSwitchFailureVisibilityQuery, AgentSwitchFailureVisibilityPresentation},
		"visibility", AgentSwitchReportVisibilityFailure, []AgentSwitchReportKind{AgentSwitchReportVisibilityFailure}, AgentSwitchSeverityWarning,
		[]AgentSwitchState{AgentSwitchPreparingHandoff, AgentSwitchStoppingSource, AgentSwitchSourceStopped, AgentSwitchStartingTarget, AgentSwitchTargetReady, AgentSwitchDelivering, AgentSwitchCompleted, AgentSwitchFailed, AgentSwitchStateNotApplicable}, AgentSwitchClassifierVisibility)

	for point, callsite := range map[AgentSwitchFailurePoint]AgentSwitchClassifierCallsite{
		AgentSwitchFailureOutboxDelivery:        AgentSwitchClassifierOutbox,
		AgentSwitchFailureClassificationUnknown: AgentSwitchClassifierInvariant,
	} {
		taxonomy[point] = AgentSwitchFailureTaxonomyEntry{
			Subsystem: "observability", ReportKind: AgentSwitchReportNotApplicable,
			AllowedReportKinds: []AgentSwitchReportKind{AgentSwitchReportNotApplicable},
			DefaultSeverity:    AgentSwitchSeverityNone,
			AllowedPhases:      []AgentSwitchState{AgentSwitchPreparingHandoff, AgentSwitchStoppingSource, AgentSwitchSourceStopped, AgentSwitchStartingTarget, AgentSwitchTargetReady, AgentSwitchDelivering, AgentSwitchCompleted, AgentSwitchFailed, AgentSwitchStateNotApplicable},
			AllowedErrorCodes:  append([]AgentSwitchErrorCode(nil), allErrors...),
			AllowedFaultCodes:  append([]AgentSwitchFaultCode(nil), allFaults...),
			ClassifierCallsite: callsite,
			Title:              "Local agent switch observability failure",
			RunbookAnchor:      "agent-switch-" + string(point), LocalOnly: true,
		}
	}
	for point, entry := range taxonomy {
		if entry.LocalOnly {
			continue
		}
		switch entry.Subsystem {
		case "admission", "preflight_handoff":
			entry.AllowedErrorCodes = append([]AgentSwitchErrorCode(nil), preStopErrors...)
			entry.AllowedFaultCodes = []AgentSwitchFaultCode{AgentSwitchFaultNotApplicable}
		case "source_stop":
			entry.AllowedErrorCodes = append([]AgentSwitchErrorCode(nil), sourceStopErrors...)
			entry.AllowedFaultCodes = []AgentSwitchFaultCode{AgentSwitchFaultNotApplicable}
		case "artifact_context":
			entry.AllowedErrorCodes = append([]AgentSwitchErrorCode(nil), artifactErrors...)
			entry.AllowedFaultCodes = []AgentSwitchFaultCode{AgentSwitchFaultNotApplicable}
		case "tui_target_start", "chat_target_start":
			entry.AllowedErrorCodes = append([]AgentSwitchErrorCode(nil), targetErrors...)
			entry.AllowedFaultCodes = []AgentSwitchFaultCode{AgentSwitchFaultNotApplicable}
		case "delivery":
			entry.AllowedErrorCodes = append([]AgentSwitchErrorCode(nil), deliveryErrors...)
			entry.AllowedFaultCodes = []AgentSwitchFaultCode{AgentSwitchFaultNotApplicable}
		case "compensation_recovery":
			entry.AllowedErrorCodes = append([]AgentSwitchErrorCode(nil), recoveryErrors...)
			entry.AllowedFaultCodes = []AgentSwitchFaultCode{AgentSwitchFaultNotApplicable, AgentSwitchFaultRecoveryUnresolved}
		case "process":
			entry.AllowedErrorCodes = append([]AgentSwitchErrorCode(nil), allErrors...)
			if entry.ReportKind == AgentSwitchReportPanic {
				entry.AllowedFaultCodes = []AgentSwitchFaultCode{AgentSwitchFaultWorkerPanic}
			} else {
				entry.AllowedFaultCodes = []AgentSwitchFaultCode{AgentSwitchFaultShutdownWorkersTimedOut}
			}
		case "maintenance":
			entry.AllowedErrorCodes = append([]AgentSwitchErrorCode(nil), allErrors...)
			entry.AllowedFaultCodes = []AgentSwitchFaultCode{AgentSwitchFaultTerminalCleanupFailed}
		case "visibility":
			entry.AllowedErrorCodes = []AgentSwitchErrorCode{AgentSwitchErrorNotApplicable}
			entry.AllowedFaultCodes = []AgentSwitchFaultCode{AgentSwitchFaultNotApplicable}
		}
		taxonomy[point] = entry
	}
	return taxonomy
}

type AgentSwitchStackFrame struct {
	Package  string `json:"package"`
	Function string `json:"function"`
	Filename string `json:"filename"`
	Line     int    `json:"line"`
}

type AgentSwitchFault struct {
	ReportKind           AgentSwitchReportKind
	FailurePoint         AgentSwitchFailurePoint
	ClassifierCallsite   AgentSwitchClassifierCallsite
	Phase                AgentSwitchState
	ErrorCode            AgentSwitchErrorCode
	FaultCode            AgentSwitchFaultCode
	Execution            AgentSwitchExecution
	ExecutionAttemptID   string
	Mode                 SessionMode
	FromHarness          AgentHarness
	TargetHarness        AgentHarness
	TargetStartMode      AgentSwitchTargetStartMode
	RuntimeBackend       AgentSwitchRuntimeBackend
	CallOutcome          AgentSwitchCallOutcome
	Ownership            AgentSwitchOwnership
	Compensation         AgentSwitchCompensation
	UserImpact           AgentSwitchUserImpact
	SourceStopConfirmed  AgentSwitchTriState
	TargetOwnerCommitted AgentSwitchTriState
	GateRetained         AgentSwitchTriState
	OccurredAt           time.Time
	Frames               []AgentSwitchStackFrame
}

type AgentSwitchEventBuildInput struct {
	EventID           string
	Fault             AgentSwitchFault
	Release           string
	Environment       string
	Channel           string
	Platform          string
	OS                string
	ElapsedTimeBucket string
}

type AgentSwitchFailureEvent struct {
	EventID                 string
	EnvelopeEncodingVersion int
	CanonicalEventJSON      []byte
}

var (
	agentSwitchEventIDPattern  = regexp.MustCompile(`^[0-9a-f]{32}$`)
	agentSwitchTokenPattern    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+:-]*$`)
	agentSwitchPackagePattern  = regexp.MustCompile(`^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$`)
	agentSwitchFunctionPattern = regexp.MustCompile(`^[A-Za-z0-9_.$<>*()\[\]-]+$`)
	agentSwitchFilenamePattern = regexp.MustCompile(`^[A-Za-z0-9_./$@+-]+$`)
	agentSwitchOpaqueIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$`)
	agentSwitchUUIDPattern     = regexp.MustCompile(`(?i)[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`)
)

func ValidateAgentSwitchFault(fault AgentSwitchFault) error {
	entry, ok := AgentSwitchFailureTaxonomy(fault.FailurePoint)
	if !ok {
		return fmt.Errorf("invalid agent switch failure point %q", fault.FailurePoint)
	}
	if entry.LocalOnly {
		return fmt.Errorf("agent switch failure point %q is local-only", fault.FailurePoint)
	}
	if !fault.ReportKind.valid() || !contains(entry.AllowedReportKinds, fault.ReportKind) {
		return fmt.Errorf("report kind %q is not applicable to %q", fault.ReportKind, fault.FailurePoint)
	}
	if !fault.ClassifierCallsite.valid() || fault.ClassifierCallsite != entry.ClassifierCallsite {
		return fmt.Errorf("classifier callsite %q is not applicable to %q", fault.ClassifierCallsite, fault.FailurePoint)
	}
	if !validObservedPhase(fault.Phase) || !contains(entry.AllowedPhases, fault.Phase) {
		return fmt.Errorf("phase %q is not applicable to %q", fault.Phase, fault.FailurePoint)
	}
	if !validObservedErrorCode(fault.ErrorCode) || !contains(entry.AllowedErrorCodes, fault.ErrorCode) {
		return fmt.Errorf("error code %q is not applicable to %q", fault.ErrorCode, fault.FailurePoint)
	}
	if !fault.FaultCode.valid() || !contains(entry.AllowedFaultCodes, fault.FaultCode) {
		return fmt.Errorf("fault code %q is not applicable to %q", fault.FaultCode, fault.FailurePoint)
	}
	if !fault.Execution.valid() || !validObservedMode(fault.Mode) ||
		!validObservedHarness(fault.FromHarness) || !validObservedHarness(fault.TargetHarness) ||
		!validObservedStartMode(fault.TargetStartMode) || !fault.RuntimeBackend.valid() ||
		!fault.CallOutcome.valid() || !fault.Ownership.valid() || !fault.Compensation.valid() ||
		!fault.UserImpact.valid() || !fault.SourceStopConfirmed.valid() ||
		!fault.TargetOwnerCommitted.valid() || !fault.GateRetained.valid() {
		return errors.New("agent switch fault contains an invalid enum")
	}
	if fault.OccurredAt.IsZero() {
		return errors.New("agent switch fault occurrence time is required")
	}
	if err := validateReportApplicability(fault); err != nil {
		return err
	}
	if err := validateScopeApplicability(fault); err != nil {
		return err
	}
	if err := validateAgentSwitchFrames(fault.Frames); err != nil {
		return err
	}
	if (entry.DefaultSeverity == AgentSwitchSeverityFatal || entry.DefaultSeverity == AgentSwitchSeverityError) && len(fault.Frames) == 0 {
		return errors.New("P0 and P1 internal agent switch reports require sanitized capture-site frames")
	}
	return nil
}

func validateScopeApplicability(fault AgentSwitchFault) error {
	if fault.CallOutcome == AgentSwitchCallOK || fault.CallOutcome == AgentSwitchCallExpectedRejection || fault.CallOutcome == AgentSwitchCallStale {
		return errors.New("successful, expected-rejection, and stale outcomes are not reportable")
	}
	entry, _ := AgentSwitchFailureTaxonomy(fault.FailurePoint)
	if fault.ReportKind == AgentSwitchReportDaemonLifecycleFailure {
		if fault.Mode != SessionModeNotApplicable || fault.FromHarness != HarnessNotApplicable ||
			fault.TargetHarness != HarnessNotApplicable || fault.TargetStartMode != AgentSwitchTargetStartNotApplicable ||
			fault.RuntimeBackend != AgentSwitchRuntimeNotApplicable || fault.Ownership != AgentSwitchOwnershipNotApplicable ||
			fault.Compensation != AgentSwitchCompensationNotApplicable || fault.UserImpact != AgentSwitchUserImpactNotApplicable ||
			fault.SourceStopConfirmed != AgentSwitchTriNotApplicable || fault.TargetOwnerCommitted != AgentSwitchTriNotApplicable ||
			fault.GateRetained != AgentSwitchTriNotApplicable {
			return errors.New("daemon lifecycle report contains switch-only facts")
		}
		return nil
	}
	if fault.ReportKind == AgentSwitchReportVisibilityFailure {
		if fault.Mode != SessionModeNotApplicable || fault.FromHarness != HarnessNotApplicable ||
			fault.TargetHarness != HarnessNotApplicable || fault.TargetStartMode != AgentSwitchTargetStartNotApplicable ||
			fault.RuntimeBackend != AgentSwitchRuntimeNotApplicable || fault.Ownership != AgentSwitchOwnershipNotApplicable ||
			fault.Compensation != AgentSwitchCompensationNotApplicable ||
			fault.SourceStopConfirmed != AgentSwitchTriNotApplicable || fault.TargetOwnerCommitted != AgentSwitchTriNotApplicable ||
			fault.GateRetained != AgentSwitchTriNotApplicable {
			return errors.New("visibility report contains daemon-only switch facts")
		}
		return nil
	}
	if fault.ReportKind != AgentSwitchReportVisibilityFailure {
		if !fault.Mode.Valid() || !fault.FromHarness.IsKnown() || !fault.TargetHarness.IsKnown() ||
			fault.Ownership == AgentSwitchOwnershipNotApplicable || fault.Compensation == AgentSwitchCompensationNotApplicable ||
			fault.UserImpact == AgentSwitchUserImpactNotApplicable {
			return errors.New("switch-scoped report requires applicable mode, harness, ownership, compensation, and impact")
		}
		if fault.RuntimeBackend == AgentSwitchRuntimeChatController && fault.Mode != SessionModeChat {
			return errors.New("chat controller backend requires chat mode")
		}
		if (fault.RuntimeBackend == AgentSwitchRuntimeTMUX || fault.RuntimeBackend == AgentSwitchRuntimeConPTY) && fault.Mode != SessionModeTUI {
			return errors.New("terminal runtime backend requires TUI mode")
		}
	}
	targetScoped := entry.Subsystem == "tui_target_start" || entry.Subsystem == "chat_target_start" || entry.Subsystem == "delivery" ||
		fault.Phase == AgentSwitchStartingTarget || fault.Phase == AgentSwitchTargetReady || fault.Phase == AgentSwitchDelivering
	if targetScoped {
		if fault.TargetStartMode != AgentSwitchTargetStartFresh && fault.TargetStartMode != AgentSwitchTargetStartResumed {
			return errors.New("target-scoped report requires a resolved target start mode")
		}
		if fault.RuntimeBackend == AgentSwitchRuntimeNotApplicable {
			return errors.New("target-scoped report requires a runtime backend")
		}
		if fault.SourceStopConfirmed == AgentSwitchTriNotApplicable || fault.TargetOwnerCommitted == AgentSwitchTriNotApplicable ||
			fault.GateRetained == AgentSwitchTriNotApplicable {
			return errors.New("target-scoped report requires source-stop, target-owner, and gate facts")
		}
	}
	sourceScoped := entry.Subsystem == "source_stop" || fault.Phase == AgentSwitchStoppingSource || fault.Phase == AgentSwitchSourceStopped
	if sourceScoped && (fault.SourceStopConfirmed == AgentSwitchTriNotApplicable || fault.GateRetained == AgentSwitchTriNotApplicable) {
		return errors.New("source-scoped report requires source-stop and gate facts")
	}
	if fault.ReportKind == AgentSwitchReportPanic {
		if fault.ExecutionAttemptID == "" || len(fault.ExecutionAttemptID) > 128 || !agentSwitchTokenPattern.MatchString(fault.ExecutionAttemptID) {
			return errors.New("panic report requires a bounded opaque execution ID")
		}
	}
	return nil
}

func validateReportApplicability(fault AgentSwitchFault) error {
	switch fault.ReportKind {
	case AgentSwitchReportTerminalFailure:
		if fault.ErrorCode == AgentSwitchErrorNotApplicable || fault.ErrorCode == "" || fault.ErrorCode.RetainedRecoveryMarker() || fault.FaultCode != AgentSwitchFaultNotApplicable {
			return errors.New("terminal failure requires a non-retained semantic error and no operational fault code")
		}
	case AgentSwitchReportRecoveryRequired:
		if !fault.ErrorCode.RetainedRecoveryMarker() || fault.FaultCode != AgentSwitchFaultNotApplicable {
			return errors.New("recovery-required report requires a retained recovery marker")
		}
		if !validRecoveryMarkerPhase(fault.Phase, fault.ErrorCode) {
			return errors.New("recovery marker is not applicable to the durable phase")
		}
	case AgentSwitchReportPanic:
		if fault.ErrorCode != AgentSwitchErrorNotApplicable || fault.FaultCode != AgentSwitchFaultWorkerPanic || fault.CallOutcome != AgentSwitchCallPanic || len(fault.Frames) == 0 {
			return errors.New("panic report requires worker_panic, panic outcome, and sanitized frames")
		}
	case AgentSwitchReportRecoveryAttemptFailed:
		if fault.FaultCode != AgentSwitchFaultRecoveryUnresolved || fault.Phase.Terminal() || fault.Phase == AgentSwitchStateNotApplicable {
			return errors.New("recovery-attempt report requires an unresolved nonterminal switch")
		}
		if fault.ErrorCode.RetainedRecoveryMarker() && !validRecoveryMarkerPhase(fault.Phase, fault.ErrorCode) {
			return errors.New("recovery-attempt marker is not applicable to the durable phase")
		}
	case AgentSwitchReportMaintenanceFailure:
		if fault.FaultCode != AgentSwitchFaultTerminalCleanupFailed || !fault.Phase.Terminal() {
			return errors.New("maintenance report requires terminal cleanup failure")
		}
		if fault.Phase == AgentSwitchCompleted && fault.ErrorCode != AgentSwitchErrorNotApplicable {
			return errors.New("completed-switch maintenance cannot carry a semantic error")
		}
		if fault.Phase == AgentSwitchFailed && (fault.ErrorCode == AgentSwitchErrorNotApplicable || fault.ErrorCode.RetainedRecoveryMarker()) {
			return errors.New("failed-switch maintenance requires its real terminal semantic error")
		}
	case AgentSwitchReportDaemonLifecycleFailure:
		if fault.ErrorCode != AgentSwitchErrorNotApplicable || fault.FaultCode != AgentSwitchFaultShutdownWorkersTimedOut || fault.Phase != AgentSwitchStateNotApplicable || fault.Execution != AgentSwitchExecutionDaemonShutdown {
			return errors.New("daemon lifecycle report requires shutdown timeout applicability")
		}
	case AgentSwitchReportVisibilityFailure:
		if fault.ErrorCode != AgentSwitchErrorNotApplicable || fault.FaultCode != AgentSwitchFaultNotApplicable || fault.UserImpact != AgentSwitchUserImpactVisibilityImpaired {
			return errors.New("visibility report requires visibility-only applicability")
		}
	default:
		return errors.New("not-applicable reports cannot be serialized")
	}
	return nil
}

func validRecoveryMarkerPhase(phase AgentSwitchState, code AgentSwitchErrorCode) bool {
	switch code {
	case AgentSwitchErrorSourceStopUnconfirmed:
		return phase == AgentSwitchStoppingSource
	case AgentSwitchErrorSourceRestoreUnconfirmed:
		return phase == AgentSwitchSourceStopped || phase == AgentSwitchStartingTarget
	case AgentSwitchErrorTargetStartUnconfirmed:
		return phase == AgentSwitchStartingTarget
	default:
		return false
	}
}

func validObservedPhase(phase AgentSwitchState) bool {
	return phase.Valid() || phase == AgentSwitchStateNotApplicable
}

func validObservedErrorCode(code AgentSwitchErrorCode) bool {
	return (code != "" && code.Valid()) || code == AgentSwitchErrorNotApplicable
}

func validObservedMode(mode SessionMode) bool {
	return mode.Valid() || mode == SessionModeNotApplicable
}

func validObservedHarness(h AgentHarness) bool {
	return h.IsKnown() || h == HarnessFake || h == HarnessNotApplicable
}

func validObservedStartMode(mode AgentSwitchTargetStartMode) bool {
	return mode == AgentSwitchTargetStartFresh || mode == AgentSwitchTargetStartResumed ||
		mode == AgentSwitchTargetStartReportedPending || mode == AgentSwitchTargetStartNotApplicable
}

func validateAgentSwitchFrames(frames []AgentSwitchStackFrame) error {
	canonicalFrames := make([]canonicalAgentSwitchFrame, len(frames))
	for i, frame := range frames {
		if frame.Package == "" || len(frame.Package) > 128 || !agentSwitchPackagePattern.MatchString(frame.Package) || containsSensitiveFreeString(frame.Package) {
			return errors.New("stack frame package is not privacy-safe")
		}
		if frame.Function == "" || len(frame.Function) > 128 || !agentSwitchFunctionPattern.MatchString(frame.Function) || containsSensitiveFreeString(frame.Function) {
			return errors.New("stack frame function is not privacy-safe")
		}
		if frame.Filename == "" || len(frame.Filename) > 512 || frame.Line <= 0 ||
			!agentSwitchFilenamePattern.MatchString(frame.Filename) || containsSensitiveFreeString(frame.Filename) ||
			strings.Contains(frame.Filename, `\`) || strings.Contains(frame.Filename, "://") ||
			path.IsAbs(frame.Filename) || path.Clean(frame.Filename) != frame.Filename ||
			strings.HasPrefix(frame.Filename, "../") {
			return errors.New("stack frame filename must be repository-relative")
		}
		canonicalFrames[i] = canonicalAgentSwitchFrame{
			Module: frame.Package, Function: frame.Function,
			Filename: frame.Filename, Lineno: frame.Line, InApp: true,
		}
	}
	raw, err := json.Marshal(canonicalFrames)
	if err != nil {
		return fmt.Errorf("marshal sanitized stack: %w", err)
	}
	if len(raw) > agentSwitchStackMaxBytes {
		return errors.New("sanitized stack exceeds 16 KiB")
	}
	return nil
}

func BuildAgentSwitchCanonicalEvent(input AgentSwitchEventBuildInput) ([]byte, error) {
	if !agentSwitchEventIDPattern.MatchString(input.EventID) {
		return nil, errors.New("event ID must be exactly 32 lowercase hexadecimal characters")
	}
	if err := ValidateAgentSwitchFault(input.Fault); err != nil {
		return nil, err
	}
	if err := validateEventMetadata("release", input.Release, AgentSwitchCanonicalEventMaxBytes); err != nil {
		return nil, err
	}
	metadata := []struct{ name, value string }{
		{"environment", input.Environment}, {"channel", input.Channel},
		{"platform", input.Platform}, {"os", input.OS}, {"elapsed time bucket", input.ElapsedTimeBucket},
	}
	for _, field := range metadata {
		if err := validateEventMetadata(field.name, field.value, 128); err != nil {
			return nil, err
		}
	}

	entry, _ := AgentSwitchFailureTaxonomy(input.Fault.FailurePoint)
	frames := make([]canonicalAgentSwitchFrame, len(input.Fault.Frames))
	for i, frame := range input.Fault.Frames {
		frames[i] = canonicalAgentSwitchFrame{
			Module: frame.Package, Function: frame.Function,
			Filename: frame.Filename, Lineno: frame.Line, InApp: true,
		}
	}
	event := canonicalAgentSwitchEvent{
		EventID:   input.EventID,
		Timestamp: input.Fault.OccurredAt.UTC().Format(time.RFC3339Nano),
		Message:   "Agent switch failed: " + string(input.Fault.Mode) + " / " + string(input.Fault.Phase) + " / " + string(input.Fault.FailurePoint),
		Level:     string(severityForFault(input.Fault, entry.DefaultSeverity)),
		Platform:  input.Platform, Environment: input.Environment, Release: input.Release,
		Exception: canonicalAgentSwitchExceptions{Values: []canonicalAgentSwitchException{{
			Type: "AgentSwitchFailure", Value: "agent switch failure: " + eventFailureCode(input.Fault) + " at " + string(input.Fault.FailurePoint),
			Stacktrace: canonicalAgentSwitchStacktrace{Frames: frames},
		}}},
		Fingerprint: AgentSwitchIssueFingerprint(input.Fault),
		Tags: canonicalAgentSwitchTags{
			Feature: "agent_switching", Platform: input.Platform,
			ReportKind: input.Fault.ReportKind, Subsystem: entry.Subsystem,
			Mode: input.Fault.Mode, Phase: input.Fault.Phase,
			FailurePoint: input.Fault.FailurePoint, ErrorCode: input.Fault.ErrorCode,
			FaultCode: input.Fault.FaultCode, Execution: input.Fault.Execution,
			FromHarness: input.Fault.FromHarness, TargetHarness: input.Fault.TargetHarness,
			TargetStartMode: input.Fault.TargetStartMode, RuntimeBackend: input.Fault.RuntimeBackend,
			CallOutcome: input.Fault.CallOutcome, Ownership: input.Fault.Ownership,
			Compensation: input.Fault.Compensation, UserImpact: input.Fault.UserImpact,
			Release: input.Release, ClassifierCallsite: input.Fault.ClassifierCallsite,
			Channel: input.Channel, OS: input.OS,
		},
		Contexts: canonicalAgentSwitchContexts{AgentSwitch: canonicalAgentSwitchContext{
			SourceStopConfirmed:  input.Fault.SourceStopConfirmed,
			TargetOwnerCommitted: input.Fault.TargetOwnerCommitted,
			GateRetained:         input.Fault.GateRetained,
			ElapsedTimeBucket:    input.ElapsedTimeBucket,
		}},
	}
	raw, err := json.Marshal(event)
	if err != nil {
		return nil, fmt.Errorf("marshal canonical agent switch event: %w", err)
	}
	if len(raw) > AgentSwitchCanonicalEventMaxBytes {
		return nil, errors.New("canonical agent switch event exceeds 60 KiB")
	}
	return raw, nil
}

func validateEventMetadata(name, value string, max int) error {
	if value == "" || len(value) > max || !agentSwitchTokenPattern.MatchString(value) || containsSensitiveFreeString(value) {
		return fmt.Errorf("%s is not a bounded privacy-safe token", name)
	}
	return nil
}

func containsSensitiveFreeString(value string) bool {
	lower := strings.ToLower(value)
	if agentSwitchUUIDPattern.MatchString(value) {
		return true
	}
	for _, forbidden := range []string{
		"session-", "switch-", "idempotency", "runtime-handle", "provider-conversation",
		"prompt text", "://", "/users/", `c:\users\`, "../", "..\\",
	} {
		if strings.Contains(lower, forbidden) {
			return true
		}
	}
	return false
}

type AgentSwitchDedupeScope struct {
	SwitchID    AgentSwitchID
	DaemonRunID string
}

func AgentSwitchDedupeKey(scope AgentSwitchDedupeScope, fault AgentSwitchFault) (string, error) {
	if err := ValidateAgentSwitchFault(fault); err != nil {
		return "", fmt.Errorf("invalid fault for dedupe: %w", err)
	}
	validateID := func(name, value string) error {
		if !agentSwitchOpaqueIDPattern.MatchString(value) {
			return fmt.Errorf("%s must be a bounded opaque identifier", name)
		}
		return nil
	}
	code := eventFailureCode(fault)
	switch fault.ReportKind {
	case AgentSwitchReportTerminalFailure, AgentSwitchReportRecoveryRequired:
		if err := validateID("switch ID", string(scope.SwitchID)); err != nil || scope.DaemonRunID != "" {
			return "", errors.New("semantic switch dedupe requires only a valid switch ID")
		}
		return strings.Join([]string{"v1", string(scope.SwitchID), string(fault.ReportKind), string(fault.FailurePoint), string(fault.Phase), code}, "|"), nil
	case AgentSwitchReportPanic:
		if err := validateID("switch ID", string(scope.SwitchID)); err != nil || scope.DaemonRunID != "" ||
			validateID("execution attempt ID", fault.ExecutionAttemptID) != nil {
			return "", errors.New("panic dedupe requires a valid switch and execution-attempt ID")
		}
		return strings.Join([]string{"v1", string(scope.SwitchID), "panic", fault.ExecutionAttemptID, string(fault.FailurePoint), string(fault.Phase), string(fault.FaultCode)}, "|"), nil
	case AgentSwitchReportRecoveryAttemptFailed:
		if err := validateID("switch ID", string(scope.SwitchID)); err != nil || scope.DaemonRunID != "" {
			return "", errors.New("recovery dedupe requires only a valid switch ID")
		}
		return strings.Join([]string{"v1", string(scope.SwitchID), "recovery_attempt_failed", string(fault.Phase), string(fault.ErrorCode), string(fault.FailurePoint), string(fault.FaultCode)}, "|"), nil
	case AgentSwitchReportMaintenanceFailure:
		if err := validateID("switch ID", string(scope.SwitchID)); err != nil {
			return "", err
		}
		if err := validateID("daemon run ID", scope.DaemonRunID); err != nil {
			return "", err
		}
		return strings.Join([]string{"v1", string(scope.SwitchID), "maintenance_failure", scope.DaemonRunID, string(fault.FailurePoint), string(fault.FaultCode)}, "|"), nil
	case AgentSwitchReportDaemonLifecycleFailure:
		if scope.SwitchID != "" {
			return "", errors.New("daemon lifecycle dedupe cannot carry a switch ID")
		}
		if err := validateID("daemon run ID", scope.DaemonRunID); err != nil {
			return "", err
		}
		return strings.Join([]string{"v1", scope.DaemonRunID, "daemon_lifecycle_failure", string(fault.FailurePoint), string(fault.FaultCode)}, "|"), nil
	default:
		return "", fmt.Errorf("report kind %q has no durable agent-switch dedupe formula", fault.ReportKind)
	}
}

func AgentSwitchIssueFingerprint(fault AgentSwitchFault) []string {
	if fault.ReportKind == AgentSwitchReportPanic {
		topFunction := "not_applicable"
		if len(fault.Frames) > 0 {
			topFunction = fault.Frames[0].Function
		}
		return []string{"agent-switch", "panic", string(fault.Mode), string(fault.Phase), string(fault.FailurePoint), topFunction}
	}
	return []string{"agent-switch", "v1", string(fault.ReportKind), string(fault.Mode), string(fault.Phase), string(fault.FailurePoint), eventFailureCode(fault)}
}

func eventFailureCode(fault AgentSwitchFault) string {
	if fault.ErrorCode != AgentSwitchErrorNotApplicable && fault.ErrorCode != "" {
		return string(fault.ErrorCode)
	}
	return string(fault.FaultCode)
}

func severityForFault(fault AgentSwitchFault, fallback AgentSwitchSeverity) AgentSwitchSeverity {
	if fault.Ownership == AgentSwitchOwnershipAmbiguous ||
		(fault.TargetOwnerCommitted == AgentSwitchTriTrue && fault.Ownership != AgentSwitchOwnershipTarget) {
		return AgentSwitchSeverityFatal
	}
	if fault.UserImpact == AgentSwitchUserImpactNoLiveOwner || fault.UserImpact == AgentSwitchUserImpactDeliveryUnknown ||
		fault.GateRetained == AgentSwitchTriTrue {
		return AgentSwitchSeverityError
	}
	return fallback
}

func contains[T comparable](values []T, target T) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

type canonicalAgentSwitchEvent struct {
	EventID     string                         `json:"event_id"`
	Timestamp   string                         `json:"timestamp"`
	Message     string                         `json:"message"`
	Level       string                         `json:"level"`
	Platform    string                         `json:"platform"`
	Environment string                         `json:"environment"`
	Release     string                         `json:"release"`
	Exception   canonicalAgentSwitchExceptions `json:"exception"`
	Fingerprint []string                       `json:"fingerprint"`
	Tags        canonicalAgentSwitchTags       `json:"tags"`
	Contexts    canonicalAgentSwitchContexts   `json:"contexts"`
}

type canonicalAgentSwitchExceptions struct {
	Values []canonicalAgentSwitchException `json:"values"`
}

type canonicalAgentSwitchException struct {
	Type       string                         `json:"type"`
	Value      string                         `json:"value"`
	Stacktrace canonicalAgentSwitchStacktrace `json:"stacktrace"`
}

type canonicalAgentSwitchStacktrace struct {
	Frames []canonicalAgentSwitchFrame `json:"frames"`
}

type canonicalAgentSwitchFrame struct {
	Module   string `json:"module"`
	Function string `json:"function"`
	Filename string `json:"filename"`
	Lineno   int    `json:"lineno"`
	InApp    bool   `json:"in_app"`
}

type canonicalAgentSwitchTags struct {
	Feature            string                        `json:"feature"`
	Platform           string                        `json:"platform"`
	ReportKind         AgentSwitchReportKind         `json:"report_kind"`
	Subsystem          string                        `json:"subsystem"`
	Mode               SessionMode                   `json:"mode"`
	Phase              AgentSwitchState              `json:"phase"`
	FailurePoint       AgentSwitchFailurePoint       `json:"failure_point"`
	ErrorCode          AgentSwitchErrorCode          `json:"error_code"`
	FaultCode          AgentSwitchFaultCode          `json:"fault_code"`
	Execution          AgentSwitchExecution          `json:"execution"`
	FromHarness        AgentHarness                  `json:"from_harness"`
	TargetHarness      AgentHarness                  `json:"target_harness"`
	TargetStartMode    AgentSwitchTargetStartMode    `json:"target_start_mode"`
	RuntimeBackend     AgentSwitchRuntimeBackend     `json:"runtime_backend"`
	CallOutcome        AgentSwitchCallOutcome        `json:"call_outcome"`
	Ownership          AgentSwitchOwnership          `json:"ownership"`
	Compensation       AgentSwitchCompensation       `json:"compensation"`
	UserImpact         AgentSwitchUserImpact         `json:"user_impact"`
	Release            string                        `json:"release"`
	ClassifierCallsite AgentSwitchClassifierCallsite `json:"classifier_callsite"`
	Channel            string                        `json:"channel"`
	OS                 string                        `json:"os"`
}

type canonicalAgentSwitchContexts struct {
	AgentSwitch canonicalAgentSwitchContext `json:"agent_switch"`
}

type canonicalAgentSwitchContext struct {
	SourceStopConfirmed  AgentSwitchTriState `json:"source_stop_confirmed"`
	TargetOwnerCommitted AgentSwitchTriState `json:"target_owner_committed"`
	GateRetained         AgentSwitchTriState `json:"gate_retained"`
	ElapsedTimeBucket    string              `json:"elapsed_time_bucket"`
}

// StableAgentSwitchEventID derives a Sentry-compatible EventID from an opaque
// local incident key. It exists so retries and response-loss use one identity.
func StableAgentSwitchEventID(dedupeKey string) string {
	digest := sha256.Sum256([]byte(dedupeKey))
	return hex.EncodeToString(digest[:16])
}

// AgentSwitchStackFingerprint is a stable, non-identifying grouping fact over
// already-sanitized frames.
func AgentSwitchStackFingerprint(frames []AgentSwitchStackFrame) string {
	hash := sha256.New()
	for _, frame := range frames {
		hash.Write([]byte(frame.Package))
		hash.Write([]byte{0})
		hash.Write([]byte(frame.Function))
		hash.Write([]byte{0})
		hash.Write([]byte(frame.Filename))
		hash.Write([]byte{0})
		hash.Write([]byte(strconv.Itoa(frame.Line)))
		hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil))
}
