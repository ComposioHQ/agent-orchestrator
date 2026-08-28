package sessionmanager

import (
	"context"
	"errors"
	"runtime"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// postAdmissionAgentSwitchError marks the exact point after CreateAgentSwitch
// has been proven durable. Task 10 translates this internal marker into the
// public observability owner; admission read-back ambiguity deliberately never
// receives it.
type postAdmissionAgentSwitchError struct{ err error }

func (e *postAdmissionAgentSwitchError) Error() string { return e.err.Error() }
func (e *postAdmissionAgentSwitchError) Unwrap() error { return e.err }

func markPostAdmissionAgentSwitchError(err error) error {
	if err == nil {
		return nil
	}
	var marked *postAdmissionAgentSwitchError
	if errors.As(err, &marked) {
		return err
	}
	return &postAdmissionAgentSwitchError{err: err}
}

func isPostAdmissionAgentSwitchError(err error) bool {
	var marked *postAdmissionAgentSwitchError
	return errors.As(err, &marked)
}

// agentSwitchFlightRecorder retains only closed, privacy-safe observations for
// one admitted execution. It is deliberately not a breadcrumb trail: raw
// errors, identifiers, paths, provider values, and user content have no field
// in this type.
type agentSwitchFlightRecorder struct {
	failurePoint             domain.AgentSwitchFailurePoint
	lastDurablePhase         domain.AgentSwitchState
	callOutcome              domain.AgentSwitchCallOutcome
	ownership                domain.AgentSwitchOwnership
	compensation             domain.AgentSwitchCompensation
	userImpact               domain.AgentSwitchUserImpact
	sourceStopConfirmed      domain.AgentSwitchTriState
	targetOwnerCommitted     domain.AgentSwitchTriState
	targetOwnershipAmbiguous bool
	gateRetained             domain.AgentSwitchTriState
	execution                domain.AgentSwitchExecution
	mode                     domain.SessionMode
	runtimeBackend           domain.AgentSwitchRuntimeBackend
}

func newAgentSwitchFlightRecorder(sw domain.AgentSwitch, mode domain.SessionMode, execution domain.AgentSwitchExecution) agentSwitchFlightRecorder {
	backend := domain.AgentSwitchRuntimeTMUX
	if mode == domain.SessionModeChat {
		backend = domain.AgentSwitchRuntimeChatController
	} else if runtime.GOOS == "windows" {
		backend = domain.AgentSwitchRuntimeConPTY
	}
	return agentSwitchFlightRecorder{
		lastDurablePhase:     sw.State,
		callOutcome:          domain.AgentSwitchCallNoEffectFailure,
		ownership:            domain.AgentSwitchOwnershipSource,
		compensation:         domain.AgentSwitchCompensationNotNeeded,
		userImpact:           domain.AgentSwitchUserImpactSourceAvailable,
		sourceStopConfirmed:  domain.AgentSwitchTriFalse,
		targetOwnerCommitted: domain.AgentSwitchTriFalse,
		gateRetained:         domain.AgentSwitchTriFalse,
		execution:            execution,
		mode:                 mode,
		runtimeBackend:       backend,
	}
}

func (r *agentSwitchFlightRecorder) boundary(point domain.AgentSwitchFailurePoint) {
	r.failurePoint = point
	r.callOutcome = domain.AgentSwitchCallNoEffectFailure
}

func (r *agentSwitchFlightRecorder) durable(sw domain.AgentSwitch) {
	r.lastDurablePhase = sw.State
	if sw.State == domain.AgentSwitchSourceStopped || sw.State == domain.AgentSwitchStartingTarget ||
		sw.State == domain.AgentSwitchTargetReady || sw.State == domain.AgentSwitchDelivering {
		r.sourceStopConfirmed = domain.AgentSwitchTriTrue
	}
	if sw.State == domain.AgentSwitchTargetReady || sw.State == domain.AgentSwitchDelivering || sw.State == domain.AgentSwitchCompleted {
		r.targetOwnerCommitted = domain.AgentSwitchTriTrue
		r.ownership = domain.AgentSwitchOwnershipTarget
	}
}

func (r *agentSwitchFlightRecorder) retain(ambiguous bool) {
	r.gateRetained = domain.AgentSwitchTriTrue
	r.targetOwnershipAmbiguous = ambiguous
	if ambiguous {
		r.ownership = domain.AgentSwitchOwnershipAmbiguous
		r.userImpact = domain.AgentSwitchUserImpactOwnershipAmbiguous
	} else {
		r.userImpact = domain.AgentSwitchUserImpactGateRetained
	}
}

func (m *Manager) agentSwitchAuthorization() domain.AgentSwitchReportingAuthorization {
	if m.agentSwitchReporting == nil {
		return domain.AgentSwitchReportingAuthorization{}
	}
	return m.agentSwitchReporting.Authorization()
}

func (m *Manager) faultFromRecorder(sw domain.AgentSwitch, code domain.AgentSwitchErrorCode, reportKind domain.AgentSwitchReportKind, recorder agentSwitchFlightRecorder) domain.AgentSwitchFault {
	point := recorder.failurePoint
	entry, ok := domain.AgentSwitchFailureTaxonomy(point)
	callsite := domain.AgentSwitchClassifierInvariant
	if ok {
		callsite = entry.ClassifierCallsite
	} else {
		point = domain.AgentSwitchFailureClassificationUnknown
	}
	startMode := sw.TargetStartMode
	if startMode == "" {
		startMode = domain.AgentSwitchTargetStartReportedPending
	}
	return domain.AgentSwitchFault{
		ReportKind: reportKind, FailurePoint: point, ClassifierCallsite: callsite,
		Phase: sw.State, ErrorCode: code, FaultCode: domain.AgentSwitchFaultNotApplicable,
		Execution: recorder.execution, Mode: recorder.mode,
		FromHarness: sw.FromHarness, TargetHarness: sw.TargetHarness,
		TargetStartMode: startMode, RuntimeBackend: recorder.runtimeBackend,
		CallOutcome: recorder.callOutcome, Ownership: recorder.ownership,
		Compensation: recorder.compensation, UserImpact: recorder.userImpact,
		SourceStopConfirmed:  recorder.sourceStopConfirmed,
		TargetOwnerCommitted: recorder.targetOwnerCommitted,
		GateRetained:         recorder.gateRetained,
		OccurredAt:           m.clock(), Frames: captureAgentSwitchFrames(5),
	}
}

// settleAgentSwitchFault is the only Session Manager adapter from a semantic
// classification to the atomic store contract. Enrollment status is never
// interpreted here: CoreChanged alone decides saga behavior.
func (m *Manager) settleAgentSwitchFault(
	ctx context.Context,
	store ports.AgentSwitchStore,
	next *domain.AgentSwitch,
	expectedState domain.AgentSwitchState,
	expectedTargetGeneration domain.AgentGenerationID,
	fault domain.AgentSwitchFault,
	unacknowledged bool,
) (ports.AgentSwitchMutationResult, error) {
	next.FailurePoint = fault.FailurePoint
	mutation := ports.AgentSwitchMutation{
		Record: *next, ExpectedState: expectedState,
		ExpectedSourceGenerationID: next.SourceGenerationID,
		ExpectedTargetGenerationID: expectedTargetGeneration,
		Fault:                      &fault, Authorization: m.agentSwitchAuthorization(),
	}
	faultStore, ok := store.(ports.AgentSwitchFaultStore)
	if !ok {
		var changed bool
		var err error
		if unacknowledged {
			changed, err = store.FailAgentSwitchIfUnacknowledged(ctx, *next)
		} else {
			changed, err = store.UpdateAgentSwitch(ctx, *next, expectedState, next.SourceGenerationID, expectedTargetGeneration)
		}
		return ports.AgentSwitchMutationResult{CoreChanged: changed, Enrollment: domain.AgentSwitchEnrollmentDisabled}, err
	}
	if unacknowledged {
		return faultStore.FailAgentSwitchIfUnacknowledgedWithFault(ctx, mutation)
	}
	return faultStore.ApplyAgentSwitchMutation(ctx, mutation)
}

func (m *Manager) applyAgentSwitchProgress(
	ctx context.Context,
	store ports.AgentSwitchStore,
	next domain.AgentSwitch,
	expectedState domain.AgentSwitchState,
	expectedTargetGeneration domain.AgentGenerationID,
) (ports.AgentSwitchMutationResult, error) {
	if faultStore, ok := store.(ports.AgentSwitchFaultStore); ok {
		return faultStore.ApplyAgentSwitchMutation(ctx, ports.AgentSwitchMutation{
			Record: next, ExpectedState: expectedState,
			ExpectedSourceGenerationID: next.SourceGenerationID,
			ExpectedTargetGenerationID: expectedTargetGeneration,
			Authorization:              m.agentSwitchAuthorization(),
		})
	}
	changed, err := store.UpdateAgentSwitch(ctx, next, expectedState, next.SourceGenerationID, expectedTargetGeneration)
	return ports.AgentSwitchMutationResult{CoreChanged: changed, Enrollment: domain.AgentSwitchEnrollmentDisabled}, err
}

func captureAgentSwitchFrames(skip int) []domain.AgentSwitchStackFrame {
	pcs := make([]uintptr, 32)
	n := runtime.Callers(skip, pcs)
	frames := runtime.CallersFrames(pcs[:n])
	out := make([]domain.AgentSwitchStackFrame, 0, 12)
	for len(out) < 12 {
		frame, more := frames.Next()
		filename := filepathFromRepository(frame.File)
		pkg, function := safeGoFrameFunction(frame.Function)
		if filename != "" && pkg != "" && function != "" && frame.Line > 0 {
			out = append(out, domain.AgentSwitchStackFrame{Package: pkg, Function: function, Filename: filename, Line: frame.Line})
		}
		if !more {
			break
		}
	}
	return out
}

func filepathFromRepository(filename string) string {
	filename = strings.ReplaceAll(filename, `\`, "/")
	for _, root := range []string{"/backend/", "/frontend/"} {
		if idx := strings.LastIndex(filename, root); idx >= 0 {
			return filename[idx+1:]
		}
	}
	return ""
}

func safeGoFrameFunction(full string) (string, string) {
	full = strings.TrimSpace(full)
	lastSlash := strings.LastIndex(full, "/")
	leaf := full
	prefix := ""
	if lastSlash >= 0 {
		prefix, leaf = full[:lastSlash], full[lastSlash+1:]
	}
	firstDot := strings.Index(leaf, ".")
	if firstDot <= 0 || firstDot == len(leaf)-1 {
		return "", ""
	}
	pkgLeaf, function := leaf[:firstDot], leaf[firstDot+1:]
	function = strings.NewReplacer("(", "", ")", "", "*", "", "[", "", "]", "").Replace(function)
	if strings.ContainsAny(function, " /:$") {
		return "", ""
	}
	pkg := pkgLeaf
	if prefix != "" {
		if idx := strings.LastIndex(prefix, "/backend/"); idx >= 0 {
			pkg = strings.TrimPrefix(prefix[idx+len("/backend/"):]+"/"+pkgLeaf, "internal/")
		} else if idx := strings.LastIndex(prefix, "/frontend/"); idx >= 0 {
			pkg = prefix[idx+len("/frontend/"):] + "/" + pkgLeaf
		}
	}
	return pkg, function
}
