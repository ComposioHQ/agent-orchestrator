package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestCodexProfileSwitchPersistsImmutableContinuationAndArchivesSource(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	seedProject(t, store, "profile-switch")
	now := time.Now().UTC().Truncate(time.Second)
	sourceSeed := sampleRecord("profile-switch")
	sourceSeed.Harness = domain.HarnessCodex
	sourceSeed.Mode = domain.SessionModeTUI
	sourceSeed.Metadata.RuntimeLaunchID = "source-generation"
	sourceSeed.CodexProfileBinding = &domain.CodexSessionBinding{ProfileID: "existing", Source: domain.CodexProfileSourceExisting, Home: "/tmp/existing", CreatedAt: now}
	source, err := store.CreateSession(ctx, sourceSeed)
	if err != nil {
		t.Fatal(err)
	}
	sw := domain.CodexProfileSwitch{
		ID: "profile-switch-1", SourceSessionID: source.ID, SourceProfileID: "existing", TargetProfileID: "00000000-0000-4000-8000-000000000001",
		IdempotencyKey: "key-1", RequestFingerprint: domain.ComputeCodexProfileSwitchRequestFingerprint(source.ID, "00000000-0000-4000-8000-000000000001", false),
		Trigger: domain.CodexProfileSwitchTriggerManual, Phase: domain.CodexProfileSwitchRequested, WorkspaceOwner: domain.CodexProfileSwitchOwnerSource,
		SourceGenerationID: "source-generation", SemanticHandoffStatus: domain.AgentHandoffNotAttempted, HandoffClassification: domain.CodexProfileSwitchHandoffPending,
		RequestedAt: now, UpdatedAt: now,
	}
	created, inserted, err := store.CreateCodexProfileSwitch(ctx, sw)
	if err != nil || !inserted {
		t.Fatalf("create switch: inserted=%v err=%v", inserted, err)
	}
	if identical, inserted, err := store.CreateCodexProfileSwitch(ctx, sw); err != nil || inserted || identical.ID != sw.ID {
		t.Fatalf("idempotent create: switch=%+v inserted=%v err=%v", identical, inserted, err)
	}

	advance := func(next domain.CodexProfileSwitchPhase, mutate func(*domain.CodexProfileSwitch)) {
		t.Helper()
		expected := created.Phase
		expectedTarget := created.TargetGenerationID
		if mutate != nil {
			mutate(&created)
		}
		created.Phase = next
		created.UpdatedAt = created.UpdatedAt.Add(time.Second)
		ok, updateErr := store.UpdateCodexProfileSwitch(ctx, created, expected, created.SourceGenerationID, expectedTarget)
		if updateErr != nil || !ok {
			t.Fatalf("advance %s -> %s: ok=%v err=%v", expected, next, ok, updateErr)
		}
	}
	advance(domain.CodexProfileSwitchWaitingForSafeBoundary, nil)
	advance(domain.CodexProfileSwitchPreparingHandoff, nil)
	advance(domain.CodexProfileSwitchStoppingSource, nil)
	advance(domain.CodexProfileSwitchSourceStopped, func(next *domain.CodexProfileSwitch) { next.WorkspaceOwner = domain.CodexProfileSwitchOwnerSwitch })

	targetSeed := source
	targetSeed.ID = ""
	targetSeed.Metadata.RuntimeHandleID = ""
	targetSeed.Metadata.RuntimeLaunchID = ""
	targetSeed.ArchivedAt = nil
	targetBinding := domain.CodexSessionBinding{ProfileID: created.TargetProfileID, Source: domain.CodexProfileSourceManaged, Home: "/tmp/managed", CreatedAt: created.UpdatedAt}
	target, created, err := store.CreateCodexProfileSwitchTarget(ctx, created, targetSeed, targetBinding, created.UpdatedAt.Add(time.Second))
	if err != nil || created.TargetSessionID == nil || *created.TargetSessionID != target.ID {
		t.Fatalf("create target: target=%+v switch=%+v err=%v", target, created, err)
	}
	advance(domain.CodexProfileSwitchStartingTarget, func(next *domain.CodexProfileSwitch) { next.TargetGenerationID = "target-generation" })
	advance(domain.CodexProfileSwitchTargetReady, nil)
	advance(domain.CodexProfileSwitchDeliveringHandoff, nil)
	ackAt := created.UpdatedAt.Add(time.Second)
	if _, ok, err := store.CompleteCodexProfileSwitch(ctx, created, ackAt); !errors.Is(err, domain.ErrCodexProfileSwitchTransitionConflict) || ok {
		t.Fatalf("complete before acknowledgement: ok=%v err=%v", ok, err)
	}
	if ok, err := store.AcknowledgeCodexProfileSwitchTarget(ctx, created.ID, target.ID, created.TargetGenerationID, ackAt); err != nil || !ok {
		t.Fatalf("ack target: ok=%v err=%v", ok, err)
	}
	created.TargetAcknowledgedAt = &ackAt
	completed, ok, err := store.CompleteCodexProfileSwitch(ctx, created, ackAt)
	if err != nil || !ok || completed.Phase != domain.CodexProfileSwitchCompleted {
		t.Fatalf("complete switch: completed=%+v ok=%v err=%v", completed, ok, err)
	}
	reloadedSource, found, err := store.GetSession(ctx, source.ID)
	if err != nil || !found || reloadedSource.ArchivedAt == nil {
		t.Fatalf("archived source: found=%v archived=%v err=%v", found, reloadedSource.ArchivedAt, err)
	}
	second := sw
	second.ID, second.IdempotencyKey = "profile-switch-2", "key-2"
	second.RequestFingerprint = domain.ComputeCodexProfileSwitchRequestFingerprint(source.ID, second.TargetProfileID, true)
	second.AcknowledgeUnknownCapacity = true
	if _, _, err := store.CreateCodexProfileSwitch(ctx, second); !errors.Is(err, domain.ErrCodexProfileSwitchTransitionConflict) {
		t.Fatalf("second continuation error = %v", err)
	}
}

