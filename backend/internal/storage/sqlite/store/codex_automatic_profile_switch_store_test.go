package store_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestCodexAutomaticProfileSwitchPolicySyntheticAndCAS(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	seedProject(t, store, "auto-policy")
	rec := sampleRecord("auto-policy")
	rec.Harness = domain.HarnessCodex
	session, err := store.CreateSession(ctx, rec)
	if err != nil {
		t.Fatal(err)
	}
	policy, found, err := store.GetCodexAutomaticProfileSwitchPolicy(ctx, session.ID)
	if err != nil || found || policy.Enabled || policy.Revision != 0 || policy.ChainRootSessionID != session.ID {
		t.Fatalf("synthetic policy = %+v found=%v err=%v", policy, found, err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	policy, err = store.PutCodexAutomaticProfileSwitchPolicy(ctx, session.ID, true, []string{"profile-b", "profile-c"}, 0, now)
	if err != nil || !policy.Enabled || policy.Revision != 1 {
		t.Fatalf("first policy = %+v err=%v", policy, err)
	}
	policy, err = store.PutCodexAutomaticProfileSwitchPolicy(ctx, session.ID, false, []string{"profile-c", "profile-b"}, 1, now.Add(time.Second))
	if err != nil || policy.Enabled || policy.Revision != 2 {
		t.Fatalf("updated policy = %+v err=%v", policy, err)
	}
	if _, err := store.PutCodexAutomaticProfileSwitchPolicy(ctx, session.ID, true, []string{"profile-b"}, 1, now.Add(2*time.Second)); !errors.Is(err, domain.ErrCodexAutomaticProfileSwitchPolicyRevisionConflict) {
		t.Fatalf("stale revision error = %v", err)
	}
	reloaded, found, err := store.GetCodexAutomaticProfileSwitchPolicy(ctx, session.ID)
	if err != nil || !found || reloaded.Enabled || reloaded.Revision != 2 || len(reloaded.ProfileIDs) != 2 || reloaded.ProfileIDs[0] != "profile-c" {
		t.Fatalf("reloaded policy = %+v found=%v err=%v", reloaded, found, err)
	}
}

func TestCodexAutomaticProfileSwitchAttemptFingerprintIsIdempotent(t *testing.T) {
	store := newTestStore(t)
	ctx := context.Background()
	seedProject(t, store, "auto-attempt")
	rec := sampleRecord("auto-attempt")
	rec.Harness = domain.HarnessCodex
	session, err := store.CreateSession(ctx, rec)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	if _, err := store.PutCodexAutomaticProfileSwitchPolicy(ctx, session.ID, true, []string{"profile-b"}, 0, now); err != nil {
		t.Fatal(err)
	}
	evidence := domain.CodexExhaustionEvidence{SessionID: session.ID, ProfileID: "existing", Generation: "generation-1", EpisodeID: "turn-1"}
	attempt := domain.CodexAutomaticProfileSwitchAttempt{
		ID: "attempt-1", ChainRootSessionID: session.ID, SourceSessionID: session.ID, SourceProfileID: "existing",
		SourceGenerationID: "generation-1", SourceEpisodeID: "turn-1", Trigger: domain.CodexAutomaticProfileSwitchUsageLimitFailure,
		ExhaustionFingerprint: domain.CodexAutomaticProfileSwitchFingerprint(evidence), PolicyRevision: 1,
		State: domain.CodexAutomaticProfileSwitchEvaluating, OutcomeCode: domain.CodexAutomaticSwitchOutcomeEvaluating,
		CreatedAt: now, UpdatedAt: now,
	}
	stored, created, err := store.CreateCodexAutomaticProfileSwitchAttempt(ctx, attempt)
	if err != nil || !created {
		t.Fatalf("create attempt: %+v created=%v err=%v", stored, created, err)
	}
	retry := attempt
	retry.ID = "attempt-2"
	stored, created, err = store.CreateCodexAutomaticProfileSwitchAttempt(ctx, retry)
	if err != nil || created || stored.ID != attempt.ID {
		t.Fatalf("retry attempt: %+v created=%v err=%v", stored, created, err)
	}
}
