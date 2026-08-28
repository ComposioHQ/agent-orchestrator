package domain

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestAgentSwitchFailureTaxonomyIsComplete(t *testing.T) {
	expected := []AgentSwitchFailurePoint{
		AgentSwitchFailureAdmissionChatHandoffArm,
		AgentSwitchFailureAdmissionCommitReadback,
		AgentSwitchFailureAdmissionSagaCreate,
		AgentSwitchFailureChatContinuationRelay,
		AgentSwitchFailureChatControllerPublish,
		AgentSwitchFailureChatNativeIdentityCommit,
		AgentSwitchFailureChatProviderBoundaryCommit,
		AgentSwitchFailureChatProviderResume,
		AgentSwitchFailureChatProviderStart,
		AgentSwitchFailureChatSourceQuiesce,
		AgentSwitchFailureChatTargetAckCommit,
		AgentSwitchFailureChatTargetActivationCommit,
		AgentSwitchFailureChatTargetActivationReadback,
		AgentSwitchFailureClassificationUnknown,
		AgentSwitchFailureCompletionCommit,
		AgentSwitchFailureContinuationBuild,
		AgentSwitchFailureDecisionInputClose,
		AgentSwitchFailureDeliveryOpenCommit,
		AgentSwitchFailureFinalArtifactCommit,
		AgentSwitchFailureFinalArtifactPublish,
		AgentSwitchFailureFinalArtifactVerify,
		AgentSwitchFailureHandoffCollection,
		AgentSwitchFailureHandoffDirectoryPrepare,
		AgentSwitchFailureHandoffSettlement,
		AgentSwitchFailureLiveWorkerPanic,
		AgentSwitchFailureOutboxDelivery,
		AgentSwitchFailureRecoveryActivation,
		AgentSwitchFailureRecoveryArtifactVerify,
		AgentSwitchFailureRecoveryExistingMarker,
		AgentSwitchFailureRecoveryNativeIdentity,
		AgentSwitchFailureRecoveryRuntimeProbe,
		AgentSwitchFailureRecoverySessionLoad,
		AgentSwitchFailureRecoverySettlement,
		AgentSwitchFailureRecoveryWorkerPanic,
		AgentSwitchFailureSemanticArtifactVerify,
		AgentSwitchFailureShutdownWorkerTimeout,
		AgentSwitchFailureSourceControllerDrain,
		AgentSwitchFailureSourceControllerRestore,
		AgentSwitchFailureSourceControllerStop,
		AgentSwitchFailureSourceHandoffInterrupt,
		AgentSwitchFailureSourceMetadataRefresh,
		AgentSwitchFailureSourceNativePreserve,
		AgentSwitchFailureSourceRuntimeDestroy,
		AgentSwitchFailureSourceRuntimeProbe,
		AgentSwitchFailureSourceRuntimeRestore,
		AgentSwitchFailureSourceStopCommit,
		AgentSwitchFailureSourceStopReadback,
		AgentSwitchFailureSourceTranscriptCapture,
		AgentSwitchFailureStoppingSourceCommit,
		AgentSwitchFailureTargetActivationCommit,
		AgentSwitchFailureTargetActivationReadback,
		AgentSwitchFailureTargetGenerationProbe,
		AgentSwitchFailureTargetHandleCommit,
		AgentSwitchFailureTargetLaunchGatePrepare,
		AgentSwitchFailureTargetNativeCommit,
		AgentSwitchFailureTargetNativeIdentityWait,
		AgentSwitchFailureTargetNativePrepare,
		AgentSwitchFailureTargetPreflight,
		AgentSwitchFailureTargetPromptPrepare,
		AgentSwitchFailureTargetResumeLookup,
		AgentSwitchFailureTargetRuntimeCleanup,
		AgentSwitchFailureTargetRuntimeCreate,
		AgentSwitchFailureTargetWorkspaceCleanup,
		AgentSwitchFailureTargetWorkspacePrepare,
		AgentSwitchFailureTerminalArtifactCleanup,
		AgentSwitchFailureTUITargetAckCommit,
		AgentSwitchFailureTUITargetHookWait,
		AgentSwitchFailureVisibilityPresentation,
		AgentSwitchFailureVisibilityQuery,
		AgentSwitchFailureVisibilityTransport,
		AgentSwitchFailureWorkerStartRefused,
	}
	sort.Slice(expected, func(i, j int) bool { return expected[i] < expected[j] })

	points := AllAgentSwitchFailurePoints()
	require.Equal(t, expected, points)
	require.True(t, sort.SliceIsSorted(points, func(i, j int) bool { return points[i] < points[j] }))
	require.Len(t, points, len(expected))

	for _, point := range points {
		entry, ok := AgentSwitchFailureTaxonomy(point)
		require.Truef(t, ok, "missing taxonomy for %s", point)
		require.NotEmpty(t, entry.Subsystem)
		require.NotEmpty(t, entry.AllowedPhases)
		require.NotEmpty(t, entry.AllowedReportKinds)
		require.NotEmpty(t, entry.AllowedErrorCodes)
		require.NotEmpty(t, entry.AllowedFaultCodes)
		require.NotEmpty(t, entry.ClassifierCallsite)
		require.NotEmpty(t, entry.Title)
		require.NotEmpty(t, entry.RunbookAnchor)
		require.True(t, entry.DefaultSeverity.Valid())
		if point == AgentSwitchFailureOutboxDelivery || point == AgentSwitchFailureClassificationUnknown {
			require.True(t, entry.LocalOnly)
			require.Equal(t, AgentSwitchReportNotApplicable, entry.ReportKind)
		} else {
			require.False(t, entry.LocalOnly)
			require.NotEqual(t, AgentSwitchReportNotApplicable, entry.ReportKind)
		}
	}

	_, ok := AgentSwitchFailureTaxonomy(AgentSwitchFailurePoint("not-approved"))
	require.False(t, ok)
}

