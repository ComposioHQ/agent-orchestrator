package nativeqwen

import (
	"context"
	"reflect"
	"testing"
	"time"
)

func TestArgsBuildsOnlyTypedNativeReviewFlags(t *testing.T) {
	task := Task{Target: "https://github.com/o/r/pull/42", Options: Options{
		Effort: "high", Comment: true, Resume: true, Quiet: true, TimeoutMinutes: 9,
	}}
	got, err := Args(task)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"review", "run", "https://github.com/o/r/pull/42",
		"--effort", "high", "--json", "--fail-on", "request-changes",
		"--comment", "--resume", "--quiet", "--timeout-minutes", "9",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Args() = %#v, want %#v", got, want)
	}
}

func TestOptionsRejectsCommentWithLowerEffort(t *testing.T) {
	for _, effort := range []string{"low", "medium"} {
		if err := (Options{Effort: effort, Comment: true}).Validate(); err == nil {
			t.Fatalf("effort %q with comment unexpectedly valid", effort)
		}
	}
}

func TestParseMapsDocumentedExitContract(t *testing.T) {
	tests := []struct {
		name     string
		json     string
		exitCode int
		status   string
		verdict  string
	}{
		{"approve", `{"completed":true,"event":"APPROVE","verdictLine":"Verdict: Approve","cappedBy":[],"remediation":[],"childExitCode":0}`, 0, "complete", "approved"},
		{"comment with suffix", `{"completed":true,"event":"COMMENT","verdictLine":"Verdict: Comment — Request changes was downgraded","cappedBy":["self-authored PR"],"remediation":["review manually"]}`, 0, "complete", "comment"},
		{"request changes", `{"completed":true,"event":"REQUEST_CHANGES","verdictLine":"Verdict: Request changes (2 Critical)","cappedBy":[]}`, 3, "complete", "changes_requested"},
		{"completed without event", `{"completed":true,"event":null,"verdictLine":null,"cappedBy":[],"remediation":[]}`, 0, "complete", "comment"},
		{"provider failure", `{"completed":false,"timedOut":true}`, 1, "failed", ""},
		{"malformed", `{nope`, 0, "failed", ""},
		{"exit mismatch", `{"completed":true,"event":"REQUEST_CHANGES","verdictLine":"Verdict: Request changes"}`, 0, "failed", ""},
		{"event mismatch", `{"completed":true,"event":"APPROVE","verdictLine":"Verdict: Comment"}`, 0, "failed", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Parse([]byte(tt.json), tt.exitCode)
			if got.Status != tt.status || got.Verdict != tt.verdict {
				t.Fatalf("Parse() = status %q verdict %q reason %q", got.Status, got.Verdict, got.Reason)
			}
		})
	}
}

func TestRunHonorsCancelledContextBeforeStart(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err := Run(ctx, "does-not-run", t.TempDir(), Task{Target: "target"}, nil)
	if err == nil {
		t.Fatal("Run() error = nil, want cancellation/start failure")
	}
}

func TestTaskTimeoutBoundsProviderContext(t *testing.T) {
	ctx, cancel := withTaskTimeout(context.Background(), 2)
	defer cancel()
	deadline, ok := ctx.Deadline()
	if !ok {
		t.Fatal("configured native review timeout did not set a process deadline")
	}
	remaining := time.Until(deadline)
	if remaining <= time.Minute || remaining > 2*time.Minute {
		t.Fatalf("process deadline is %s away, want at most two minutes", remaining)
	}
}
