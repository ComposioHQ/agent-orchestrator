// Package nativeqwen implements the bounded process and result contract for
// Qwen Code's non-interactive `review run` command.
package nativeqwen

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"time"
)

// Options are the typed Qwen-owned review flags AO permits.
type Options struct {
	Effort         string `json:"effort,omitempty"`
	Comment        bool   `json:"comment,omitempty"`
	Resume         bool   `json:"resume,omitempty"`
	Quiet          bool   `json:"quiet,omitempty"`
	TimeoutMinutes int    `json:"timeoutMinutes,omitempty"`
}

// Task binds one provider invocation to the immutable AO review run and PR head.
type Task struct {
	RunID     string  `json:"runId"`
	Target    string  `json:"target"`
	TargetSHA string  `json:"targetSha"`
	Options   Options `json:"options,omitempty"`
}

// Manifest is written by the reviewer adapter and consumed by AO's hidden
// one-shot command. The target is adapter-derived, never an extra argv string.
type Manifest struct {
	Version         int    `json:"version"`
	QwenBinary      string `json:"qwenBinary"`
	WorkerSessionID string `json:"workerSessionId"`
	WorkspacePath   string `json:"workspacePath"`
	Tasks           []Task `json:"tasks"`
}

func (m Manifest) Validate() error {
	if m.Version != 1 {
		return fmt.Errorf("unsupported native Qwen manifest version %d", m.Version)
	}
	if strings.TrimSpace(m.QwenBinary) == "" || strings.TrimSpace(m.WorkerSessionID) == "" || strings.TrimSpace(m.WorkspacePath) == "" {
		return errors.New("native Qwen manifest is missing binary, worker session, or workspace")
	}
	if len(m.Tasks) == 0 {
		return errors.New("native Qwen manifest has no review tasks")
	}
	for i, task := range m.Tasks {
		if strings.TrimSpace(task.RunID) == "" || strings.TrimSpace(task.Target) == "" || strings.TrimSpace(task.TargetSHA) == "" {
			return fmt.Errorf("native Qwen task %d is missing run, target, or target SHA", i)
		}
		if err := task.Options.Validate(); err != nil {
			return fmt.Errorf("native Qwen task %d: %w", i, err)
		}
	}
	return nil
}

func (o Options) Validate() error {
	switch o.Effort {
	case "", "low", "medium", "high":
	default:
		return fmt.Errorf("invalid effort %q", o.Effort)
	}
	if o.Comment && (o.Effort == "low" || o.Effort == "medium") {
		return errors.New("comment requires high or provider-default effort")
	}
	if o.TimeoutMinutes < 0 {
		return errors.New("timeout minutes must be positive when set")
	}
	const maxTimeoutMinutes = int64((time.Duration(1<<63 - 1)) / time.Minute)
	if int64(o.TimeoutMinutes) > maxTimeoutMinutes {
		return errors.New("timeout minutes exceed the supported duration")
	}
	return nil
}

// Args returns the exact native provider argv after the executable.
func Args(task Task) ([]string, error) {
	if err := task.Options.Validate(); err != nil {
		return nil, err
	}
	args := []string{"review", "run", task.Target}
	if task.Options.Effort != "" {
		args = append(args, "--effort", task.Options.Effort)
	}
	args = append(args, "--json", "--fail-on", "request-changes")
	if task.Options.Comment {
		args = append(args, "--comment")
	}
	if task.Options.Resume {
		args = append(args, "--resume")
	}
	if task.Options.Quiet {
		args = append(args, "--quiet")
	}
	if task.Options.TimeoutMinutes > 0 {
		args = append(args, "--timeout-minutes", fmt.Sprint(task.Options.TimeoutMinutes))
	}
	return args, nil
}

// ProviderResult contains the stable fields AO consumes. Raw JSON is retained
// separately so newer Qwen findings remain available without widening this type.
type ProviderResult struct {
	Completed            bool     `json:"completed"`
	Event                string   `json:"event,omitempty"`
	VerdictLine          string   `json:"verdictLine,omitempty"`
	BaseEvent            string   `json:"baseEvent,omitempty"`
	CappedBy             []string `json:"cappedBy,omitempty"`
	Downgraded           bool     `json:"downgraded,omitempty"`
	DowngradedFrom       string   `json:"downgradedFrom,omitempty"`
	Remediation          []string `json:"remediation,omitempty"`
	ComposedPath         string   `json:"composedPath,omitempty"`
	ExpectedComposedName string   `json:"expectedComposedName,omitempty"`
	ReportPath           string   `json:"reportPath,omitempty"`
	ChildExitCode        *int     `json:"childExitCode,omitempty"`
	ChildSignal          *string  `json:"childSignal,omitempty"`
	TimedOut             bool     `json:"timedOut,omitempty"`
	DurationMS           int64    `json:"durationMs,omitempty"`
}

// Outcome is AO's normalized terminal observation of one provider process.
type Outcome struct {
	Status  string
	Verdict string
	Result  ProviderResult
	Raw     json.RawMessage
	Reason  string
}