func TestAllAgentSwitchFailurePointsReturnsACopy(t *testing.T) {
	first := AllAgentSwitchFailurePoints()
	require.NotEmpty(t, first)
	first[0] = AgentSwitchFailurePoint("mutated-by-caller")
	second := AllAgentSwitchFailurePoints()
	require.NotEqual(t, first[0], second[0])
	require.NotContains(t, second, AgentSwitchFailurePoint("mutated-by-caller"))

	entry, ok := AgentSwitchFailureTaxonomy(AgentSwitchFailureTargetRuntimeCreate)
	require.True(t, ok)
	entry.AllowedPhases[0] = AgentSwitchState("mutated-by-caller")
	fresh, ok := AgentSwitchFailureTaxonomy(AgentSwitchFailureTargetRuntimeCreate)
	require.True(t, ok)
	require.NotContains(t, fresh.AllowedPhases, AgentSwitchState("mutated-by-caller"))
}

func TestAgentSwitchReportingVocabularyIsExact(t *testing.T) {
	require.Equal(t, AgentSwitchReportingAuthorization{
		Enabled:                true,
		ConsentGeneration:      "generation-token",
		DestinationFingerprint: "destination-fingerprint",
	}, AgentSwitchReportingAuthorization{true, "generation-token", "destination-fingerprint"})
	require.Equal(t, []AgentSwitchEnrollmentStatus{
		AgentSwitchEnrollmentEnrolled,
		AgentSwitchEnrollmentDisabled,
		AgentSwitchEnrollmentStaleGeneration,
		AgentSwitchEnrollmentDeduped,
		AgentSwitchEnrollmentLocalInvariantFailed,
	}, AllAgentSwitchEnrollmentStatuses())
	require.False(t, AgentSwitchFailureProductionEnabled)
}