func TestCodexProfileSwitchCanRestoreSourceBeforeTargetAllocation(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	seedProject(t, store, "profile-switch-restore")
	now := time.Now().UTC().Truncate(time.Second)
	sourceSeed := sampleRecord("profile-switch-restore")
	sourceSeed.Harness = domain.HarnessCodex
	sourceSeed.Metadata.RuntimeLaunchID = "source-generation"
	sourceSeed.CodexProfileBinding = &domain.CodexSessionBinding{ProfileID: "existing", Source: domain.CodexProfileSourceExisting, Home: "/tmp/existing", CreatedAt: now}
	source, err := store.CreateSession(ctx, sourceSeed)
	if err != nil {
		t.Fatal(err)
	}
	sw := domain.CodexProfileSwitch{
		ID: "profile-switch-restore-1", SourceSessionID: source.ID, SourceProfileID: "existing", TargetProfileID: "managed-1",
		IdempotencyKey: "restore-key", RequestFingerprint: domain.ComputeCodexProfileSwitchRequestFingerprint(source.ID, "managed-1", false),
		Trigger: domain.CodexProfileSwitchTriggerManual, Phase: domain.CodexProfileSwitchRequested, WorkspaceOwner: domain.CodexProfileSwitchOwnerSource,
		SourceGenerationID: "source-generation", SemanticHandoffStatus: domain.AgentHandoffNotAttempted,
		HandoffClassification: domain.CodexProfileSwitchHandoffPending, RequestedAt: now, UpdatedAt: now,
	}
	sw, _, err = store.CreateCodexProfileSwitch(ctx, sw)
	if err != nil {
		t.Fatal(err)
	}
	for _, phase := range []domain.CodexProfileSwitchPhase{domain.CodexProfileSwitchWaitingForSafeBoundary, domain.CodexProfileSwitchPreparingHandoff, domain.CodexProfileSwitchRecoveryRequired} {
		previous := sw.Phase
		sw.Phase = phase
		sw.UpdatedAt = sw.UpdatedAt.Add(time.Second)
		if phase == domain.CodexProfileSwitchRecoveryRequired {
			sw.WorkspaceOwner = domain.CodexProfileSwitchOwnerRecovery
		}
		if ok, updateErr := store.UpdateCodexProfileSwitch(ctx, sw, previous, sw.SourceGenerationID, sw.TargetGenerationID); updateErr != nil || !ok {
			t.Fatalf("advance to %s: ok=%v err=%v", phase, ok, updateErr)
		}
	}
	restored, ok, err := store.RestoreCodexProfileSwitchSource(ctx, sw, sw.UpdatedAt.Add(time.Second))
	if err != nil || !ok || restored.TargetSessionID != nil || restored.WorkspaceOwner != domain.CodexProfileSwitchOwnerRecovery {
		t.Fatalf("restore before target: restored=%+v ok=%v err=%v", restored, ok, err)
	}
}
