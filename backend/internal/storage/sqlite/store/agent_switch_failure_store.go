package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/storage/sqlite/gen"
)

const (
	agentSwitchFailureSchemaVersion = 1
	agentSwitchFailureTTL           = 7 * 24 * time.Hour
)

var (
	_ ports.AgentSwitchFaultStore                = (*Store)(nil)
	_ ports.AgentSwitchFailureOutboxStore        = (*Store)(nil)
	_ ports.AgentSwitchFailureEventMetadataStore = (*Store)(nil)
)

func (s *Store) ConfigureAgentSwitchFailureEventMetadata(ctx context.Context, metadata domain.AgentSwitchEventMetadata) error {
	if err := domain.ValidateAgentSwitchEventMetadata(metadata); err != nil {
		return fmt.Errorf("configure agent switch failure event metadata: %w", err)
	}
	if err := s.writeMu.LockContext(ctx); err != nil {
		return err
	}
	defer s.writeMu.Unlock()
	copy := metadata
	s.agentSwitchFailureEventMetadata = &copy
	return nil
}

func (s *Store) ApplyAgentSwitchMutation(ctx context.Context, mutation ports.AgentSwitchMutation) (ports.AgentSwitchMutationResult, error) {
	return s.applyAgentSwitchMutation(ctx, mutation, false)
}

func (s *Store) FailAgentSwitchIfUnacknowledgedWithFault(ctx context.Context, mutation ports.AgentSwitchMutation) (ports.AgentSwitchMutationResult, error) {
	return s.applyAgentSwitchMutation(ctx, mutation, true)
}

func (s *Store) applyAgentSwitchMutation(ctx context.Context, mutation ports.AgentSwitchMutation, unacknowledged bool) (ports.AgentSwitchMutationResult, error) {
	rec := mutation.Record
	if rec.ErrorCode == "" {
		rec.FailurePoint = ""
	}
	normalizeAgentSwitchMutationPoint(&rec)
	mutation.Record = rec
	if err := validateAgentSwitchCoreMutation(mutation, unacknowledged); err != nil {
		return ports.AgentSwitchMutationResult{}, err
	}

	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return ports.AgentSwitchMutationResult{}, fmt.Errorf("begin agent switch fault mutation %s: %w", rec.ID, err)
	}
	defer func() { _ = tx.Rollback() }()
	q := s.qw.WithTx(tx)
	if err := ensureNativeSessionRefBelongsTo(ctx, q, rec.SessionID, rec.TargetHarness, rec.TargetNativeSessionRef, "target"); err != nil {
		return ports.AgentSwitchMutationResult{}, fmt.Errorf("apply agent switch mutation %s: %w", rec.ID, err)
	}

	var changed int64
	if unacknowledged {
		changed, err = q.FailAgentSwitchIfUnacknowledged(ctx, gen.FailAgentSwitchIfUnacknowledgedParams{
			ErrorCode: string(rec.ErrorCode), FailurePoint: string(rec.FailurePoint), FailedAt: rec.UpdatedAt,
			ID: rec.ID, SessionID: rec.SessionID,
			ExpectedSourceGenerationID: mutation.ExpectedSourceGenerationID,
			ExpectedTargetGenerationID: mutation.ExpectedTargetGenerationID,
		})
	} else {
		changed, err = q.UpdateAgentSwitch(ctx, gen.UpdateAgentSwitchParams{
			TargetNativeSessionRef: rec.TargetNativeSessionRef, TargetStartMode: rec.TargetStartMode,
			NextState: rec.State, NextTargetGenerationID: rec.TargetGenerationID,
			NextTargetRuntimeHandleID: rec.TargetRuntimeHandleID, ErrorCode: string(rec.ErrorCode),
			FailurePoint: string(rec.FailurePoint), UpdatedAt: rec.UpdatedAt,
			ID: rec.ID, SessionID: rec.SessionID, ExpectedState: mutation.ExpectedState,
			ExpectedSourceGenerationID: mutation.ExpectedSourceGenerationID,
			ExpectedTargetGenerationID: mutation.ExpectedTargetGenerationID,
		})
	}
	if err != nil {
		return ports.AgentSwitchMutationResult{}, fmt.Errorf("apply agent switch mutation %s: %w", rec.ID, err)
	}
	if changed == 0 {
		if err := tx.Commit(); err != nil {
			return ports.AgentSwitchMutationResult{}, fmt.Errorf("commit unchanged agent switch mutation %s: %w", rec.ID, err)
		}
		return ports.AgentSwitchMutationResult{Enrollment: domain.AgentSwitchEnrollmentDeduped}, nil
	}

	result := ports.AgentSwitchMutationResult{CoreChanged: true, Enrollment: domain.AgentSwitchEnrollmentDeduped}
	result.Enrollment = s.enrollFaultSavepoint(ctx, tx, failureEnrollmentInput{
		Switch: &rec, Fault: mutation.Fault, Authorization: mutation.Authorization,
		FaultPhase: mutation.ExpectedState, ResolveReceipts: true,
	})
	if err := s.agentSwitchFailureCommit(tx); err != nil {
		return ports.AgentSwitchMutationResult{}, fmt.Errorf("commit agent switch fault mutation %s: %w", rec.ID, err)
	}
	return result, nil
}

func normalizeAgentSwitchMutationPoint(rec *domain.AgentSwitch) {
	point := rec.FailurePoint
	if point == "" {
		return
	}
	if _, ok := domain.AgentSwitchFailureTaxonomy(point); !ok {
		point = domain.AgentSwitchFailureClassificationUnknown
	}
	rec.FailurePoint = point
}