func TestAgentSwitchFaultAndEventShapesAreClosed(t *testing.T) {
	assertStructFields(t, reflect.TypeOf(AgentSwitchFault{}), []string{
		"ReportKind", "FailurePoint", "ClassifierCallsite", "Phase", "ErrorCode", "FaultCode",
		"Execution", "ExecutionAttemptID", "Mode", "FromHarness", "TargetHarness", "TargetStartMode",
		"RuntimeBackend", "CallOutcome", "Ownership", "Compensation", "UserImpact",
		"SourceStopConfirmed", "TargetOwnerCommitted", "GateRetained", "OccurredAt", "Frames",
	})
	assertStructFields(t, reflect.TypeOf(AgentSwitchEventBuildInput{}), []string{
		"EventID", "Fault", "Release", "Environment", "Channel", "Platform", "OS", "ElapsedTimeBucket",
	})
	assertStructFields(t, reflect.TypeOf(AgentSwitchFailureEvent{}), []string{
		"EventID", "EnvelopeEncodingVersion", "CanonicalEventJSON",
	})
	for _, typ := range []reflect.Type{reflect.TypeOf(AgentSwitchFault{}), reflect.TypeOf(AgentSwitchEventBuildInput{})} {
		for i := 0; i < typ.NumField(); i++ {
			require.False(t, typ.Field(i).Type.Implements(reflect.TypeOf((*error)(nil)).Elem()), "raw errors must be impossible to pass")
		}
	}
}

func TestValidateAgentSwitchFaultRejectsEveryInvalidEnum(t *testing.T) {
	tests := map[string]func(*AgentSwitchFault){
		"report kind":               func(f *AgentSwitchFault) { f.ReportKind = "invalid" },
		"failure point":             func(f *AgentSwitchFault) { f.FailurePoint = "invalid" },
		"classifier callsite":       func(f *AgentSwitchFault) { f.ClassifierCallsite = "invalid" },
		"phase":                     func(f *AgentSwitchFault) { f.Phase = "invalid" },
		"error code":                func(f *AgentSwitchFault) { f.ErrorCode = "invalid" },
		"fault code":                func(f *AgentSwitchFault) { f.FaultCode = "invalid" },
		"execution":                 func(f *AgentSwitchFault) { f.Execution = "invalid" },
		"mode":                      func(f *AgentSwitchFault) { f.Mode = "invalid" },
		"from harness":              func(f *AgentSwitchFault) { f.FromHarness = "invalid" },
		"target harness":            func(f *AgentSwitchFault) { f.TargetHarness = "invalid" },
		"target start mode":         func(f *AgentSwitchFault) { f.TargetStartMode = "invalid" },
		"runtime backend":           func(f *AgentSwitchFault) { f.RuntimeBackend = "invalid" },
		"call outcome":              func(f *AgentSwitchFault) { f.CallOutcome = "invalid" },
		"ownership":                 func(f *AgentSwitchFault) { f.Ownership = "invalid" },
		"compensation":              func(f *AgentSwitchFault) { f.Compensation = "invalid" },
		"user impact":               func(f *AgentSwitchFault) { f.UserImpact = "invalid" },
		"source stop confirmed":     func(f *AgentSwitchFault) { f.SourceStopConfirmed = "invalid" },
		"target owner committed":    func(f *AgentSwitchFault) { f.TargetOwnerCommitted = "invalid" },
		"gate retained":             func(f *AgentSwitchFault) { f.GateRetained = "invalid" },
		"zero occurrence timestamp": func(f *AgentSwitchFault) { f.OccurredAt = time.Time{} },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			fault := completeSafeFaultFixture()
			mutate(&fault)
			require.Error(t, ValidateAgentSwitchFault(fault))
		})
	}
}

