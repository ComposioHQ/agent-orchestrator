package greptile

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestReviewCommandUsesJSONAndPRBaseBranch(t *testing.T) {
	command, err := New().ReviewCommand(context.Background(), ports.ReviewInvocation{
		ReviewQueue: []ports.ReviewTask{{TargetBranch: "develop"}},
		ReviewIndex: 0,
	})
	if err != nil {
		t.Fatalf("ReviewCommand: %v", err)
	}
	got := strings.Join(command.Argv, " ")
	if got != "greptile review --json --branch develop" {
		t.Fatalf("command = %q", got)
	}
}

func TestNativeReviewCommandLeavesOutputForTheCLIUI(t *testing.T) {
	command := New().nativeReviewCommand(context.Background(), ports.ReviewInvocation{
		ReviewQueue: []ports.ReviewTask{{TargetBranch: "develop"}},
		ReviewIndex: 0,
	})
	if got, want := strings.Join(command.Argv, " "), "greptile review --branch develop"; got != want {
		t.Fatalf("native command = %q, want %q", got, want)
	}
}

func TestGreptileAuthStatusFromWhoamiOutput(t *testing.T) {
	tests := []struct {
		name   string
		output string
		want   ports.AgentAuthStatus
		known  bool
	}{
		{name: "signed in", output: "Signed in as reviewer@example.com", want: ports.AgentAuthStatusAuthorized, known: true},
		{name: "not signed in", output: "Not signed in. Run `greptile login`.", want: ports.AgentAuthStatusUnauthorized, known: true},
		{name: "invalid key", output: "error: API key invalid or revoked", want: ports.AgentAuthStatusUnauthorized, known: true},
		{name: "network failure", output: "error: request failed", want: ports.AgentAuthStatusUnknown, known: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, known := greptileAuthStatusFromOutput([]byte(tt.output))
			if got != tt.want || known != tt.known {
				t.Fatalf("greptileAuthStatusFromOutput(%q) = (%q, %v), want (%q, %v)", tt.output, got, known, tt.want, tt.known)
			}
		})
	}
}

func TestGreptileLocalAuthStatus(t *testing.T) {
	tests := []struct {
		name     string
		contents string
		apiKey   string
		want     ports.AgentAuthStatus
		known    bool
	}{
		{name: "missing", want: ports.AgentAuthStatusUnknown, known: false},
		{name: "oauth refresh token", contents: `{"method":"oauth","refreshToken":"refresh"}`, want: ports.AgentAuthStatusAuthorized, known: true},
		{name: "legacy oauth file", contents: `{"accessToken":"access"}`, want: ports.AgentAuthStatusAuthorized, known: true},
		{name: "api key file", contents: `{"method":"apikey","apiKey":"key"}`, want: ports.AgentAuthStatusAuthorized, known: true},
		{name: "environment api key", apiKey: "key", want: ports.AgentAuthStatusAuthorized, known: true},
		{name: "empty credentials", contents: `{"method":"oauth"}`, want: ports.AgentAuthStatusUnknown, known: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "auth.json")
			if tt.contents != "" {
				if err := os.WriteFile(path, []byte(tt.contents), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			got, known, err := greptileLocalAuthStatusAt(path, tt.apiKey)
			if err != nil {
				t.Fatalf("greptileLocalAuthStatusAt: %v", err)
			}
			if got != tt.want || known != tt.known {
				t.Fatalf("greptileLocalAuthStatusAt = (%q, %v), want (%q, %v)", got, known, tt.want, tt.known)
			}
		})
	}
}

func TestParseReviewResultWithFindings(t *testing.T) {
	result, err := New().ParseReviewResult([]byte(`{
		"summary":"Adds the reviewer integration.",
		"confidence":3,
		"confidenceReasoning":"One issue should be fixed.",
		"securitySummary":"No broad security concerns.",
		"comments":[{
			"path":"backend/reviewer.go",
			"startLine":41,
			"endLine":43,
			"severity":"P1",
			"securityIssue":true,
			"body":"Cancellation can race completion.",
			"suggestion":"Guard the active job id."
		}]
	}`))
	if err != nil {
		t.Fatalf("ParseReviewResult: %v", err)
	}
	if result.Verdict != domain.VerdictChangesRequested {
		t.Fatalf("verdict = %q", result.Verdict)
	}
	for _, want := range []string{
		"## Greptile review",
		"**Confidence:** 3/5",
		"P1 · Security · `backend/reviewer.go:41-43`",
		"Cancellation can race completion.",
		"> Guard the active job id.",
	} {
		if !strings.Contains(result.Body, want) {
			t.Errorf("body missing %q:\n%s", want, result.Body)
		}
	}
}