func validateAgentSwitchCoreMutation(m ports.AgentSwitchMutation, unacknowledged bool) error {
	rec := m.Record
	if err := validateAgentSwitch(rec, false); err != nil {
		return err
	}
	if !m.ExpectedState.Valid() || !domain.ValidAgentSwitchTransition(m.ExpectedState, rec.State) {
		return fmt.Errorf("apply agent switch mutation %s: invalid transition %q -> %q", rec.ID, m.ExpectedState, rec.State)
	}
	if m.ExpectedSourceGenerationID == "" || rec.SourceGenerationID != m.ExpectedSourceGenerationID {
		return fmt.Errorf("apply agent switch mutation %s: source generation does not match immutable provenance", rec.ID)
	}
	if unacknowledged {
		if rec.State != domain.AgentSwitchFailed || m.ExpectedState != domain.AgentSwitchDelivering || rec.TargetGenerationID == "" || rec.TargetAcknowledgedAt != nil {
			return fmt.Errorf("fail unacknowledged agent switch %s: exact unacknowledged delivery facts are required", rec.ID)
		}
	} else if m.ExpectedState == domain.AgentSwitchDelivering && rec.State == domain.AgentSwitchFailed {
		return fmt.Errorf("apply agent switch mutation %s: delivery failure requires the acknowledgement-fenced operation", rec.ID)
	}
	return nil
}

type failureEnrollmentInput struct {
	Switch             *domain.AgentSwitch
	DaemonRunID        string
	Fault              *domain.AgentSwitchFault
	Authorization      domain.AgentSwitchReportingAuthorization
	GuardCurrentSwitch bool
	ResolveReceipts    bool
	FaultPhase         domain.AgentSwitchState
}

func (s *Store) enrollFaultSavepoint(ctx context.Context, tx *sql.Tx, input failureEnrollmentInput) (status domain.AgentSwitchEnrollmentStatus) {
	status = domain.AgentSwitchEnrollmentLocalInvariantFailed
	if _, err := tx.ExecContext(ctx, `SAVEPOINT agent_switch_telemetry`); err != nil {
		logAgentSwitchEnrollmentInvariant(input.Fault, "savepoint_begin")
		return status
	}
	released := false
	defer func() {
		if recovered := recover(); recovered != nil {
			_, _ = tx.ExecContext(ctx, `ROLLBACK TO agent_switch_telemetry`)
			_, _ = tx.ExecContext(ctx, `RELEASE agent_switch_telemetry`)
			logAgentSwitchEnrollmentInvariant(input.Fault, "builder_panic")
			status = domain.AgentSwitchEnrollmentLocalInvariantFailed
			return
		}
		if !released {
			_, _ = tx.ExecContext(ctx, `ROLLBACK TO agent_switch_telemetry`)
			_, _ = tx.ExecContext(ctx, `RELEASE agent_switch_telemetry`)
		}
	}()

	status, err := s.enrollFaultTx(ctx, tx, input)
	if err != nil {
		logAgentSwitchEnrollmentInvariant(input.Fault, "validate_serialize_or_insert")
		return domain.AgentSwitchEnrollmentLocalInvariantFailed
	}
	if _, err := tx.ExecContext(ctx, `RELEASE agent_switch_telemetry`); err != nil {
		logAgentSwitchEnrollmentInvariant(input.Fault, "savepoint_release")
		return domain.AgentSwitchEnrollmentLocalInvariantFailed
	}
	released = true
	return status
}

func logAgentSwitchEnrollmentInvariant(fault *domain.AgentSwitchFault, stage string) {
	point, kind := domain.AgentSwitchFailurePoint(""), domain.AgentSwitchReportKind("")
	if fault != nil {
		point, kind = fault.FailurePoint, fault.ReportKind
	}
	slog.Default().Error("agent switch telemetry local invariant", "stage", stage,
		"failure_point", point, "report_kind", kind)
}

