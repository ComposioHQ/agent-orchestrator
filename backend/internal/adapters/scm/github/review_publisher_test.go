package github

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestReviewPublisherPostsInlineFinding(t *testing.T) {
	var gotArgs []string
	var gotInput []byte
	publisher := &reviewPublisher{execute: func(_ context.Context, args []string, input []byte) ([]byte, error) {
		gotArgs = append([]string(nil), args...)
		gotInput = append([]byte(nil), input...)
		return []byte(`{"id":12345}`), nil
	}}

	id, err := publisher.Publish(context.Background(), "https://github.com/acme/widgets/pull/42", "deadbeef", "## Greptile review", []ports.ReviewComment{{
		Path: "pkg/widget.go", StartLine: 10, EndLine: 12, Side: "RIGHT", Body: "This can panic.", Suggestion: "Guard the nil value.",
	}})
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if id != "12345" {
		t.Fatalf("id = %q, want 12345", id)
	}
	if len(gotArgs) != 7 || gotArgs[0] != "gh" || gotArgs[1] != "api" || gotArgs[len(gotArgs)-1] != "repos/acme/widgets/pulls/42/reviews" {
		t.Fatalf("args = %#v", gotArgs)
	}
	var payload struct {
		CommitID string `json:"commit_id"`
		Event    string `json:"event"`
		Comments []struct {
			Path      string `json:"path"`
			Line      int    `json:"line"`
			StartLine int    `json:"start_line"`
			Body      string `json:"body"`
		} `json:"comments"`
	}
	if err := json.Unmarshal(gotInput, &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if payload.CommitID != "deadbeef" || payload.Event != "COMMENT" || len(payload.Comments) != 1 {
		t.Fatalf("payload = %+v", payload)
	}
	comment := payload.Comments[0]
	if comment.Path != "pkg/widget.go" || comment.Line != 12 || comment.StartLine != 10 || comment.Body != "This can panic.\n\nSuggested fix:\nGuard the nil value." {
		t.Fatalf("inline comment = %+v", comment)
	}
}

func TestReviewPublisherPostsSummaryWithoutInlineFindings(t *testing.T) {
	var gotInput []byte
	publisher := &reviewPublisher{execute: func(_ context.Context, _ []string, input []byte) ([]byte, error) {
		gotInput = append([]byte(nil), input...)
		return []byte(`{"id":99}`), nil
	}}

	if _, err := publisher.Publish(context.Background(), "https://github.com/acme/widgets/pull/42", "deadbeef", "No actionable findings.", nil); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	var payload reviewPayload
	if err := json.Unmarshal(gotInput, &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if payload.Body != "No actionable findings." || len(payload.Comments) != 0 {
		t.Fatalf("payload = %+v", payload)
	}
}

func TestReviewPublisherFallsBackToSummaryForInvalidInlineLocation(t *testing.T) {
	var inputs [][]byte
	publisher := &reviewPublisher{execute: func(_ context.Context, _ []string, input []byte) ([]byte, error) {
		inputs = append(inputs, append([]byte(nil), input...))
		if len(inputs) == 1 {
			return nil, errors.New("gh: Validation Failed (HTTP 422)")
		}
		return []byte(`{"id":100}`), nil
	}}

	id, err := publisher.Publish(context.Background(), "https://github.com/acme/widgets/pull/42", "deadbeef", "Finding in widget.go.", []ports.ReviewComment{{
		Path: "pkg/widget.go", StartLine: 12, Body: "This can panic.",
	}})
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}
	if id != "100" || len(inputs) != 2 {
		t.Fatalf("id = %q, attempts = %d", id, len(inputs))
	}
	var fallback reviewPayload
	if err := json.Unmarshal(inputs[1], &fallback); err != nil {
		t.Fatalf("fallback payload: %v", err)
	}
	if len(fallback.Comments) != 0 || !strings.Contains(fallback.Body, "All findings are included") {
		t.Fatalf("fallback payload = %+v", fallback)
	}
}

func TestReviewPublisherDoesNotRetryAuthenticationFailure(t *testing.T) {
	attempts := 0
	publisher := &reviewPublisher{execute: func(_ context.Context, _ []string, _ []byte) ([]byte, error) {
		attempts++
		return nil, errors.New("gh: authentication required (HTTP 401)")
	}}

	_, err := publisher.Publish(context.Background(), "https://github.com/acme/widgets/pull/42", "deadbeef", "Finding.", []ports.ReviewComment{{
		Path: "pkg/widget.go", StartLine: 12, Body: "This can panic.",
	}})
	if err == nil {
		t.Fatal("expected authentication failure")
	}
	if attempts != 1 {
		t.Fatalf("attempts = %d, want 1", attempts)
	}
}

func TestPullRequestRefRejectsNonGitHubURL(t *testing.T) {
	if _, _, _, err := pullRequestRef("https://example.com/acme/widgets/pull/42"); err == nil {
		t.Fatal("expected non-GitHub URL to be rejected")
	}
}
