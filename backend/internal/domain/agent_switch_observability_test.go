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
	assertStructFields(t, reflect.TypeOf(AgentSwitchDedupeScope{}), []string{"SwitchID", "DaemonRunID"})
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
		{"terminal report rejects retained marker", func(f *AgentSwitchFault) { f.ErrorCode = AgentSwitchErrorTargetStartUnconfirmed }},
		{"semantic report forbids operational fault", func(f *AgentSwitchFault) { f.FaultCode = AgentSwitchFaultWorkerPanic }},
		{"stale outcome is suppressed", func(f *AgentSwitchFault) { f.CallOutcome = AgentSwitchCallStale }},
		{"target point requires start mode", func(f *AgentSwitchFault) { f.TargetStartMode = AgentSwitchTargetStartNotApplicable }},
		{"target point requires runtime backend", func(f *AgentSwitchFault) { f.RuntimeBackend = AgentSwitchRuntimeNotApplicable }},
		{"target point requires source-stop fact", func(f *AgentSwitchFault) { f.SourceStopConfirmed = AgentSwitchTriNotApplicable }},
		{"target point requires owner-commit fact", func(f *AgentSwitchFault) { f.TargetOwnerCommitted = AgentSwitchTriNotApplicable }},
		{"target point requires gate fact", func(f *AgentSwitchFault) { f.GateRetained = AgentSwitchTriNotApplicable }},
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

	daemonFault := completeDaemonFaultFixture()
	require.NoError(t, ValidateAgentSwitchFault(daemonFault))
	daemonFault.ErrorCode = AgentSwitchErrorSwitchFailed
	require.Error(t, ValidateAgentSwitchFault(daemonFault), "daemon lifecycle faults cannot carry a switch semantic error")

	visibilityFault := completeVisibilityFaultFixture()
	require.NoError(t, ValidateAgentSwitchFault(visibilityFault))
	visibilityFault.Mode = SessionModeChat
	require.Error(t, ValidateAgentSwitchFault(visibilityFault), "visibility faults cannot carry switch-only mode facts")
}

func TestAgentSwitchReportKindCodeMatrix(t *testing.T) {
	tests := []struct {
		name   string
		fault  AgentSwitchFault
		mutate func(*AgentSwitchFault)
	}{
		{"panic semantic error", completePanicFaultFixture(), func(f *AgentSwitchFault) { f.ErrorCode = AgentSwitchErrorSwitchFailed }},
		{"panic wrong fault", completePanicFaultFixture(), func(f *AgentSwitchFault) { f.FaultCode = AgentSwitchFaultRecoveryUnresolved }},
		{"recovery-required wrong fault", completeRecoveryRequiredFaultFixture(), func(f *AgentSwitchFault) { f.FaultCode = AgentSwitchFaultRecoveryUnresolved }},
		{"recovery wrong fault", completeRecoveryAttemptFaultFixture(), func(f *AgentSwitchFault) { f.FaultCode = AgentSwitchFaultWorkerPanic }},
		{"recovery marker wrong phase", completeRecoveryAttemptFaultFixture(), func(f *AgentSwitchFault) { f.Phase = AgentSwitchStartingTarget }},
		{"completed maintenance semantic error", completeMaintenanceFaultFixture(), func(f *AgentSwitchFault) { f.ErrorCode = AgentSwitchErrorSwitchFailed }},
		{"failed maintenance missing semantic error", completeFailedMaintenanceFaultFixture(), func(f *AgentSwitchFault) { f.ErrorCode = AgentSwitchErrorNotApplicable }},
		{"visibility semantic error", completeVisibilityFaultFixture(), func(f *AgentSwitchFault) { f.ErrorCode = AgentSwitchErrorSwitchFailed }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			require.NoError(t, ValidateAgentSwitchFault(tc.fault), "fixture must be valid before mutation")
			tc.mutate(&tc.fault)
			require.Error(t, ValidateAgentSwitchFault(tc.fault))
		})
	}
}