func TestParseReviewResultWithoutFindingsApproves(t *testing.T) {
	result, err := New().ParseReviewResult([]byte(`{"summary":"Looks good.","confidence":5,"comments":[]}`))
	if err != nil {
		t.Fatalf("ParseReviewResult: %v", err)
	}
	if result.Verdict != domain.VerdictApproved {
		t.Fatalf("verdict = %q", result.Verdict)
	}
	if !strings.Contains(result.Body, "No actionable findings.") {
		t.Fatalf("body = %q", result.Body)
	}
}

func TestParseReviewResultDoesNotApproveWithoutFiveConfidence(t *testing.T) {
	for _, input := range []string{
		`{"summary":"Looks good.","confidence":4,"comments":[]}`,
		`{"summary":"Looks good.","comments":[]}`,
	} {
		result, err := New().ParseReviewResult([]byte(input))
		if err != nil {
			t.Fatalf("ParseReviewResult(%s): %v", input, err)
		}
		if result.Verdict != domain.VerdictChangesRequested {
			t.Errorf("ParseReviewResult(%s) verdict = %q, want changes_requested", input, result.Verdict)
		}
		if !strings.Contains(result.Body, "marked this review as changes requested") {
			t.Errorf("ParseReviewResult(%s) body missing explanation: %q", input, result.Body)
		}
	}
}

func TestParseReviewResultMapsGreptileSides(t *testing.T) {
	result, err := New().ParseReviewResult([]byte(`{"confidence":5,"comments":[{"path":"old.go","side":"old","startLine":2,"body":"old finding"},{"path":"new.go","side":"new","startLine":3,"body":"new finding"}]}`))
	if err != nil {
		t.Fatalf("ParseReviewResult: %v", err)
	}
	if len(result.Comments) != 2 || result.Comments[0].Side != "LEFT" || result.Comments[1].Side != "RIGHT" {
		t.Fatalf("comments = %+v, want old=LEFT and new=RIGHT", result.Comments)
	}
}

func TestParseReviewStatus(t *testing.T) {
	status, err := parseReviewStatus([]byte(`{"commit":"sha-1","status":"COMPLETED","runId":"run-1","commentCount":0,"confidence":5}`))
	if err != nil {
		t.Fatalf("parseReviewStatus: %v", err)
	}
	if status.Commit != "sha-1" || status.Status != "COMPLETED" || status.RunID != "run-1" || status.Confidence == nil || *status.Confidence != 5 {
		t.Fatalf("status = %+v", status)
	}
}

func TestReviewStatusCommitMatchesFullOrAbbreviatedSHA(t *testing.T) {
	for _, tc := range []struct {
		requested string
		returned  string
		want      bool
	}{
		{requested: "ABC123", returned: "abc123", want: true},
		{requested: "abc123", returned: "abc123456", want: true},
		{requested: "abc124", returned: "abc123456", want: false},
	} {
		if got := reviewStatusCommitMatches(tc.requested, tc.returned); got != tc.want {
			t.Errorf("reviewStatusCommitMatches(%q, %q) = %v, want %v", tc.requested, tc.returned, got, tc.want)
		}
	}
}

func TestFetchTerminalReviewResultUsesStatusAndShow(t *testing.T) {
	binary := writeFakeGreptile(t, `{"commit":"abc123456","status":"COMPLETED","runId":"run-1","commentCount":0,"confidence":5}`, `{"summary":"Looks good.","confidence":5,"comments":[]}`, "")
	workspace := t.TempDir()
	result, err := New().fetchTerminalReviewResult(context.Background(), workspace, binary, ports.ReviewTask{TargetSHA: "abc123"})
	if err != nil {
		t.Fatalf("fetchTerminalReviewResult: %v", err)
	}
	if result.Verdict != domain.VerdictApproved || !strings.Contains(result.Body, "Looks good.") {
		t.Fatalf("result = %+v", result)
	}
}

func TestParseReviewResultRejectsNonJSONOutput(t *testing.T) {
	if _, err := New().ParseReviewResult([]byte("review failed")); err == nil {
		t.Fatal("expected malformed output error")
	}
}

