package domain

import (
	"strings"
	"testing"
)

func TestNativeReviewConfigValidation(t *testing.T) {
	valid := []AgentConfig{
		{Mode: "native-review"},
		{Mode: "native-review", NativeReview: &NativeReviewConfig{Effort: "medium", TimeoutMinutes: 120}},
		{Mode: "native-review", NativeReview: &NativeReviewConfig{Comment: true}},
		{Mode: "native-review", NativeReview: &NativeReviewConfig{Effort: "high", Comment: true}},
	}
	for _, config := range valid {
		if err := config.Validate(); err != nil {
			t.Fatalf("Validate(%+v): %v", config, err)
		}
	}
	invalid := []AgentConfig{
		{NativeReview: &NativeReviewConfig{}},
		{Mode: "native-review", NativeReview: &NativeReviewConfig{Effort: "ultra"}},
		{Mode: "native-review", NativeReview: &NativeReviewConfig{Effort: "medium", Comment: true}},
		{Mode: "native-review", NativeReview: &NativeReviewConfig{TimeoutMinutes: -1}},
	}
	for _, config := range invalid {
		if err := config.Validate(); err == nil {
			t.Fatalf("Validate(%+v) unexpectedly succeeded", config)
		}
	}
}

func TestNativeReviewConfigValidationDoesNotAcceptUnrestrictedMode(t *testing.T) {
	err := (AgentConfig{Mode: "qwen review run --yolo"}).Validate()
	if err == nil || !strings.Contains(err.Error(), "invalid mode") {
		t.Fatalf("Validate error = %v", err)
	}
}

func TestAgentConfigEqualComparesNativeOptionsByValue(t *testing.T) {
	left := AgentConfig{Mode: "native-review", NativeReview: &NativeReviewConfig{Effort: "high", Quiet: true}}
	right := AgentConfig{Mode: "native-review", NativeReview: &NativeReviewConfig{Effort: "high", Quiet: true}}
	if !left.Equal(right) {
		t.Fatal("equal native-review values compared unequal")
	}
	if (AgentConfig{Mode: "native-review"}).Equal(AgentConfig{Mode: "native-review", NativeReview: &NativeReviewConfig{Effort: "high"}}) {
		t.Fatal("different native-review values compared equal")
	}
}

func TestNativeReviewConfigIsQwenReviewerOnly(t *testing.T) {
	config := AgentConfig{Mode: "native-review", NativeReview: &NativeReviewConfig{Effort: "high"}}
	if err := config.ValidateReviewer(ReviewerQwen); err != nil {
		t.Fatalf("Qwen native review rejected: %v", err)
	}
	if err := config.ValidateReviewer(ReviewerClaudeCode); err == nil {
		t.Fatal("non-Qwen native review unexpectedly accepted")
	}
}

func TestProjectConfigRestrictsNativeReviewToQwenReviewer(t *testing.T) {
	native := AgentConfig{Mode: "native-review", NativeReview: &NativeReviewConfig{Effort: "medium"}}
	if err := (ProjectConfig{Reviewers: []ReviewerConfig{{Harness: ReviewerQwen, AgentConfig: native}}}).Validate(); err != nil {
		t.Fatalf("Qwen reviewer project config rejected: %v", err)
	}
	if err := (ProjectConfig{Reviewers: []ReviewerConfig{{Harness: ReviewerClaudeCode, AgentConfig: native}}}).Validate(); err == nil {
		t.Fatal("non-Qwen reviewer project config unexpectedly accepted")
	}
	if err := (ProjectConfig{AgentConfig: native}).Validate(); err == nil {
		t.Fatal("worker native-review config unexpectedly accepted")
	}
}