func TestAgentSwitchStackApplicabilityUsesTaxonomyPriority(t *testing.T) {
	p1 := completeSafeFaultFixture()
	p1.Frames = nil
	require.Error(t, ValidateAgentSwitchFault(p1))

	panicFault := completeSafeFaultFixture()
	panicFault.ReportKind = AgentSwitchReportPanic
	panicFault.FailurePoint = AgentSwitchFailureLiveWorkerPanic
	panicFault.ClassifierCallsite = AgentSwitchClassifierLiveWorkerPanic
	panicFault.ErrorCode = AgentSwitchErrorNotApplicable
	panicFault.FaultCode = AgentSwitchFaultWorkerPanic
	panicFault.CallOutcome = AgentSwitchCallPanic
	panicFault.Frames = nil
	require.Error(t, ValidateAgentSwitchFault(panicFault))

	p2 := completeSafeFaultFixture()
	p2.FailurePoint = AgentSwitchFailureAdmissionChatHandoffArm
	p2.ClassifierCallsite = AgentSwitchClassifierAdmission
	p2.Phase = AgentSwitchPreparingHandoff
	p2.ErrorCode = AgentSwitchErrorFailedPreStop
	p2.TargetStartMode = AgentSwitchTargetStartReportedPending
	p2.RuntimeBackend = AgentSwitchRuntimeNotApplicable
	p2.SourceStopConfirmed = AgentSwitchTriNotApplicable
	p2.TargetOwnerCommitted = AgentSwitchTriNotApplicable
	p2.GateRetained = AgentSwitchTriNotApplicable
	p2.Frames = nil
	require.NoError(t, ValidateAgentSwitchFault(p2), "taxonomy P2 user/environment failures may omit stacks")
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
	require.Equal(t, "Agent switch failed: chat / starting_target / chat_target_activation_commit", decoded["message"])
	require.NotContains(t, decoded, "title")
	exception := decoded["exception"].(map[string]any)
	values := exception["values"].([]any)
	require.Len(t, values, 1)
	stacktrace := values[0].(map[string]any)["stacktrace"].(map[string]any)
	frame := stacktrace["frames"].([]any)[0].(map[string]any)
	require.Equal(t, "internal/session_manager", frame["module"])
	require.Equal(t, float64(742), frame["lineno"])
	require.NotContains(t, frame, "package")
	require.NotContains(t, frame, "line")
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
		"event id":            func(in *AgentSwitchEventBuildInput) { in.EventID = "ABC" },
		"release URL":         func(in *AgentSwitchEventBuildInput) { in.Release = "https://release.invalid" },
		"environment path":    func(in *AgentSwitchEventBuildInput) { in.Environment = "/Users/alice" },
		"channel identifier":  func(in *AgentSwitchEventBuildInput) { in.Channel = "session-local-secret" },
		"platform identifier": func(in *AgentSwitchEventBuildInput) { in.Platform = "switch-local-secret" },
		"os UUID":             func(in *AgentSwitchEventBuildInput) { in.OS = "550e8400-e29b-41d4-a716-446655440000" },
		"elapsed prompt":      func(in *AgentSwitchEventBuildInput) { in.ElapsedTimeBucket = "30 seconds of prompt text" },
		"bounded OS":          func(in *AgentSwitchEventBuildInput) { in.OS = strings.Repeat("x", 129) },
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

func TestBuildAgentSwitchCanonicalEventRejectsSensitiveFrameStrings(t *testing.T) {
	tests := map[string]func(*AgentSwitchStackFrame){
		"module absolute path": func(frame *AgentSwitchStackFrame) { frame.Package = "/Users/alice/reverb" },
		"module URL":           func(frame *AgentSwitchStackFrame) { frame.Package = "https://host/repo" },
		"function identifier":  func(frame *AgentSwitchStackFrame) { frame.Function = "session-local-secret" },
		"filename local path":  func(frame *AgentSwitchStackFrame) { frame.Filename = "/Users/alice/reverb/file.go" },
		"filename identifier":  func(frame *AgentSwitchStackFrame) { frame.Filename = "backend/session-local-secret/file.go" },
		"filename URL":         func(frame *AgentSwitchStackFrame) { frame.Filename = "https://host/file.go" },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			input := completeSafeBuildInput(completeSafeFaultFixture())
			mutate(&input.Fault.Frames[0])
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
	scope := AgentSwitchDedupeScope{SwitchID: "switch-scope-a"}
	wantDedupe := "v1|switch-scope-a|terminal_failure|chat_target_activation_commit|starting_target|target_ready_failed"
	require.Equal(t, wantDedupe, requireAgentSwitchDedupeKey(t, scope, fault))
	require.Equal(t, wantDedupe, requireAgentSwitchDedupeKey(t, scope, fault))
	other := requireAgentSwitchDedupeKey(t, AgentSwitchDedupeScope{SwitchID: "switch-scope-b"}, fault)
	require.NotEqual(t, wantDedupe, other)
	require.NotEqual(t, StableAgentSwitchEventID(wantDedupe), StableAgentSwitchEventID(other))
	raw := requireCanonicalEvent(t, fault)
	require.NotContains(t, string(raw), "switch-scope-a")
	require.NotContains(t, string(raw), "switch-scope-b")
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
	require.Equal(t, "v1|switch-scope-a|panic|opaque-local-attempt|live_worker_panic|starting_target|worker_panic", requireAgentSwitchDedupeKey(t, scope, panicFault))
	require.Equal(t, []string{
		"agent-switch", "panic", "chat", "starting_target", "live_worker_panic", "runAgentSwitchWorker",
	}, AgentSwitchIssueFingerprint(panicFault))

	recoveryFault := completeRecoveryAttemptFaultFixture()
	require.Equal(t, "v1|switch-scope-a|recovery_attempt_failed|stopping_source|source_stop_unconfirmed|recovery_runtime_probe|recovery_unresolved", requireAgentSwitchDedupeKey(t, scope, recoveryFault))

	maintenanceFault := completeMaintenanceFaultFixture()
	maintenanceScope := AgentSwitchDedupeScope{SwitchID: "switch-scope-a", DaemonRunID: "daemon-run-a"}
	require.Equal(t, "v1|switch-scope-a|maintenance_failure|daemon-run-a|terminal_artifact_cleanup|terminal_cleanup_failed", requireAgentSwitchDedupeKey(t, maintenanceScope, maintenanceFault))

	daemonFault := completeDaemonFaultFixture()
	require.Equal(t, "v1|daemon-run-a|daemon_lifecycle_failure|shutdown_worker_timeout|shutdown_workers_timed_out", requireAgentSwitchDedupeKey(t, AgentSwitchDedupeScope{DaemonRunID: "daemon-run-a"}, daemonFault))

	for _, badScope := range []AgentSwitchDedupeScope{{}, {SwitchID: "/Users/alice"}, {SwitchID: "switch|injected"}, {DaemonRunID: "https://run.invalid"}} {
		_, err := AgentSwitchDedupeKey(badScope, fault)
		require.Error(t, err)
	}
}

func TestStableAgentSwitchEventIDAndStackFingerprint(t *testing.T) {
	dedupe := "v1|switch-scope-a|terminal_failure|chat_target_activation_commit|starting_target|target_ready_failed"
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

func completePanicFaultFixture() AgentSwitchFault {
	fault := completeSafeFaultFixture()
	fault.ReportKind = AgentSwitchReportPanic
	fault.FailurePoint = AgentSwitchFailureLiveWorkerPanic
	fault.ClassifierCallsite = AgentSwitchClassifierLiveWorkerPanic
	fault.ErrorCode = AgentSwitchErrorNotApplicable
	fault.FaultCode = AgentSwitchFaultWorkerPanic
	fault.CallOutcome = AgentSwitchCallPanic
	return fault
}

func completeRecoveryAttemptFaultFixture() AgentSwitchFault {
	fault := completeSafeFaultFixture()
	fault.ReportKind = AgentSwitchReportRecoveryAttemptFailed
	fault.FailurePoint = AgentSwitchFailureRecoveryRuntimeProbe
	fault.ClassifierCallsite = AgentSwitchClassifierReconcile
	fault.Phase = AgentSwitchStoppingSource
	fault.ErrorCode = AgentSwitchErrorSourceStopUnconfirmed
	fault.FaultCode = AgentSwitchFaultRecoveryUnresolved
	fault.CallOutcome = AgentSwitchCallEffectUnknown
	fault.GateRetained = AgentSwitchTriTrue
	return fault
}

func completeRecoveryRequiredFaultFixture() AgentSwitchFault {
	fault := completeSafeFaultFixture()
	fault.ReportKind = AgentSwitchReportRecoveryRequired
	fault.ErrorCode = AgentSwitchErrorTargetStartUnconfirmed
	fault.FaultCode = AgentSwitchFaultNotApplicable
	fault.GateRetained = AgentSwitchTriTrue
	return fault
}

func completeMaintenanceFaultFixture() AgentSwitchFault {
	fault := completeSafeFaultFixture()
	fault.ReportKind = AgentSwitchReportMaintenanceFailure
	fault.FailurePoint = AgentSwitchFailureTerminalArtifactCleanup
	fault.ClassifierCallsite = AgentSwitchClassifierTerminalMaintenance
	fault.Phase = AgentSwitchCompleted
	fault.ErrorCode = AgentSwitchErrorNotApplicable
	fault.FaultCode = AgentSwitchFaultTerminalCleanupFailed
	fault.CallOutcome = AgentSwitchCallCleanupFailed
	fault.Frames = nil
	return fault
}

func completeFailedMaintenanceFaultFixture() AgentSwitchFault {
	fault := completeMaintenanceFaultFixture()
	fault.Phase = AgentSwitchFailed
	fault.ErrorCode = AgentSwitchErrorSwitchFailed
	return fault
}

func completeDaemonFaultFixture() AgentSwitchFault {
	return AgentSwitchFault{
		ReportKind: AgentSwitchReportDaemonLifecycleFailure, FailurePoint: AgentSwitchFailureShutdownWorkerTimeout,
		ClassifierCallsite: AgentSwitchClassifierDaemonShutdown, Phase: AgentSwitchStateNotApplicable,
		ErrorCode: AgentSwitchErrorNotApplicable, FaultCode: AgentSwitchFaultShutdownWorkersTimedOut,
		Execution: AgentSwitchExecutionDaemonShutdown, Mode: SessionModeNotApplicable,
		FromHarness: HarnessNotApplicable, TargetHarness: HarnessNotApplicable,
		TargetStartMode: AgentSwitchTargetStartNotApplicable, RuntimeBackend: AgentSwitchRuntimeNotApplicable,
		CallOutcome: AgentSwitchCallTimedOut, Ownership: AgentSwitchOwnershipNotApplicable,
		Compensation: AgentSwitchCompensationNotApplicable, UserImpact: AgentSwitchUserImpactNotApplicable,
		SourceStopConfirmed: AgentSwitchTriNotApplicable, TargetOwnerCommitted: AgentSwitchTriNotApplicable,
		GateRetained: AgentSwitchTriNotApplicable, OccurredAt: time.Date(2026, 8, 28, 1, 2, 3, 0, time.UTC),
		Frames: []AgentSwitchStackFrame{{Package: "internal/daemon", Function: "WaitAgentSwitchWorkers", Filename: "backend/internal/daemon/daemon.go", Line: 1}},
	}
}

func completeVisibilityFaultFixture() AgentSwitchFault {
	return AgentSwitchFault{
		ReportKind: AgentSwitchReportVisibilityFailure, FailurePoint: AgentSwitchFailureVisibilityTransport,
		ClassifierCallsite: AgentSwitchClassifierVisibility, Phase: AgentSwitchStateNotApplicable,
		ErrorCode: AgentSwitchErrorNotApplicable, FaultCode: AgentSwitchFaultNotApplicable,
		Execution: AgentSwitchExecutionLive, Mode: SessionModeNotApplicable,
		FromHarness: HarnessNotApplicable, TargetHarness: HarnessNotApplicable,
		TargetStartMode: AgentSwitchTargetStartNotApplicable, RuntimeBackend: AgentSwitchRuntimeNotApplicable,
		CallOutcome: AgentSwitchCallTimedOut, Ownership: AgentSwitchOwnershipNotApplicable,
		Compensation: AgentSwitchCompensationNotApplicable, UserImpact: AgentSwitchUserImpactVisibilityImpaired,
		SourceStopConfirmed: AgentSwitchTriNotApplicable, TargetOwnerCommitted: AgentSwitchTriNotApplicable,
		GateRetained: AgentSwitchTriNotApplicable, OccurredAt: time.Date(2026, 8, 28, 1, 2, 3, 0, time.UTC),
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

func requireAgentSwitchDedupeKey(t *testing.T, scope AgentSwitchDedupeScope, fault AgentSwitchFault) string {
	t.Helper()
	key, err := AgentSwitchDedupeKey(scope, fault)
	require.NoError(t, err)
	return key
}