func TestValidateAgentSwitchFaultEnforcesApplicability(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*AgentSwitchFault)
	}{
		{"local-only point cannot serialize", func(f *AgentSwitchFault) { f.FailurePoint = AgentSwitchFailureOutboxDelivery }},
		{"wrong classifier", func(f *AgentSwitchFault) { f.ClassifierCallsite = AgentSwitchClassifierVisibility }},
		{"wrong phase", func(f *AgentSwitchFault) { f.Phase = AgentSwitchPreparingHandoff }},
		{"semantic report requires semantic error", func(f *AgentSwitchFault) { f.ErrorCode = AgentSwitchErrorNotApplicable }},
		{"semantic report forbids operational fault", func(f *AgentSwitchFault) { f.FaultCode = AgentSwitchFaultWorkerPanic }},
		{"recovery marker requires nonterminal report", func(f *AgentSwitchFault) {
			f.ReportKind = AgentSwitchReportRecoveryRequired
			f.ErrorCode = AgentSwitchErrorTargetStartUnconfirmed
			f.Phase = AgentSwitchFailed
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fault := completeSafeFaultFixture()
			tc.mutate(&fault)
			require.Error(t, ValidateAgentSwitchFault(fault))
		})
	}

	panicFault := completeSafeFaultFixture()
	panicFault.ReportKind = AgentSwitchReportPanic
	panicFault.FailurePoint = AgentSwitchFailureLiveWorkerPanic
	panicFault.ClassifierCallsite = AgentSwitchClassifierLiveWorkerPanic
	panicFault.Phase = AgentSwitchStartingTarget
	panicFault.ErrorCode = AgentSwitchErrorNotApplicable
	panicFault.FaultCode = AgentSwitchFaultWorkerPanic
	panicFault.CallOutcome = AgentSwitchCallPanic
	require.NoError(t, ValidateAgentSwitchFault(panicFault))
}

func TestValidateAgentSwitchFaultRejectsUnsafeFramesAndStackOverBound(t *testing.T) {
	tests := []AgentSwitchStackFrame{
		{Package: "internal/session_manager", Function: "execute", Filename: "/Users/alice/reverb/file.go", Line: 1},
		{Package: "internal/session_manager", Function: "execute", Filename: "../secret.go", Line: 1},
		{Package: "internal/session manager", Function: "execute", Filename: "backend/file.go", Line: 1},
		{Package: "internal/session_manager", Function: "execute(args)", Filename: "backend/file.go", Line: 1},
		{Package: "internal/session_manager", Function: "execute", Filename: "backend/file.go", Line: 0},
	}
	for _, frame := range tests {
		fault := completeSafeFaultFixture()
		fault.Frames = []AgentSwitchStackFrame{frame}
		require.Error(t, ValidateAgentSwitchFault(fault))
	}

	fault := completeSafeFaultFixture()
	fault.Frames = make([]AgentSwitchStackFrame, 300)
	for i := range fault.Frames {
		fault.Frames[i] = AgentSwitchStackFrame{
			Package:  "internal/session_manager",
			Function: "executeAgentSwitchWithAnIntentionallyLongSafeFunctionName",
			Filename: "backend/internal/session_manager/agent_switching.go",
			Line:     i + 1,
		}
	}
	require.ErrorContains(t, ValidateAgentSwitchFault(fault), "16 KiB")
}

func TestBuildAgentSwitchCanonicalEventMatchesFrozenFixture(t *testing.T) {
	raw := requireCanonicalEvent(t, completeSafeFaultFixture())
	fixturePath := filepath.Join("..", "..", "..", "test", "fixtures", "agent-switch-observability", "envelope-v1.json")
	want, err := os.ReadFile(fixturePath)
	require.NoError(t, err)
	require.Equal(t, bytes.TrimSpace(want), raw)

	var decoded map[string]any
	require.NoError(t, json.Unmarshal(raw, &decoded))
	require.Equal(t, "0123456789abcdef0123456789abcdef", decoded["event_id"])
	require.Equal(t, "2026-08-27T20:02:03.456789Z", decoded["timestamp"])
}

func TestCanonicalAgentSwitchEventHasNoLocalIdentifiers(t *testing.T) {
	raw := requireCanonicalEvent(t, completeSafeFaultFixture())
	for _, forbidden := range []string{
		"session-", "switch-", "/Users/", `C:\\Users\\`, "prompt text",
		"provider-conversation", "runtime-handle", "idempotency", "https://",
		"conversation", "generation-id", "artifact-hash", "pull/123",
	} {
		require.NotContains(t, string(raw), forbidden)
	}
	require.NotContains(t, string(raw), "ExecutionAttemptID")
	require.NotContains(t, string(raw), "execution_attempt_id")
}

