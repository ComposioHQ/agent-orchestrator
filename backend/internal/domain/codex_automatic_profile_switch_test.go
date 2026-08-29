package domain

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestCodexAutomaticProfileSwitchFingerprintCoalescesTriggerKinds(t *testing.T) {
	base := CodexExhaustionEvidence{SessionID: "ao-1", ProfileID: "existing", Generation: "generation-1", EpisodeID: "turn-1", Trigger: CodexAutomaticProfileSwitchUsageLimitFailure}
	first := CodexAutomaticProfileSwitchFingerprint(base)
	base.Trigger = CodexAutomaticProfileSwitchCapacityEvent
	if second := CodexAutomaticProfileSwitchFingerprint(base); first != second {
		t.Fatalf("matching exhaustion episode did not coalesce: %q != %q", first, second)
	}
	base.EpisodeID = "turn-2"
	if next := CodexAutomaticProfileSwitchFingerprint(base); next == first {
		t.Fatal("different exhaustion episode reused fingerprint")
	}
}

func TestCodexAutomaticProfileSwitchTransitions(t *testing.T) {
	if !ValidCodexAutomaticProfileSwitchTransition(CodexAutomaticProfileSwitchEvaluating, CodexAutomaticProfileSwitchDelegatedToPhase5) {
		t.Fatal("evaluation could not delegate to Phase 5")
	}
	if !ValidCodexAutomaticProfileSwitchTransition(CodexAutomaticProfileSwitchDelegatedToPhase5, CodexAutomaticProfileSwitchNeedsAttention) {
		t.Fatal("delegated failure could not enter attention state")
	}
	if ValidCodexAutomaticProfileSwitchTransition(CodexAutomaticProfileSwitchNoCandidate, CodexAutomaticProfileSwitchEvaluating) {
		t.Fatal("terminal no-candidate attempt restarted")
	}
}

func TestCodexAutomaticProfileSwitchJSONRedactsEvidence(t *testing.T) {
	completed := time.Now().UTC()
	attempt := CodexAutomaticProfileSwitchAttempt{
		ID: "attempt-1", ChainRootSessionID: "root-1", SourceSessionID: "ao-1", SourceProfileID: "existing",
		SourceGenerationID: "generation-private", SourceEpisodeID: "episode-private",
		ExhaustionFingerprint: "v1:" + strings.Repeat("a", 64), ProfileSwitchID: ptrCodexProfileSwitchID("switch-1"),
		State: CodexAutomaticProfileSwitchCompleted, Trigger: CodexAutomaticProfileSwitchCapacityRead,
		OutcomeCode: CodexAutomaticSwitchOutcomeCompleted, CreatedAt: completed, UpdatedAt: completed, CompletedAt: &completed,
	}
	body, err := json.Marshal(attempt)
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"root-1", "generation-private", "episode-private", strings.Repeat("a", 64), "switch-1"} {
		if strings.Contains(string(body), private) {
			t.Fatalf("private field %q leaked in %s", private, body)
		}
	}
}

func ptrCodexProfileSwitchID(value CodexProfileSwitchID) *CodexProfileSwitchID { return &value }