func (s *Store) enrollFaultTx(ctx context.Context, tx *sql.Tx, input failureEnrollmentInput) (domain.AgentSwitchEnrollmentStatus, error) {
	if err := validateFailureEnrollment(input); err != nil {
		return domain.AgentSwitchEnrollmentLocalInvariantFailed, err
	}
	if input.ResolveReceipts && input.Switch != nil {
		if _, err := tx.ExecContext(ctx, `
UPDATE agent_switch_failure_receipts SET retain_until=?
WHERE switch_id=? AND retain_until IS NULL AND durable_state_fingerprint<>?`,
			input.Switch.UpdatedAt.Add(agentSwitchFailureTTL), input.Switch.ID, agentSwitchDurableFingerprint(*input.Switch)); err != nil {
			return domain.AgentSwitchEnrollmentLocalInvariantFailed, err
		}
	}
	if input.Fault == nil {
		return domain.AgentSwitchEnrollmentDeduped, nil
	}
	fault := *input.Fault
	if !input.Authorization.Enabled {
		return domain.AgentSwitchEnrollmentDisabled, nil
	}
	var enabled bool
	var generation, destination string
	if err := tx.QueryRowContext(ctx, `SELECT enabled,consent_generation,destination_fingerprint FROM agent_switch_failure_policy WHERE singleton=1`).Scan(&enabled, &generation, &destination); err != nil {
		return domain.AgentSwitchEnrollmentLocalInvariantFailed, err
	}
	if !enabled {
		return domain.AgentSwitchEnrollmentDisabled, nil
	}
	if generation != input.Authorization.ConsentGeneration || destination != input.Authorization.DestinationFingerprint {
		return domain.AgentSwitchEnrollmentStaleGeneration, nil
	}

	scope := domain.AgentSwitchDedupeScope{DaemonRunID: input.DaemonRunID}
	scopeName := "daemon"
	var switchID sql.NullString
	var requestedAt sql.NullTime
	durableFingerprint := "daemon|" + input.DaemonRunID
	if input.Switch != nil {
		scope.SwitchID = input.Switch.ID
		scopeName = "switch"
		switchID = sql.NullString{String: string(input.Switch.ID), Valid: true}
		requestedAt = sql.NullTime{Time: input.Switch.RequestedAt, Valid: true}
		durableFingerprint = agentSwitchDurableFingerprint(*input.Switch)
	}
	dedupeKey, err := domain.AgentSwitchDedupeKey(scope, fault)
	if err != nil {
		return domain.AgentSwitchEnrollmentLocalInvariantFailed, err
	}
	eventID := domain.StableAgentSwitchEventID(dedupeKey)
	if s.agentSwitchFailureEventMetadata == nil {
		return domain.AgentSwitchEnrollmentLocalInvariantFailed, errors.New("agent switch failure event metadata is not configured")
	}
	metadata := *s.agentSwitchFailureEventMetadata
	if err := domain.ValidateAgentSwitchEventMetadata(metadata); err != nil {
		return domain.AgentSwitchEnrollmentLocalInvariantFailed, err
	}
	canonical, err := s.agentSwitchFailureEventBuilder(domain.AgentSwitchEventBuildInput{
		EventID: eventID, Fault: fault, Release: metadata.Release,
		Environment: metadata.Environment, Channel: metadata.Channel,
		Platform: metadata.Platform, OS: metadata.OS,
		ElapsedTimeBucket: metadata.ElapsedTimeBucket,
	})
	if err != nil {
		return domain.AgentSwitchEnrollmentLocalInvariantFailed, err
	}
	frames, err := json.Marshal(fault.Frames)
	if err != nil {
		return domain.AgentSwitchEnrollmentLocalInvariantFailed, err
	}
	retainUntil := sql.NullTime{}
	if fault.ReportKind != domain.AgentSwitchReportRecoveryRequired && fault.ReportKind != domain.AgentSwitchReportRecoveryAttemptFailed {
		retainUntil = sql.NullTime{Time: fault.OccurredAt.Add(agentSwitchFailureTTL), Valid: true}
	}

	q := gen.New(tx)
	var receiptRows int64
	if input.GuardCurrentSwitch && input.Switch != nil {
		receiptRows, err = q.InsertAgentSwitchFailureReceiptForCurrentSwitch(ctx, gen.InsertAgentSwitchFailureReceiptForCurrentSwitchParams{
			DedupeKey: dedupeKey, ReportKind: string(fault.ReportKind),
			DurableStateFingerprint: durableFingerprint, RecordedAt: fault.OccurredAt,
			RetainUntil: retainUntil, SwitchID: input.Switch.ID, ExpectedState: input.Switch.State,
			ExpectedErrorCode: string(input.Switch.ErrorCode), ExpectedFailurePoint: string(input.Switch.FailurePoint),
			ExpectedUpdatedAt: input.Switch.UpdatedAt, ConsentGeneration: generation,
			DestinationFingerprint: destination,
		})
	} else {
		receiptRows, err = q.InsertAgentSwitchFailureReceipt(ctx, gen.InsertAgentSwitchFailureReceiptParams{
			DedupeKey: dedupeKey, SwitchID: switchID, ReportKind: string(fault.ReportKind),
			DurableStateFingerprint: durableFingerprint, RecordedAt: fault.OccurredAt,
			RetainUntil: retainUntil, ConsentGeneration: generation, DestinationFingerprint: destination,
		})
	}
	if err != nil {
		return domain.AgentSwitchEnrollmentLocalInvariantFailed, err
	}
	if receiptRows == 0 {
		return domain.AgentSwitchEnrollmentDeduped, nil
	}
	expiresAt := fault.OccurredAt.Add(agentSwitchFailureTTL)
	payloadRows, err := q.InsertAgentSwitchFailurePayload(ctx, gen.InsertAgentSwitchFailurePayloadParams{
		ID: eventID, SchemaVersion: agentSwitchFailureSchemaVersion,
		EnvelopeEncodingVersion: domain.AgentSwitchEnvelopeEncodingV1,
		DedupeKey:               dedupeKey, DestinationFingerprint: destination, SwitchID: switchID,
		ReportKind: string(fault.ReportKind), Scope: scopeName,
		FailurePoint: string(fault.FailurePoint), ClassifierCallsite: string(fault.ClassifierCallsite),
		Phase: string(fault.Phase), ErrorCode: string(fault.ErrorCode), FaultCode: string(fault.FaultCode),
		Execution: string(fault.Execution), ExecutionAttemptID: fault.ExecutionAttemptID,
		Mode: string(fault.Mode), FromHarness: string(fault.FromHarness), TargetHarness: string(fault.TargetHarness),
		TargetStartMode: string(fault.TargetStartMode), RuntimeBackend: string(fault.RuntimeBackend),
		CallOutcome: string(fault.CallOutcome), Ownership: string(fault.Ownership),
		Compensation: string(fault.Compensation), UserImpact: string(fault.UserImpact),
		SourceStopConfirmed: string(fault.SourceStopConfirmed), TargetOwnerCommitted: string(fault.TargetOwnerCommitted),
		GateRetained: string(fault.GateRetained), RequestedAt: requestedAt, OccurredAt: fault.OccurredAt,
		SanitizedStack: frames, StackFingerprint: domain.AgentSwitchStackFingerprint(fault.Frames),
		CanonicalEventJson: canonical, ExpiresAt: expiresAt, AvailableAt: fault.OccurredAt,
		ConsentGeneration: generation,
	})
	if err != nil {
		return domain.AgentSwitchEnrollmentLocalInvariantFailed, err
	}
	if payloadRows != 1 {
		return domain.AgentSwitchEnrollmentLocalInvariantFailed, errors.New("outbox insert did not match the enrolled receipt")
	}
	return domain.AgentSwitchEnrollmentEnrolled, nil
}

