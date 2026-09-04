package review

import (
	"context"
	"errors"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func TestMergeReviewerAgentConfigIncludesNativeReviewOptions(t *testing.T) {
	base := domain.AgentConfig{Mode: "native-review", NativeReview: &domain.NativeReviewConfig{Effort: "medium"}}
	override := domain.AgentConfig{NativeReview: &domain.NativeReviewConfig{Effort: "high", Quiet: true}}
	got := mergeReviewerAgentConfig(base, override)
	if got.NativeReview == nil || got.NativeReview.Effort != "high" || !got.NativeReview.Quiet {
		t.Fatalf("merged native review config = %+v", got.NativeReview)
	}
	if got.NativeReview == override.NativeReview {
		t.Fatal("merge retained the caller's mutable native-review pointer")
	}
}

func TestTriggerRejectsAnUnknownHarnessOverride(t *testing.T) {
	eng := New(Deps{})

	_, err := eng.Trigger(context.Background(), "mer-1", "not-a-reviewer", domain.AgentConfig{})
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("err = %v, want ErrInvalid", err)
	}
}