func TestCanonicalAgentSwitchEventIsByteStableAndDetachedFromInputs(t *testing.T) {
	fault := completeSafeFaultFixture()
	input := completeSafeBuildInput(fault)
	first, err := BuildAgentSwitchCanonicalEvent(input)
	require.NoError(t, err)

	// Mutating caller-owned input after construction cannot enrich frozen bytes.
	input.Release = "9.9.9-after-construction"
	input.Environment = "development"
	input.Fault.Frames[0].Function = "changedAfterConstruction"
	require.NotContains(t, string(first), "after-construction")
	require.NotContains(t, string(first), "changedAfterConstruction")

	for i := 0; i < 20; i++ {
		next, err := BuildAgentSwitchCanonicalEvent(completeSafeBuildInput(completeSafeFaultFixture()))
		require.NoError(t, err)
		require.Equal(t, first, next, "fixed structs must not depend on map iteration or process-local state")
	}
}

func TestBuildAgentSwitchCanonicalEventRejectsInvalidEventIDAndMetadata(t *testing.T) {
	tests := map[string]func(*AgentSwitchEventBuildInput){
		"event id":    func(in *AgentSwitchEventBuildInput) { in.EventID = "ABC" },
		"release":     func(in *AgentSwitchEventBuildInput) { in.Release = "https://release.invalid" },
		"environment": func(in *AgentSwitchEventBuildInput) { in.Environment = "/Users/alice" },
		"channel":     func(in *AgentSwitchEventBuildInput) { in.Channel = "stable\nsecret" },
		"platform":    func(in *AgentSwitchEventBuildInput) { in.Platform = "" },
		"os":          func(in *AgentSwitchEventBuildInput) { in.OS = strings.Repeat("x", 129) },
		"elapsed":     func(in *AgentSwitchEventBuildInput) { in.ElapsedTimeBucket = "30 seconds of prompt text" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			input := completeSafeBuildInput(completeSafeFaultFixture())
			mutate(&input)
			_, err := BuildAgentSwitchCanonicalEvent(input)
			require.Error(t, err)
		})
	}
}

func TestBuildAgentSwitchCanonicalEventEnforces60KiBBound(t *testing.T) {
	input := completeSafeBuildInput(completeSafeFaultFixture())
	input.Release = strings.Repeat("r", AgentSwitchCanonicalEventMaxBytes)
	_, err := BuildAgentSwitchCanonicalEvent(input)
	require.ErrorContains(t, err, "60 KiB")
}

func TestAgentSwitchDedupeAndIssueFingerprintAreStable(t *testing.T) {
	fault := completeSafeFaultFixture()
	wantDedupe := "v1|terminal_failure|chat_target_activation_commit|starting_target|target_ready_failed"
	require.Equal(t, wantDedupe, AgentSwitchDedupeKey(fault))
	require.Equal(t, wantDedupe, AgentSwitchDedupeKey(fault))
	require.Equal(t, []string{
		"agent-switch", "v1", "terminal_failure", "chat", "starting_target",
		"chat_target_activation_commit", "target_ready_failed",
	}, AgentSwitchIssueFingerprint(fault))

	panicFault := fault
	panicFault.ReportKind = AgentSwitchReportPanic
	panicFault.FailurePoint = AgentSwitchFailureLiveWorkerPanic
	panicFault.FaultCode = AgentSwitchFaultWorkerPanic
	panicFault.ErrorCode = AgentSwitchErrorNotApplicable
	panicFault.ExecutionAttemptID = "opaque-local-attempt"
	panicFault.Frames = []AgentSwitchStackFrame{{
		Package: "internal/session_manager", Function: "runAgentSwitchWorker", Filename: "backend/internal/session_manager/agent_switching.go", Line: 9,
	}}
	require.Equal(t, "v1|panic|opaque-local-attempt|live_worker_panic|starting_target|worker_panic", AgentSwitchDedupeKey(panicFault))
	require.Equal(t, []string{
		"agent-switch", "panic", "chat", "starting_target", "live_worker_panic", "runAgentSwitchWorker",
	}, AgentSwitchIssueFingerprint(panicFault))
}