func validateFailureEnrollment(input failureEnrollmentInput) error {
	if input.Switch != nil {
		reportable := input.Switch.State == domain.AgentSwitchFailed || input.Switch.ErrorCode.RetainedRecoveryMarker()
		if reportable && input.Fault == nil {
			return errors.New("reportable agent switch mutation requires a typed fault")
		}
		if !reportable && input.Fault != nil {
			return errors.New("ordinary agent switch progress cannot carry a fault")
		}
	}
	if input.Fault == nil {
		return nil
	}
	if err := domain.ValidateAgentSwitchFault(*input.Fault); err != nil {
		return err
	}
	if input.Switch == nil {
		return nil
	}
	binding := *input.Switch
	if input.FaultPhase != "" {
		binding.State = input.FaultPhase
	}
	return validateAgentSwitchFaultBinding(binding, *input.Fault, false)
}

func agentSwitchDurableFingerprint(sw domain.AgentSwitch) string {
	value := strings.Join([]string{string(sw.State), string(sw.ErrorCode), string(sw.FailurePoint)}, "|")
	digest := sha256.Sum256([]byte(value))
	return "v1:" + hex.EncodeToString(digest[:])
}

func validateAgentSwitchFaultBinding(sw domain.AgentSwitch, fault domain.AgentSwitchFault, strictSemantic bool) error {
	if fault.Phase != sw.State {
		return fmt.Errorf("fault phase %q does not match durable state %q", fault.Phase, sw.State)
	}
	if fault.FromHarness != sw.FromHarness || fault.TargetHarness != sw.TargetHarness {
		return errors.New("fault harness direction does not match durable switch")
	}
	expectedStart := sw.TargetStartMode
	if expectedStart == "" {
		expectedStart = domain.AgentSwitchTargetStartReportedPending
	}
	if fault.TargetStartMode != expectedStart {
		return fmt.Errorf("fault target start mode %q does not match durable mode %q", fault.TargetStartMode, expectedStart)
	}
	semantic := strictSemantic || fault.ReportKind == domain.AgentSwitchReportTerminalFailure || fault.ReportKind == domain.AgentSwitchReportRecoveryRequired
	if semantic {
		pointMatches := fault.FailurePoint == sw.FailurePoint
		if sw.FailurePoint == "" && fault.FailurePoint == domain.AgentSwitchFailureRecoveryExistingMarker {
			pointMatches = true
		}
		if !pointMatches {
			return fmt.Errorf("fault failure point %q does not match durable point %q", fault.FailurePoint, sw.FailurePoint)
		}
		if fault.ErrorCode != sw.ErrorCode {
			return fmt.Errorf("fault error code %q does not match durable code %q", fault.ErrorCode, sw.ErrorCode)
		}
	} else if fault.ReportKind == domain.AgentSwitchReportRecoveryAttemptFailed || fault.ReportKind == domain.AgentSwitchReportMaintenanceFailure {
		if fault.ErrorCode != sw.ErrorCode {
			return fmt.Errorf("fault error code %q does not match durable code %q", fault.ErrorCode, sw.ErrorCode)
		}
	}
	return nil
}

