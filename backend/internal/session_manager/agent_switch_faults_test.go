package sessionmanager

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestPostAdmissionMarkerIsExplicitAndWrappingSafe(t *testing.T) {
	base := errors.New("boom")
	marked := markPostAdmissionAgentSwitchError(base)
	if !isPostAdmissionAgentSwitchError(marked) || !errors.Is(marked, base) {
		t.Fatalf("post-admission marker did not preserve error chain: %v", marked)
	}
	if isPostAdmissionAgentSwitchError(base) {
		t.Fatal("unmarked admission error was inferred as saga-owned")
	}
}

type staticAgentSwitchReportingPolicy struct {
	authorization domain.AgentSwitchReportingAuthorization
}

func (p staticAgentSwitchReportingPolicy) Authorization() domain.AgentSwitchReportingAuthorization {
	return p.authorization
}

func TestAgentSwitchFlightRecorderContainsOnlyClosedObservabilityFacts(t *testing.T) {
	typeOfRecorder := reflect.TypeOf(agentSwitchFlightRecorder{})
	for i := 0; i < typeOfRecorder.NumField(); i++ {
		field := typeOfRecorder.Field(i)
		if field.Type.Kind() == reflect.Bool {
			continue
		}
		if field.Type.PkgPath() != reflect.TypeOf(domain.AgentSwitchFault{}).PkgPath() {
			t.Fatalf("field %s has non-domain type %s; recorder must not retain raw strings, errors, IDs, or provider facts", field.Name, field.Type)
		}
	}
}

func TestAdvanceAgentSwitchUsesTypedStoreWithoutFaultForSuccess(t *testing.T) {
	store := newSwitchTestStore()
	now := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)
	sw := domain.AgentSwitch{
		ID: "switch-success", SessionID: "session-success",
		FromHarness: domain.HarnessClaudeCode, TargetHarness: domain.HarnessCodex,
		State: domain.AgentSwitchPreparingHandoff, SourceGenerationID: "source-generation",
		RequestedAt: now, UpdatedAt: now,
	}
	store.switches[sw.ID] = sw
	m := New(Deps{Store: store, Clock: func() time.Time { return now.Add(time.Second) }})

	if err := m.advanceAgentSwitch(context.Background(), store, &sw, domain.AgentSwitchStoppingSource, nil); err != nil {
		t.Fatalf("advanceAgentSwitch: %v", err)
	}
	if len(store.faultMutations) != 1 {
		t.Fatalf("typed mutations = %d, want 1", len(store.faultMutations))
	}
	if store.faultMutations[0].Fault != nil {
		t.Fatalf("successful progress carried fault %+v", *store.faultMutations[0].Fault)
	}
}

func TestFailAgentSwitchClassifiesTypedBoundaryAndReadsAuthorizationAtSettlement(t *testing.T) {
	store := newSwitchTestStore()
	now := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)
	sw := domain.AgentSwitch{
		ID: "switch-failure", SessionID: "session-failure",
		FromHarness: domain.HarnessClaudeCode, TargetHarness: domain.HarnessCodex,
		State: domain.AgentSwitchPreparingHandoff, SourceGenerationID: "source-generation",
		RequestedAt: now, UpdatedAt: now,
	}
	store.switches[sw.ID] = sw
	authorization := domain.AgentSwitchReportingAuthorization{
		Enabled: true, ConsentGeneration: "consent-generation", DestinationFingerprint: "destination-fingerprint",
	}
	m := New(Deps{
		Store: store, Clock: func() time.Time { return now.Add(time.Second) },
		ReportingPolicy: staticAgentSwitchReportingPolicy{authorization: authorization},
	})
	recorder := newAgentSwitchFlightRecorder(sw, domain.SessionModeTUI, domain.AgentSwitchExecutionLive)
	recorder.failurePoint = domain.AgentSwitchFailureTargetPreflight
	recorder.callOutcome = domain.AgentSwitchCallNoEffectFailure

	settled, err := m.failAgentSwitchWithRecorder(context.Background(), store, sw, domain.AgentSwitchErrorFailedPreStop, recorder)
	if err != nil {
		t.Fatalf("failAgentSwitchWithRecorder: %v", err)
	}
	if settled.State != domain.AgentSwitchFailed {
		t.Fatalf("state = %q, want failed", settled.State)
	}
	if len(store.faultMutations) != 1 || store.faultMutations[0].Fault == nil {
		t.Fatalf("typed fault mutations = %+v, want exactly one fault", store.faultMutations)
	}
	mutation := store.faultMutations[0]
	if mutation.Authorization != authorization {
		t.Fatalf("authorization = %+v, want %+v", mutation.Authorization, authorization)
	}
	if mutation.Fault.FailurePoint != domain.AgentSwitchFailureTargetPreflight || mutation.Fault.CallOutcome != domain.AgentSwitchCallNoEffectFailure {
		t.Fatalf("fault = %+v", *mutation.Fault)
	}
	if mutation.Record.FailurePoint != domain.AgentSwitchFailureTargetPreflight {
		t.Fatalf("durable failure point = %q", mutation.Record.FailurePoint)
	}
}

func TestFailAgentSwitchWinningAcknowledgementCreatesNoFault(t *testing.T) {
	store := newSwitchTestStore()
	now := time.Date(2026, 8, 28, 10, 0, 0, 0, time.UTC)
	sw := domain.AgentSwitch{
		ID: "switch-ack", SessionID: "session-ack",
		FromHarness: domain.HarnessClaudeCode, TargetHarness: domain.HarnessCodex,
		TargetStartMode: domain.AgentSwitchTargetStartFresh,
		State:           domain.AgentSwitchDelivering, SourceGenerationID: "source-generation", TargetGenerationID: "target-generation",
		RequestedAt: now, UpdatedAt: now,
	}
	store.switches[sw.ID] = sw
	store.ackBeforeDeliveryFailure = true
	m := New(Deps{Store: store, Clock: func() time.Time { return now.Add(time.Second) }})
	recorder := newAgentSwitchFlightRecorder(sw, domain.SessionModeTUI, domain.AgentSwitchExecutionLive)
	recorder.failurePoint = domain.AgentSwitchFailureTUITargetHookWait
	recorder.callOutcome = domain.AgentSwitchCallTimedOut
	recorder.sourceStopConfirmed = domain.AgentSwitchTriTrue
	recorder.targetOwnerCommitted = domain.AgentSwitchTriTrue
	recorder.ownership = domain.AgentSwitchOwnershipTarget
	recorder.userImpact = domain.AgentSwitchUserImpactDeliveryUnknown

	settled, err := m.failAgentSwitchWithRecorder(context.Background(), store, sw, domain.AgentSwitchErrorDeliveryUnconfirmed, recorder)
	if err != nil {
		t.Fatalf("failAgentSwitchWithRecorder: %v", err)
	}
	if settled.State != domain.AgentSwitchCompleted {
		t.Fatalf("state = %q, want completed", settled.State)
	}
	if len(store.faultMutations) != 2 {
		t.Fatalf("typed mutations = %d, want failure CAS plus fault-free completion", len(store.faultMutations))
	}
	if store.faultMutations[0].Fault == nil || store.faultMutations[1].Fault != nil {
		t.Fatalf("winning acknowledgement must leave only the losing CAS candidate and fault-free completion: %+v", store.faultMutations)
	}
}

var _ ports.AgentSwitchReportingPolicy = staticAgentSwitchReportingPolicy{}