func TestStableAgentSwitchEventIDAndStackFingerprint(t *testing.T) {
	dedupe := "v1|terminal_failure|chat_target_activation_commit|starting_target|target_ready_failed"
	require.Equal(t, "4ee7aed39fbe29c3beccf42955eb2aa1", StableAgentSwitchEventID(dedupe))
	require.Equal(t, StableAgentSwitchEventID(dedupe), StableAgentSwitchEventID(dedupe))
	require.Regexp(t, `^[0-9a-f]{32}$`, StableAgentSwitchEventID(dedupe))

	frames := completeSafeFaultFixture().Frames
	first := AgentSwitchStackFingerprint(frames)
	require.Len(t, first, 64)
	require.Equal(t, first, AgentSwitchStackFingerprint(frames))
	frames[0].Line++
	require.NotEqual(t, first, AgentSwitchStackFingerprint(frames))
}

func completeSafeFaultFixture() AgentSwitchFault {
	return AgentSwitchFault{
		ReportKind:           AgentSwitchReportTerminalFailure,
		FailurePoint:         AgentSwitchFailureChatTargetActivationCommit,
		ClassifierCallsite:   AgentSwitchClassifierExecuteChat,
		Phase:                AgentSwitchStartingTarget,
		ErrorCode:            AgentSwitchErrorTargetReadyFailed,
		FaultCode:            AgentSwitchFaultNotApplicable,
		Execution:            AgentSwitchExecutionLive,
		ExecutionAttemptID:   "local-attempt-never-exported",
		Mode:                 SessionModeChat,
		FromHarness:          HarnessClaudeCode,
		TargetHarness:        HarnessCodex,
		TargetStartMode:      AgentSwitchTargetStartResumed,
		RuntimeBackend:       AgentSwitchRuntimeChatController,
		CallOutcome:          AgentSwitchCallCommittedResponseLost,
		Ownership:            AgentSwitchOwnershipTarget,
		Compensation:         AgentSwitchCompensationNotNeeded,
		UserImpact:           AgentSwitchUserImpactTargetUnavailable,
		SourceStopConfirmed:  AgentSwitchTriTrue,
		TargetOwnerCommitted: AgentSwitchTriTrue,
		GateRetained:         AgentSwitchTriFalse,
		OccurredAt:           time.Date(2026, 8, 28, 1, 2, 3, 456789000, time.FixedZone("fixture", 5*60*60)),
		Frames: []AgentSwitchStackFrame{{
			Package:  "internal/session_manager",
			Function: "executeChatAgentSwitch",
			Filename: "backend/internal/session_manager/agent_switching_chat.go",
			Line:     742,
		}},
	}
}

func completeSafeBuildInput(fault AgentSwitchFault) AgentSwitchEventBuildInput {
	return AgentSwitchEventBuildInput{
		EventID:           "0123456789abcdef0123456789abcdef",
		Fault:             fault,
		Release:           "1.2.3",
		Environment:       "production",
		Channel:           "stable",
		Platform:          "daemon",
		OS:                "darwin",
		ElapsedTimeBucket: "under_30s",
	}
}

func requireCanonicalEvent(t *testing.T, fault AgentSwitchFault) []byte {
	t.Helper()
	raw, err := BuildAgentSwitchCanonicalEvent(completeSafeBuildInput(fault))
	require.NoError(t, err)
	require.LessOrEqual(t, len(raw), AgentSwitchCanonicalEventMaxBytes)
	return raw
}

func assertStructFields(t *testing.T, typ reflect.Type, want []string) {
	t.Helper()
	got := make([]string, typ.NumField())
	for i := 0; i < typ.NumField(); i++ {
		got[i] = typ.Field(i).Name
	}
	require.Equal(t, want, got)
}