func TestPrepareTerminalRequestWritesDisplayOnlyCommand(t *testing.T) {
	path := filepath.Join(t.TempDir(), "request.json")
	command, err := New().PrepareTerminalRequest(path, []ports.ReviewTask{{
		RunID: "run-1", PRURL: "https://github.com/acme/repo/pull/4", TargetSHA: "sha-1", TargetBranch: "main", WorkspacePath: t.TempDir(),
	}})
	if err != nil {
		t.Fatalf("PrepareTerminalRequest: %v", err)
	}
	aoExecutable, err := resolveAOExecutable()
	if err != nil {
		t.Fatalf("resolveAOExecutable: %v", err)
	}
	if strings.Join(command.Argv, " ") != aoExecutable+" review-terminal "+path {
		t.Fatalf("command = %#v", command.Argv)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read request: %v", err)
	}
	var request struct {
		ResultPath string `json:"resultPath"`
		Tasks      []struct {
			TargetBranch string `json:"targetBranch"`
		} `json:"tasks"`
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		t.Fatalf("decode request: %v", err)
	}
	if request.ResultPath != TerminalResultPath(path) || len(request.Tasks) != 1 || request.Tasks[0].TargetBranch != "main" {
		t.Fatalf("request = %+v", request)
	}
	if _, err := os.Stat(TerminalResultPath(path)); err != nil {
		t.Fatalf("initial result sidecar: %v", err)
	}
	recovered, err := New().ReadTerminalRequest(path)
	if err != nil {
		t.Fatalf("ReadTerminalRequest: %v", err)
	}
	if recovered.Version != terminalRequestVersion || recovered.WorkerID != "" || recovered.BatchID != "" || recovered.Harness != domain.ReviewerGreptile || recovered.DeadlineAt.IsZero() || len(recovered.Tasks) != 1 || recovered.Tasks[0].RunID != "run-1" {
		t.Fatalf("recovered request = %+v", recovered)
	}
}

func TestPrepareTerminalRequestRejectsDurablePathReuse(t *testing.T) {
	dataDir := t.TempDir()
	path := filepath.Join(dataDir, "reviews", "worker-1", "terminal", "batch-1", "run-1.json")
	task := ports.ReviewTask{RunID: "run-1", PRURL: "https://github.com/acme/repo/pull/4", TargetSHA: "sha-1", WorkspacePath: t.TempDir()}
	if _, err := New().PrepareTerminalRequest(path, []ports.ReviewTask{task}); err != nil {
		t.Fatalf("initial PrepareTerminalRequest: %v", err)
	}
	reused := task
	reused.RunID = "run-2"
	if _, err := New().PrepareTerminalRequest(path, []ports.ReviewTask{reused}); err == nil || !strings.Contains(err.Error(), "task list does not match") {
		t.Fatalf("reused durable request error = %v, want task identity mismatch", err)
	}
}

func TestCommandFailureClassifiesMissingAuthentication(t *testing.T) {
	err := commandFailure(errors.New("exit status 1"), "error: Not signed in. Run `greptile login`.")
	if got, want := err.Error(), "greptile CLI is not authenticated. Run greptile login and retry"; got != want {
		t.Fatalf("error = %q, want %q", got, want)
	}
}

func TestCommandFailureClassifiesMissingBinary(t *testing.T) {
	err := commandFailure(exec.ErrNotFound, "")
	if !errors.Is(err, ports.ErrAgentBinaryNotFound) {
		t.Fatalf("error = %v, want ErrAgentBinaryNotFound", err)
	}
	if !strings.Contains(err.Error(), "Install it") {
		t.Fatalf("error = %q, want install guidance", err)
	}
}

func TestCommandFailureBoundsAndRedactsDiagnostic(t *testing.T) {
	diagnostic := "GREPTILE_API_KEY=super-secret " + strings.Repeat("x", terminalStderrLimit+100)
	err := commandFailure(errors.New("exit status 1"), diagnostic)
	if strings.Contains(err.Error(), "super-secret") {
		t.Fatalf("error leaked credential: %q", err)
	}
	if len(err.Error()) > terminalStderrLimit+256 {
		t.Fatalf("error length = %d, want bounded", len(err.Error()))
	}
}

func TestRunNativeCommandDoesNotStreamUnredactedStderr(t *testing.T) {
	binary := writeFakeGreptile(t, `{}`, "", "GREPTILE_API_KEY=super-secret")
	var output strings.Builder
	stderr, err := runNativeCommand(context.Background(), t.TempDir(), ports.ReviewCommandSpec{Argv: []string{binary, "review", "status"}}, &output)
	if err != nil {
		t.Fatalf("runNativeCommand: %v", err)
	}
	if !strings.Contains(string(stderr), "super-secret") {
		t.Fatalf("captured stderr = %q, want diagnostic retained for classification", stderr)
	}
	if strings.Contains(output.String(), "super-secret") {
		t.Fatalf("native output leaked credential: %q", output.String())
	}
	if !strings.Contains(output.String(), "[REDACTED]") {
		t.Fatalf("native output missing redacted diagnostic: %q", output.String())
	}
}