func (s *Store) EnqueueAgentSwitchOperationalFault(ctx context.Context, input ports.AgentSwitchOperationalFault) (ports.AgentSwitchMutationResult, error) {
	if input.SwitchID == "" || input.ExpectedUpdatedAt.IsZero() {
		return ports.AgentSwitchMutationResult{}, errors.New("enqueue agent switch operational fault: durable switch fingerprint is required")
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return ports.AgentSwitchMutationResult{}, fmt.Errorf("begin standalone agent switch fault: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	row := tx.QueryRowContext(ctx, `
SELECT id,session_id,idempotency_key,request_fingerprint,from_harness,target_harness,
 target_native_session_ref,target_start_mode,state,agent_handoff_status,source_transcript_status,
 semantic_handoff_included,agent_handoff_path,agent_handoff_hash,source_generation_id,
 target_generation_id,target_runtime_handle_id,target_acknowledged_at,error_code,failure_point,
 requested_at,updated_at,final_handoff_path,final_handoff_hash
FROM agent_switches WHERE id=? AND state=? AND error_code=? AND failure_point=? AND updated_at=?`,
		input.SwitchID, input.ExpectedState, input.ExpectedErrorCode, input.ExpectedFailurePoint, input.ExpectedUpdatedAt)
	sw, found, err := scanAgentSwitchFailureFingerprint(row)
	if err != nil {
		return ports.AgentSwitchMutationResult{}, err
	}
	if !found {
		if err := tx.Commit(); err != nil {
			return ports.AgentSwitchMutationResult{}, err
		}
		return ports.AgentSwitchMutationResult{Enrollment: domain.AgentSwitchEnrollmentDeduped}, nil
	}
	if err := domain.ValidateAgentSwitchFault(input.Fault); err == nil {
		if err := validateAgentSwitchFaultBinding(sw, input.Fault, false); err != nil {
			return ports.AgentSwitchMutationResult{}, fmt.Errorf("enqueue agent switch operational fault: %w", err)
		}
	}
	status := s.enrollFaultSavepoint(ctx, tx, failureEnrollmentInput{
		Switch: &sw, DaemonRunID: input.DaemonRunID, Fault: &input.Fault, Authorization: input.Authorization,
		GuardCurrentSwitch: true,
	})
	if err := tx.Commit(); err != nil {
		return ports.AgentSwitchMutationResult{}, fmt.Errorf("commit standalone agent switch fault: %w", err)
	}
	return ports.AgentSwitchMutationResult{CoreChanged: status == domain.AgentSwitchEnrollmentEnrolled, Enrollment: status}, nil
}

func scanAgentSwitchFailureFingerprint(row *sql.Row) (domain.AgentSwitch, bool, error) {
	var sw domain.AgentSwitch
	var targetRef sql.NullString
	var acknowledged sql.NullTime
	err := row.Scan(&sw.ID, &sw.SessionID, &sw.IdempotencyKey, &sw.RequestFingerprint,
		&sw.FromHarness, &sw.TargetHarness, &targetRef, &sw.TargetStartMode, &sw.State,
		&sw.AgentHandoffStatus, &sw.SourceTranscriptStatus, &sw.SemanticHandoffIncluded,
		&sw.AgentHandoffPath, &sw.AgentHandoffHash, &sw.SourceGenerationID, &sw.TargetGenerationID,
		&sw.TargetRuntimeHandleID, &acknowledged, &sw.ErrorCode, &sw.FailurePoint,
		&sw.RequestedAt, &sw.UpdatedAt, &sw.FinalHandoffPath, &sw.FinalHandoffHash)
	if errors.Is(err, sql.ErrNoRows) {
		return domain.AgentSwitch{}, false, nil
	}
	if err != nil {
		return domain.AgentSwitch{}, false, fmt.Errorf("read current switch fingerprint: %w", err)
	}
	if targetRef.Valid {
		ref := domain.AgentNativeSessionID(targetRef.String)
		sw.TargetNativeSessionRef = &ref
	}
	if acknowledged.Valid {
		sw.TargetAcknowledgedAt = &acknowledged.Time
	}
	return sw, true, nil
}

func (s *Store) EnqueueAgentSwitchDaemonFault(ctx context.Context, input ports.AgentSwitchDaemonFault) (ports.AgentSwitchMutationResult, error) {
	if strings.TrimSpace(input.DaemonRunID) == "" {
		return ports.AgentSwitchMutationResult{}, errors.New("enqueue daemon agent switch fault: daemon run ID is required")
	}
	if err := domain.ValidateAgentSwitchFault(input.Fault); err == nil {
		if input.Fault.Phase != domain.AgentSwitchStateNotApplicable || input.Fault.ErrorCode != domain.AgentSwitchErrorNotApplicable ||
			input.Fault.Mode != domain.SessionModeNotApplicable || input.Fault.FromHarness != domain.HarnessNotApplicable ||
			input.Fault.TargetHarness != domain.HarnessNotApplicable || input.Fault.TargetStartMode != domain.AgentSwitchTargetStartNotApplicable ||
			input.Fault.RuntimeBackend != domain.AgentSwitchRuntimeNotApplicable || input.Fault.Ownership != domain.AgentSwitchOwnershipNotApplicable ||
			input.Fault.Compensation != domain.AgentSwitchCompensationNotApplicable || input.Fault.UserImpact != domain.AgentSwitchUserImpactNotApplicable ||
			input.Fault.SourceStopConfirmed != domain.AgentSwitchTriNotApplicable || input.Fault.TargetOwnerCommitted != domain.AgentSwitchTriNotApplicable ||
			input.Fault.GateRetained != domain.AgentSwitchTriNotApplicable {
			return ports.AgentSwitchMutationResult{}, errors.New("enqueue daemon agent switch fault: switch-only fields must be explicit not_applicable")
		}
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return ports.AgentSwitchMutationResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	status := s.enrollFaultSavepoint(ctx, tx, failureEnrollmentInput{
		DaemonRunID: input.DaemonRunID, Fault: &input.Fault, Authorization: input.Authorization,
	})
	if err := tx.Commit(); err != nil {
		return ports.AgentSwitchMutationResult{}, fmt.Errorf("commit daemon agent switch fault: %w", err)
	}
	return ports.AgentSwitchMutationResult{CoreChanged: status == domain.AgentSwitchEnrollmentEnrolled, Enrollment: status}, nil
}

func (s *Store) ForceDisableAgentSwitchFailurePolicy(ctx context.Context, updatedAt time.Time) error {
	if updatedAt.IsZero() {
		return errors.New("force-disable agent switch failure policy: timestamp is required")
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err := s.writeDB.ExecContext(ctx, `UPDATE agent_switch_failure_policy SET enabled=0,updated_at=? WHERE singleton=1`, updatedAt)
	return err
}

func (s *Store) ApplyAgentSwitchFailurePolicy(ctx context.Context, policy ports.AgentSwitchFailurePolicy) error {
	if policy.UpdatedAt.IsZero() {
		return errors.New("apply agent switch failure policy: timestamp is required")
	}
	if policy.Authorization.Enabled && (policy.Authorization.ConsentGeneration == "" || policy.Authorization.DestinationFingerprint == "") {
		return errors.New("apply agent switch failure policy: enabled policy requires generation and destination")
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `UPDATE agent_switch_failure_policy SET enabled=?,consent_generation=?,destination_fingerprint=?,updated_at=? WHERE singleton=1`,
		policy.Authorization.Enabled, policy.Authorization.ConsentGeneration, policy.Authorization.DestinationFingerprint, policy.UpdatedAt); err != nil {
		return err
	}
	if !policy.Authorization.Enabled {
		if _, err := tx.ExecContext(ctx, `DELETE FROM agent_switch_failure_outbox`); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) PurgeAgentSwitchFailurePayloads(ctx context.Context) (int64, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	result, err := s.writeDB.ExecContext(ctx, `DELETE FROM agent_switch_failure_outbox`)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (s *Store) EnrollCurrentAgentSwitchRecoveryMarkers(ctx context.Context, input ports.AgentSwitchFailureRecoveryEnrollment) (int64, error) {
	if input.EnrolledAt.IsZero() {
		return 0, errors.New("enroll current agent switch recovery markers: timestamp is required")
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(ctx, `
SELECT a.id,a.session_id,a.requested_at,a.updated_at,a.state,a.error_code,a.failure_point,
 a.from_harness,a.target_harness,a.target_start_mode,s.session_mode
FROM agent_switches a JOIN sessions s ON s.id=a.session_id
WHERE a.state NOT IN ('completed','failed')
  AND a.error_code IN ('source_stop_unconfirmed','source_restore_unconfirmed','target_start_unconfirmed')`)
	if err != nil {
		return 0, err
	}
	type marker struct {
		id                     domain.AgentSwitchID
		sessionID              domain.SessionID
		requestedAt, updatedAt time.Time
		state                  domain.AgentSwitchState
		code                   domain.AgentSwitchErrorCode
		point                  domain.AgentSwitchFailurePoint
		from, target           domain.AgentHarness
		start                  domain.AgentSwitchTargetStartMode
		mode                   domain.SessionMode
	}
	var markers []marker
	for rows.Next() {
		var m marker
		if err := rows.Scan(&m.id, &m.sessionID, &m.requestedAt, &m.updatedAt, &m.state, &m.code, &m.point, &m.from, &m.target, &m.start, &m.mode); err != nil {
			_ = rows.Close()
			return 0, err
		}
		markers = append(markers, m)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	var enrolled int64
	for _, m := range markers {
		point := m.point
		if point == "" {
			point = domain.AgentSwitchFailureRecoveryExistingMarker
		}
		entry, ok := domain.AgentSwitchFailureTaxonomy(point)
		if !ok || entry.LocalOnly {
			continue
		}
		backend := domain.AgentSwitchRuntimeTMUX
		if m.mode == domain.SessionModeChat {
			backend = domain.AgentSwitchRuntimeChatController
		}
		start := m.start
		if m.state == domain.AgentSwitchStartingTarget && start == domain.AgentSwitchTargetStartPending {
			continue
		}
		if start == "" {
			start = domain.AgentSwitchTargetStartReportedPending
		}
		fault := domain.AgentSwitchFault{
			ReportKind: domain.AgentSwitchReportRecoveryRequired, FailurePoint: point,
			ClassifierCallsite: entry.ClassifierCallsite, Phase: m.state,
			ErrorCode: m.code, FaultCode: domain.AgentSwitchFaultNotApplicable,
			Execution: domain.AgentSwitchExecutionExplicitRecovery, Mode: m.mode,
			FromHarness: m.from, TargetHarness: m.target, TargetStartMode: start,
			RuntimeBackend: backend, CallOutcome: domain.AgentSwitchCallEffectUnknown,
			Ownership: domain.AgentSwitchOwnershipAmbiguous, Compensation: domain.AgentSwitchCompensationUncertain,
			UserImpact: domain.AgentSwitchUserImpactGateRetained, SourceStopConfirmed: domain.AgentSwitchTriFalse,
			TargetOwnerCommitted: domain.AgentSwitchTriFalse, GateRetained: domain.AgentSwitchTriTrue,
			OccurredAt: input.EnrolledAt,
			Frames:     []domain.AgentSwitchStackFrame{{Package: "storage.sqlite.store", Function: "Store.EnrollCurrentAgentSwitchRecoveryMarkers", Filename: "backend/internal/storage/sqlite/store/agent_switch_failure_store.go", Line: 1}},
		}
		sw := domain.AgentSwitch{
			ID: m.id, SessionID: m.sessionID, State: m.state, ErrorCode: m.code,
			FailurePoint: m.point, FromHarness: m.from, TargetHarness: m.target,
			TargetStartMode: m.start, RequestedAt: m.requestedAt, UpdatedAt: m.updatedAt,
		}
		status := s.enrollFaultSavepoint(ctx, tx, failureEnrollmentInput{Switch: &sw, Fault: &fault, Authorization: input.Authorization, GuardCurrentSwitch: true})
		if status == domain.AgentSwitchEnrollmentEnrolled {
			enrolled++
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return enrolled, nil
}

func (s *Store) ClaimAgentSwitchFailure(ctx context.Context, input ports.AgentSwitchFailureClaimRequest) (ports.AgentSwitchFailureClaim, bool, error) {
	if !input.Authorization.Enabled || input.LeaseToken == "" || input.Now.IsZero() || !input.LeaseExpiresAt.After(input.Now) {
		return ports.AgentSwitchFailureClaim{}, false, nil
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return ports.AgentSwitchFailureClaim{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
UPDATE agent_switch_failure_outbox SET discarded_at=?,lease_token=NULL,lease_consent_generation=NULL,lease_delivery_epoch=NULL,lease_expires_at=NULL,last_delivery_error_class='unauthorized'
WHERE delivered_at IS NULL AND discarded_at IS NULL AND destination_fingerprint<>?
 AND EXISTS(SELECT 1 FROM agent_switch_failure_policy p WHERE p.singleton=1 AND p.enabled=1
   AND p.consent_generation=? AND p.destination_fingerprint=?)`, input.Now, input.Authorization.DestinationFingerprint,
		input.Authorization.ConsentGeneration, input.Authorization.DestinationFingerprint); err != nil {
		return ports.AgentSwitchFailureClaim{}, false, err
	}
	var claim ports.AgentSwitchFailureClaim
	var encoding int
	err = tx.QueryRowContext(ctx, `
SELECT o.id,o.envelope_encoding_version,o.canonical_event_json,o.destination_fingerprint,o.expires_at,o.attempt_count
FROM agent_switch_failure_outbox o JOIN agent_switch_failure_policy p ON p.singleton=1
LEFT JOIN agent_switch_failure_delivery_state d ON d.destination_fingerprint=o.destination_fingerprint
WHERE p.enabled=1 AND p.consent_generation=? AND p.destination_fingerprint=?
 AND o.destination_fingerprint=? AND o.delivered_at IS NULL AND o.discarded_at IS NULL
 AND o.available_at<=? AND o.expires_at>? AND (o.lease_token IS NULL OR o.lease_expires_at<=?)
 AND (d.error_not_before IS NULL OR d.error_not_before<=?) AND (d.all_not_before IS NULL OR d.all_not_before<=?)
ORDER BY o.available_at,o.occurred_at,o.id LIMIT 1`,
		input.Authorization.ConsentGeneration, input.Authorization.DestinationFingerprint,
		input.Authorization.DestinationFingerprint, input.Now, input.Now, input.Now, input.Now, input.Now).
		Scan(&claim.ID, &encoding, &claim.Event.CanonicalEventJSON, &claim.DestinationFingerprint, &claim.ExpiresAt, &claim.AttemptCount)
	if errors.Is(err, sql.ErrNoRows) {
		if err := tx.Commit(); err != nil {
			return ports.AgentSwitchFailureClaim{}, false, err
		}
		return ports.AgentSwitchFailureClaim{}, false, nil
	}
	if err != nil {
		return ports.AgentSwitchFailureClaim{}, false, err
	}
	result, err := tx.ExecContext(ctx, `
UPDATE agent_switch_failure_outbox SET lease_token=?,lease_consent_generation=?,lease_delivery_epoch=?,lease_expires_at=?
WHERE id=? AND destination_fingerprint=? AND delivered_at IS NULL AND discarded_at IS NULL AND expires_at>?
 AND (lease_token IS NULL OR lease_expires_at<=?)
 AND EXISTS(SELECT 1 FROM agent_switch_failure_policy p WHERE p.singleton=1 AND p.enabled=1
   AND p.consent_generation=? AND p.destination_fingerprint=?)
 AND NOT EXISTS(SELECT 1 FROM agent_switch_failure_delivery_state d WHERE d.destination_fingerprint=?
   AND ((d.error_not_before IS NOT NULL AND d.error_not_before>?) OR (d.all_not_before IS NOT NULL AND d.all_not_before>?)))`,
		input.LeaseToken, input.Authorization.ConsentGeneration, input.DeliveryEpoch, input.LeaseExpiresAt,
		claim.ID, claim.DestinationFingerprint, input.Now, input.Now,
		input.Authorization.ConsentGeneration, input.Authorization.DestinationFingerprint,
		input.Authorization.DestinationFingerprint, input.Now, input.Now)
	if err != nil {
		return ports.AgentSwitchFailureClaim{}, false, err
	}
	n, err := result.RowsAffected()
	if err != nil || n != 1 {
		return ports.AgentSwitchFailureClaim{}, false, err
	}
	claim.Event.EventID = claim.ID
	claim.Event.EnvelopeEncodingVersion = encoding
	claim.LeaseToken = input.LeaseToken
	claim.ConsentGeneration = input.Authorization.ConsentGeneration
	claim.DeliveryEpoch = input.DeliveryEpoch
	if err := tx.Commit(); err != nil {
		return ports.AgentSwitchFailureClaim{}, false, err
	}
	return claim, true, nil
}

func (s *Store) BeginAgentSwitchFailureAttempt(ctx context.Context, input ports.AgentSwitchFailureAttempt) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE agent_switch_failure_outbox SET attempt_count=attempt_count+1,last_attempt_at=?
WHERE id=? AND lease_token=? AND lease_consent_generation=? AND lease_delivery_epoch=? AND destination_fingerprint=?
	 AND lease_expires_at IS NOT NULL AND lease_expires_at>? AND expires_at>? AND delivered_at IS NULL AND discarded_at IS NULL
	 AND EXISTS(SELECT 1 FROM agent_switch_failure_policy p WHERE p.singleton=1 AND p.enabled=1 AND p.consent_generation=? AND p.destination_fingerprint=?)
	 AND NOT EXISTS(SELECT 1 FROM agent_switch_failure_delivery_state d WHERE d.destination_fingerprint=? AND ((d.error_not_before IS NOT NULL AND d.error_not_before>?) OR (d.all_not_before IS NOT NULL AND d.all_not_before>?)))`,
		input.Now, input.ID, input.LeaseToken, input.ConsentGeneration, input.DeliveryEpoch,
		input.DestinationFingerprint, input.Now, input.Now, input.ConsentGeneration, input.DestinationFingerprint,
		input.DestinationFingerprint, input.Now, input.Now)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	return n == 1, err
}

func (s *Store) SettleAgentSwitchFailureDelivery(ctx context.Context, input ports.AgentSwitchFailureSettlement) (bool, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	baseArgs := []any{input.ID, input.LeaseToken, input.ConsentGeneration, input.DeliveryEpoch, input.DestinationFingerprint}
	retryNotBefore := input.Result.RetryNotBefore
	var result sql.Result
	switch input.Result.Outcome {
	case ports.DeliveryAccepted:
		result, err = tx.ExecContext(ctx, `UPDATE agent_switch_failure_outbox SET delivered_at=?,lease_token=NULL,lease_consent_generation=NULL,lease_delivery_epoch=NULL,lease_expires_at=NULL,last_delivery_error_class='' WHERE id=? AND lease_token=? AND lease_consent_generation=? AND lease_delivery_epoch=? AND destination_fingerprint=? AND delivered_at IS NULL AND discarded_at IS NULL`, append([]any{input.SettledAt}, baseArgs...)...)
	case ports.DeliveryTransientFailure:
		var expiresAt time.Time
		if err := tx.QueryRowContext(ctx, `
SELECT expires_at FROM agent_switch_failure_outbox
WHERE id=? AND lease_token=? AND lease_consent_generation=? AND lease_delivery_epoch=? AND destination_fingerprint=?
 AND delivered_at IS NULL AND discarded_at IS NULL`, baseArgs...).Scan(&expiresAt); errors.Is(err, sql.ErrNoRows) {
			return false, nil
		} else if err != nil {
			return false, err
		}
		next := input.NextAvailableAt
		if retryNotBefore.After(next) {
			next = retryNotBefore
		}
		if next.After(expiresAt) {
			next = expiresAt
		}
		if input.Result.ThrottleScope != ports.DeliveryThrottleNone {
			retryNotBefore = next
		}
		result, err = tx.ExecContext(ctx, `UPDATE agent_switch_failure_outbox SET available_at=?,lease_token=NULL,lease_consent_generation=NULL,lease_delivery_epoch=NULL,lease_expires_at=NULL,last_delivery_error_class=? WHERE id=? AND lease_token=? AND lease_consent_generation=? AND lease_delivery_epoch=? AND destination_fingerprint=? AND delivered_at IS NULL AND discarded_at IS NULL`, append([]any{next, input.Result.Class}, baseArgs...)...)
	case ports.DeliveryPermanentFailure:
		result, err = tx.ExecContext(ctx, `UPDATE agent_switch_failure_outbox SET discarded_at=?,lease_token=NULL,lease_consent_generation=NULL,lease_delivery_epoch=NULL,lease_expires_at=NULL,last_delivery_error_class=? WHERE id=? AND lease_token=? AND lease_consent_generation=? AND lease_delivery_epoch=? AND destination_fingerprint=? AND delivered_at IS NULL AND discarded_at IS NULL`, append([]any{input.SettledAt, input.Result.Class}, baseArgs...)...)
	case ports.DeliveryPolicyCancelled, ports.DeliveryShutdownCancelled:
		result, err = tx.ExecContext(ctx, `UPDATE agent_switch_failure_outbox SET lease_token=NULL,lease_consent_generation=NULL,lease_delivery_epoch=NULL,lease_expires_at=NULL WHERE id=? AND lease_token=? AND lease_consent_generation=? AND lease_delivery_epoch=? AND destination_fingerprint=? AND delivered_at IS NULL AND discarded_at IS NULL`, baseArgs...)
	default:
		return false, errors.New("settle agent switch failure delivery: invalid outcome")
	}
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	if n != 1 {
		return false, nil
	}
	if retryNotBefore.After(input.SettledAt) && input.Result.ThrottleScope != ports.DeliveryThrottleNone {
		var errorUntil, allUntil any
		if input.Result.ThrottleScope == ports.DeliveryThrottleErrorCategory {
			errorUntil = retryNotBefore
		} else {
			allUntil = retryNotBefore
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO agent_switch_failure_delivery_state(destination_fingerprint,error_not_before,all_not_before) VALUES(?,?,?)
ON CONFLICT(destination_fingerprint) DO UPDATE SET
 error_not_before=CASE WHEN excluded.error_not_before IS NULL THEN error_not_before WHEN error_not_before IS NULL OR excluded.error_not_before>error_not_before THEN excluded.error_not_before ELSE error_not_before END,
 all_not_before=CASE WHEN excluded.all_not_before IS NULL THEN all_not_before WHEN all_not_before IS NULL OR excluded.all_not_before>all_not_before THEN excluded.all_not_before ELSE all_not_before END`, input.DestinationFingerprint, errorUntil, allUntil); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) ExpireAgentSwitchFailurePayloads(ctx context.Context, now time.Time) (int64, error) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	result, err := s.writeDB.ExecContext(ctx, `DELETE FROM agent_switch_failure_outbox WHERE expires_at<=?`, now)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

