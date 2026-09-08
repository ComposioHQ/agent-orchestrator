package lifecycle

import (
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func failedCheck(name, commit, url, logTail string) ports.PRCheckObservation {
	return ports.PRCheckObservation{
		Name: name, CommitHash: commit, Status: "failed", URL: url, LogTail: logTail,
	}
}

// GitHub mints a fresh check-run URL for every attempt. Including it in the
// signature meant a re-run of an unchanged failure looked new, so the agent was
// nudged again on each retry — eight times in 40 minutes during a spending-limit
// outage, where every attempt was the identical refusal (issue #4850, item 3).
func TestCIFailureSignatureIgnoresPerAttemptURL(t *testing.T) {
	first := []ports.PRCheckObservation{failedCheck("build", "abc123", "https://github.com/o/r/runs/1", "boom")}
	rerun := []ports.PRCheckObservation{failedCheck("build", "abc123", "https://github.com/o/r/runs/2", "boom")}

	if ciFailureSignature(first) != ciFailureSignature(rerun) {
		t.Fatal("signature changed across a re-run of the same failure; the agent would be nudged again")
	}
}

// A genuinely different failure must still be distinguishable, or the dedupe
// would swallow real news.
func TestCIFailureSignatureStillSeparatesRealChanges(t *testing.T) {
	base := []ports.PRCheckObservation{failedCheck("build", "abc123", "u1", "boom")}
	for _, tc := range []struct {
		name  string
		other []ports.PRCheckObservation
	}{
		{"new commit", []ports.PRCheckObservation{failedCheck("build", "def456", "u1", "boom")}},
		{"different log", []ports.PRCheckObservation{failedCheck("build", "abc123", "u1", "different")}},
		{"different check", []ports.PRCheckObservation{failedCheck("lint", "abc123", "u1", "boom")}},
		{"extra failing check", append([]ports.PRCheckObservation{}, base[0], failedCheck("lint", "abc123", "u2", "x"))},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if ciFailureSignature(base) == ciFailureSignature(tc.other) {
				t.Fatal("signature did not change for a materially different failure")
			}
		})
	}
}