// Parse maps Qwen's documented exit/JSON pair. It fails closed whenever the
// process and payload disagree; exit 3 is a completed blocking review, not an
// infrastructure failure.
func Parse(stdout []byte, exitCode int) Outcome {
	raw := bytes.TrimSpace(stdout)
	var result ProviderResult
	if len(raw) == 0 || json.Unmarshal(raw, &result) != nil {
		return Outcome{Status: "failed", Raw: append(json.RawMessage(nil), raw...), Reason: "missing or malformed Qwen JSON result"}
	}
	base := Outcome{Result: result, Raw: append(json.RawMessage(nil), raw...)}
	if exitCode == 1 {
		base.Status = "failed"
		base.Reason = "Qwen review did not produce a verdict"
		return base
	}
	if exitCode != 0 && exitCode != 3 {
		base.Status = "failed"
		base.Reason = fmt.Sprintf("unexpected Qwen exit code %d", exitCode)
		return base
	}
	if !result.Completed {
		base.Status = "failed"
		base.Reason = "Qwen reported an incomplete review"
		return base
	}
	verdict, consistent := normalizedResultVerdict(result)
	if !consistent {
		base.Status, base.Reason = "failed", "Qwen event and verdict line disagree"
		return base
	}
	// A completed result with no event is a valid non-approval observation for
	// low-effort and up-to-date/empty-diff stops. Preserve it as AO's neutral
	// comment verdict; treating it as an approval would weaken the gate, while
	// treating it as infrastructure failure would make Qwen's valid exit-0
	// contract unusable.
	if verdict == "" {
		verdict = "comment"
	}
	switch verdict {
	case "approved":
		if exitCode != 0 {
			base.Status, base.Reason = "failed", "Qwen approval used a blocking exit code"
			return base
		}
		base.Status, base.Verdict = "complete", "approved"
	case "comment":
		if exitCode != 0 {
			base.Status, base.Reason = "failed", "Qwen comment used a blocking exit code"
			return base
		}
		base.Status, base.Verdict = "complete", "comment"
	case "changes_requested":
		if exitCode != 3 {
			base.Status, base.Reason = "failed", "Qwen request-changes verdict did not use exit code 3"
			return base
		}
		base.Status, base.Verdict = "complete", "changes_requested"
	default:
		base.Status, base.Reason = "failed", "Qwen completed without a recognized verdict"
	}
	return base
}

func normalizedResultVerdict(result ProviderResult) (string, bool) {
	event := normalizeVerdict(result.Event)
	line := normalizeVerdict(result.VerdictLine)
	if strings.TrimSpace(result.Event) != "" && event == "" {
		return "", false
	}
	if event != "" && line != "" && event != line {
		return "", false
	}
	if event != "" {
		return event, true
	}
	return line, true
}

func normalizeVerdict(value string) string {
	normalized := strings.ToUpper(strings.TrimSpace(value))
	normalized = strings.TrimPrefix(normalized, "VERDICT:")
	normalized = strings.TrimSpace(normalized)
	switch normalized {
	case "APPROVE", "APPROVED":
		return "approved"
	case "COMMENT", "COMMENTED":
		return "comment"
	case "REQUEST_CHANGES", "CHANGES_REQUESTED", "REQUEST CHANGES":
		return "changes_requested"
	}
	// Verdict lines may include explanatory suffixes or finding counts. The
	// provider's first disposition token remains stable; never inspect the last
	// word, which is commonly part of that explanation.
	if strings.HasPrefix(normalized, "APPROVE ") || strings.HasPrefix(normalized, "APPROVED ") {
		return "approved"
	}
	if strings.HasPrefix(normalized, "COMMENT ") || strings.HasPrefix(normalized, "COMMENTED ") {
		return "comment"
	}
	if strings.HasPrefix(normalized, "REQUEST_CHANGES ") || strings.HasPrefix(normalized, "CHANGES_REQUESTED ") || strings.HasPrefix(normalized, "REQUEST CHANGES ") {
		return "changes_requested"
	}
	return ""
}

// Run performs one provider observation with separate stdout and stderr. The
// process is placed in its own group so context cancellation kills descendants.
func Run(ctx context.Context, binary, dir string, task Task, stderr io.Writer) ([]byte, int, error) {
	args, err := Args(task)
	if err != nil {
		return nil, -1, err
	}
	runCtx, cancel := withTaskTimeout(ctx, task.Options.TimeoutMinutes)
	defer cancel()
	cmd := exec.CommandContext(runCtx, binary, args...) //nolint:gosec // binary and target are adapter-derived, typed manifest values.
	cmd.Dir = dir
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = stderr
	configureProcess(cmd)
	cmd.Cancel = func() error { return killProcessTree(cmd) }
	cmd.WaitDelay = 5 * time.Second
	err = cmd.Run()
	if err == nil {
		return stdout.Bytes(), 0, nil
	}
	if runCtx.Err() != nil {
		return stdout.Bytes(), -1, runCtx.Err()
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return stdout.Bytes(), exitErr.ExitCode(), nil
	}
	return stdout.Bytes(), -1, err
}

func withTaskTimeout(ctx context.Context, minutes int) (context.Context, context.CancelFunc) {
	if minutes <= 0 {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, time.Duration(minutes)*time.Minute)
}