func (s *Store) ResolveAgentSwitchFailureReceipts(ctx context.Context, input ports.AgentSwitchFailureReceiptResolution) (int64, error) {
	if input.ResolvedAt.IsZero() {
		return 0, errors.New("resolve agent switch failure receipts: timestamp is required")
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `UPDATE agent_switch_failure_receipts SET retain_until=? WHERE switch_id=? AND retain_until IS NULL AND durable_state_fingerprint<>?`, input.ResolvedAt.Add(agentSwitchFailureTTL), input.SwitchID, input.DurableStateFingerprint)
	if err != nil {
		return 0, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	deleted, err := tx.ExecContext(ctx, `DELETE FROM agent_switch_failure_receipts WHERE retain_until IS NOT NULL AND retain_until<=?`, input.ResolvedAt)
	if err != nil {
		return 0, err
	}
	d, err := deleted.RowsAffected()
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return n + d, nil
}

func (s *Store) AgentSwitchFailureBacklog(ctx context.Context, now time.Time) (ports.AgentSwitchFailureBacklog, error) {
	var out ports.AgentSwitchFailureBacklog
	var oldest sql.NullTime
	err := s.readDB.QueryRowContext(ctx, `SELECT
 COALESCE(SUM(CASE WHEN delivered_at IS NULL AND discarded_at IS NULL AND lease_token IS NULL THEN 1 ELSE 0 END),0),
 COALESCE(SUM(CASE WHEN delivered_at IS NULL AND discarded_at IS NULL AND lease_token IS NOT NULL THEN 1 ELSE 0 END),0),
 COALESCE(SUM(CASE WHEN delivered_at IS NOT NULL THEN 1 ELSE 0 END),0),
 COALESCE(SUM(CASE WHEN discarded_at IS NOT NULL THEN 1 ELSE 0 END),0),
 MIN(CASE WHEN delivered_at IS NULL AND discarded_at IS NULL AND available_at<=? THEN available_at END)
FROM agent_switch_failure_outbox`, now).Scan(&out.Pending, &out.Leased, &out.Delivered, &out.Discarded, &oldest)
	if err != nil {
		return ports.AgentSwitchFailureBacklog{}, err
	}
	if oldest.Valid {
		out.OldestDue = oldest.Time
	}
	return out, nil
}
