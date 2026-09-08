package github

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

func checkRunNode(conclusion string, steps any) map[string]any {
	n := map[string]any{
		"__typename": "CheckRun",
		"name":       "build",
		"status":     "COMPLETED",
		"conclusion": conclusion,
	}
	if steps != nil {
		n["steps"] = steps
	}
	return n
}

// A job GitHub refused to start — spending limit reached — arrives as a plain
// FAILURE with no steps and no log. Reporting it as a red check moved the
// owning session to ci_failed and nudged the agent to fix a test that never ran
// (issue #4850, item 3).
func TestCheckStatusNeverStartedJobIsNotAFailure(t *testing.T) {
	got := checkStatusFromGraphQL(checkRunNode("FAILURE", map[string]any{"totalCount": float64(0)}))
	if got != domain.PRCheckUnknown {
		t.Fatalf("status = %q, want %q; a job that never started is not a failing test",
			got, domain.PRCheckUnknown)
	}
}

// The zero-step rule must not swallow real failures.
func TestCheckStatusRealFailuresStillFail(t *testing.T) {
	for _, tc := range []struct {
		name       string
		conclusion string
		steps      any
	}{
		{"failure with steps", "FAILURE", map[string]any{"totalCount": float64(7)}},
		{"failure, steps not requested", "FAILURE", nil},
		{"failure, steps present but unparseable", "FAILURE", map[string]any{"totalCount": "seven"}},
		// A startup failure legitimately records no steps and is a real defect
		// the user must see, so it is deliberately outside the rule.
		{"startup failure with no steps", "STARTUP_FAILURE", map[string]any{"totalCount": float64(0)}},
		{"timed out with no steps", "TIMED_OUT", map[string]any{"totalCount": float64(0)}},
		{"action required with no steps", "ACTION_REQUIRED", map[string]any{"totalCount": float64(0)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := checkStatusFromGraphQL(checkRunNode(tc.conclusion, tc.steps)); got != domain.PRCheckFailed {
				t.Fatalf("status = %q, want %q", got, domain.PRCheckFailed)
			}
		})
	}
}

// The rollup must not report CIFailing when its only red context is a job that
// never started — that is what reached the session as ci_failed.
func TestCISummaryNeverStartedJobIsNotFailing(t *testing.T) {
	pr := map[string]any{"commits": map[string]any{"nodes": []any{map[string]any{
		"commit": map[string]any{"statusCheckRollup": map[string]any{
			"state": "FAILURE",
			"contexts": map[string]any{
				"nodes": []any{checkRunNode("FAILURE", map[string]any{"totalCount": float64(0)})},
			},
		}},
	}}}}
	if got := ciSummaryFromGraphQL(pr); got == domain.CIFailing {
		t.Fatalf("ci summary = %q, want anything but CIFailing for a never-started job", got)
	}
}