func TestNativeCommandFailureRechecksAuthentication(t *testing.T) {
	binary := writeFakeGreptile(t, "", "", "Not signed in. Run greptile login.")
	t.Setenv("PATH", filepath.Dir(binary))
	t.Setenv("APPDATA", t.TempDir())
	t.Setenv("LOCALAPPDATA", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	t.Setenv("USERPROFILE", os.Getenv("HOME"))
	t.Setenv("GREPTILE_API_KEY", "")
	err := nativeCommandFailure(context.Background(), New(), errors.New("exit status 1"), nil)
	if got, want := err.Error(), "greptile CLI is not authenticated. Run greptile login and retry"; got != want {
		t.Fatalf("error = %q, want %q", got, want)
	}
}

func writeFakeGreptile(t *testing.T, statusJSON, showJSON, diagnostic string) string {
	t.Helper()
	dir := t.TempDir()
	if runtime.GOOS == "windows" {
		path := filepath.Join(dir, "greptile.cmd")
		script := "@echo off\r\n"
		if diagnostic != "" {
			script += "echo " + diagnostic + " 1>&2\r\n"
		}
		script += "if \"%~2\"==\"status\" goto status\r\n" +
			"if \"%~2\"==\"show\" goto show\r\n"
		script += "exit /b 1\r\n"
		script += ":status\r\necho " + statusJSON + "\r\nexit /b 0\r\n" +
			":show\r\necho " + showJSON + "\r\nexit /b 0\r\n"
		if err := os.WriteFile(path, []byte(script), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	path := filepath.Join(dir, "greptile")
	script := "#!/bin/sh\n"
	if diagnostic != "" {
		script += "printf '%s\\n' '" + diagnostic + "' >&2\n"
	}
	script += "if [ \"$1\" = review ] && [ \"$2\" = status ]; then printf '%s\\n' '" + statusJSON + "'; exit 0; fi\n" +
		"if [ \"$1\" = review ] && [ \"$2\" = show ]; then printf '%s\\n' '" + showJSON + "'; exit 0; fi\n"
	script += "exit 1\n"
	if err := os.WriteFile(path, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestTerminalSummaryTruthfullyReportsOutcomes(t *testing.T) {
	cases := []struct {
		succeeded, failed, total int
		want                     string
	}{
		{2, 0, 2, "Greptile review finished. AO will process the result and attempt to post any findings to GitHub."},
		{1, 1, 2, "Greptile review finished with 1 of 2 reviews failed. See the errors above."},
		{0, 2, 2, "Greptile review failed. No review result was posted."},
	}
	for _, tc := range cases {
		if got := terminalSummary(tc.succeeded, tc.failed, tc.total); got != tc.want {
			t.Errorf("terminalSummary(%d,%d,%d) = %q, want %q", tc.succeeded, tc.failed, tc.total, got, tc.want)
		}
	}
}

func TestParseTerminalResultPreservesInlineComments(t *testing.T) {
	result, err := New().ParseTerminalResult([]byte(`{"complete":true,"results":[{"runId":"run-1","prUrl":"https://github.com/acme/repo/pull/4","targetSha":"sha-1","verdict":"changes_requested","body":"fix it","comments":[{"path":"main.go","startLine":4,"endLine":5,"side":"RIGHT","body":"bug"}]}]}`))
	if err != nil {
		t.Fatalf("ParseTerminalResult: %v", err)
	}
	if !result.Complete || len(result.Results) != 1 || len(result.Results[0].Comments) != 1 {
		t.Fatalf("result = %+v", result)
	}
	comment := result.Results[0].Comments[0]
	if comment.Path != "main.go" || comment.StartLine != 4 || comment.EndLine != 5 || comment.Side != "RIGHT" {
		t.Fatalf("comment = %+v", comment)
	}
}

func TestCompletedTerminalHasReusableShell(t *testing.T) {
	if argv := terminalShell(); len(argv) == 0 || strings.TrimSpace(argv[0]) == "" {
		t.Fatalf("terminalShell() = %#v, want an executable", argv)
	}
}
