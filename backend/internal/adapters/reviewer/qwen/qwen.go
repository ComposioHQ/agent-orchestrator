// Package qwen contains AO's experimental host-trusted Qwen Code reviewer.
// Qwen runs as a visible, long-lived TUI in an AO-owned neutral directory.
package qwen

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	workerqwen "github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/qwen"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/nativeqwen"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/reviewgateway"
)

// HostTrustWarning describes the security boundary operators accept by using
// this experimental reviewer. Plan mode constrains model tool calls, but is not
// OS isolation: a terminal user can still invoke Qwen's ! shell or change mode.
const HostTrustWarning = "experimental host-trusted reviewer: Qwen has no OS isolation; terminal users can invoke the ! shell or change approval mode"

type binaryResolver func(context.Context) (string, error)

// Reviewer builds only Qwen's visible, long-lived interactive TUI command.
type Reviewer struct {
	resolveBinary     binaryResolver
	resolveExecutable func() (string, error)
}

// New creates the Qwen reviewer. Production launch invocations supply the
// AO-owned data directory used for its neutral working and configuration roots.
func New() *Reviewer {
	return &Reviewer{resolveBinary: workerqwen.ResolveQwenBinary, resolveExecutable: os.Executable}
}

// Harness returns Qwen's reviewer identity.
func (r *Reviewer) Harness() domain.ReviewerHarness { return domain.ReviewerQwen }

var _ ports.Reviewer = (*Reviewer)(nil)
var _ ports.ReviewerCanceller = (*Reviewer)(nil)
var _ ports.ReviewerReusePolicy = (*Reviewer)(nil)
var _ ports.ReviewerPromptReadinessProvider = (*Reviewer)(nil)
var _ ports.ReviewerIdleRestorePolicy = (*Reviewer)(nil)

// ReviewCommand launches only Qwen's permanent interactive TUI. The task
// reference is injected after runtime creation so neither prompts nor prompt
// paths appear in process argv.
func (r *Reviewer) ReviewCommand(ctx context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, error) {
	if err := ctx.Err(); err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	binary, err := r.resolveBinary(ctx)
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	if !filepath.IsAbs(binary) {
		return ports.ReviewCommandSpec{}, errors.New("qwen reviewer: resolved binary must be absolute")
	}
	if inv.Config.Mode == "native-review" {
		return r.nativeReviewCommand(inv, binary, false)
	}
	// Launcher preflight runs before request-scoped prompt and gateway state
	// exists. It only needs the resolved interactive executable; production
	// launches always carry an absolute task prompt root.
	if strings.TrimSpace(inv.TaskPromptRoot) == "" {
		return ports.ReviewCommandSpec{Argv: []string{binary}}, nil
	}
	env, err := r.prepareEnvironment(inv)
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	settingsEnv, err := seedHostQwenSettings(env.ConfigRoot)
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	envVars := env.TUIEnvironment()
	for key, value := range settingsEnv {
		envVars[key] = value
	}
	envVars["AO_DATA_DIR"] = env.DataDir
	return ports.ReviewCommandSpec{
		Argv:             []string{binary, "--bare", "--approval-mode", "plan"},
		Env:              envVars,
		InitialMessage:   inv.Prompt,
		WorkingDirectory: env.WorkingDirectory,
	}, nil
}

func (r *Reviewer) nativeReviewCommand(inv ports.ReviewInvocation, binary string, restoring bool) (ports.ReviewCommandSpec, error) {
	if strings.TrimSpace(inv.WorkspacePath) == "" || strings.TrimSpace(inv.RunID) == "" {
		return ports.ReviewCommandSpec{}, errors.New("qwen native reviewer: workspace and run id are required")
	}
	if err := inv.Config.Validate(); err != nil {
		return ports.ReviewCommandSpec{}, fmt.Errorf("qwen native reviewer config: %w", err)
	}
	opts := nativeqwen.Options{}
	if inv.Config.NativeReview != nil {
		opts = nativeqwen.Options{
			Effort:         inv.Config.NativeReview.Effort,
			Comment:        inv.Config.NativeReview.Comment,
			Resume:         inv.Config.NativeReview.Resume,
			Quiet:          inv.Config.NativeReview.Quiet,
			TimeoutMinutes: inv.Config.NativeReview.TimeoutMinutes,
		}
	}
	queue := inv.ReviewQueue
	if len(queue) == 0 {
		queue = []ports.ReviewTask{{RunID: inv.RunID, PRURL: inv.PRURL, TargetSHA: inv.TargetSHA}}
	}
	tasks := make([]nativeqwen.Task, 0, len(queue))
	for _, item := range queue {
		taskOpts := opts
		taskOpts.Resume = taskOpts.Resume && resumableTarget(inv.PreviousRuns, item.PRURL, item.TargetSHA, restoring)
		tasks = append(tasks, nativeqwen.Task{RunID: item.RunID, Target: item.PRURL, TargetSHA: item.TargetSHA, Options: taskOpts})
	}
	manifest := nativeqwen.Manifest{
		Version:         1,
		QwenBinary:      binary,
		WorkerSessionID: string(inv.WorkerSessionID),
		WorkspacePath:   inv.WorkspacePath,
		Tasks:           tasks,
	}
	if err := manifest.Validate(); err != nil {
		return ports.ReviewCommandSpec{}, fmt.Errorf("qwen native reviewer manifest: %w", err)
	}
	executable, err := r.resolveExecutable()
	if err != nil {
		return ports.ReviewCommandSpec{}, fmt.Errorf("qwen native reviewer: resolve AO executable: %w", err)
	}
	if !filepath.IsAbs(executable) {
		return ports.ReviewCommandSpec{}, errors.New("qwen native reviewer: AO executable must be absolute")
	}
	env, err := r.prepareEnvironment(inv)
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	settingsEnv, err := seedHostQwenSettings(env.ConfigRoot)
	if err != nil {
		return ports.ReviewCommandSpec{}, err
	}
	envVars := env.TUIEnvironment()
	for key, value := range settingsEnv {
		envVars[key] = value
	}
	envVars["AO_DATA_DIR"] = env.DataDir
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return ports.ReviewCommandSpec{}, fmt.Errorf("qwen native reviewer: encode manifest: %w", err)
	}
	hash := sha256.Sum256([]byte(inv.RunID))
	manifestDir := filepath.Join(inv.DataDir, "reviewer-runtime", inv.ReviewerID, "native-review")
	if err := os.MkdirAll(manifestDir, 0o700); err != nil {
		return ports.ReviewCommandSpec{}, fmt.Errorf("qwen native reviewer: create manifest directory: %w", err)
	}
	manifestPath := filepath.Join(manifestDir, fmt.Sprintf("%x.json", hash[:12]))
	if err := os.WriteFile(manifestPath, manifestBytes, 0o600); err != nil {
		return ports.ReviewCommandSpec{}, fmt.Errorf("qwen native reviewer: write manifest: %w", err)
	}
	return ports.ReviewCommandSpec{
		Argv:             []string{executable, "review", "qwen-native-run", "--manifest", manifestPath},
		Env:              envVars,
		WorkingDirectory: inv.WorkspacePath,
	}, nil
}

func resumableTarget(runs []domain.ReviewRun, prURL, targetSHA string, includeRunning bool) bool {
	for _, run := range runs {
		if run.PRURL == prURL && run.TargetSHA == targetSHA &&
			(run.Status == domain.ReviewRunFailed || run.Status == domain.ReviewRunCancelled || includeRunning && run.Status == domain.ReviewRunRunning) {
			return true
		}
	}
	return false
}

// ReviewRestoreCommand restores a recorded Qwen reviewer pane by relaunching
// with a fresh gateway manifest and the current task context.
func (r *Reviewer) ReviewRestoreCommand(ctx context.Context, inv ports.ReviewInvocation) (ports.ReviewCommandSpec, bool, error) {
	if inv.Config.Mode == "native-review" {
		queue := make([]ports.ReviewTask, 0)
		for _, run := range inv.PreviousRuns {
			if run.Status == domain.ReviewRunRunning {
				queue = append(queue, ports.ReviewTask{RunID: run.ID, PRURL: run.PRURL, TargetSHA: run.TargetSHA})
			}
		}
		if len(queue) == 0 {
			return ports.ReviewCommandSpec{}, false, nil
		}
		binary, err := r.resolveBinary(ctx)
		if err != nil {
			return ports.ReviewCommandSpec{}, false, err
		}
		if !filepath.IsAbs(binary) {
			return ports.ReviewCommandSpec{}, false, errors.New("qwen reviewer: resolved binary must be absolute")
		}
		inv.RunID, inv.PRURL, inv.TargetSHA = queue[0].RunID, queue[0].PRURL, queue[0].TargetSHA
		inv.ReviewQueue = queue
		cmd, err := r.nativeReviewCommand(inv, binary, true)
		return cmd, err == nil, err
	}
	cmd, err := r.ReviewCommand(ctx, inv)
	return cmd, true, err
}

// ReviewMessage reuses AO's normal pane injection for subsequent passes.
func (*Reviewer) ReviewMessage(_ context.Context, inv ports.ReviewInvocation) (string, error) {
	return inv.Prompt, nil
}

// ReviewProcessReusable returns false because Qwen's request-scoped reviewer
// context is fixed at launch.
func (*Reviewer) ReviewProcessReusable() bool { return false }

// SkipIdleReviewRestore keeps native-review one-shot: daemon recovery must not
// invent a provider run when there is no immutable review task to execute.
func (*Reviewer) SkipIdleReviewRestore(inv ports.ReviewInvocation) bool {
	if inv.Config.Mode != "native-review" {
		return false
	}
	for _, run := range inv.PreviousRuns {
		if run.Status == domain.ReviewRunRunning {
			return false
		}
	}
	return true
}

// ReviewPromptReadinessHints waits for Qwen's input footer before injecting the
// task reference, avoiding a blind startup race while keeping timeout best-effort.
func (*Reviewer) ReviewPromptReadinessHints(ctx context.Context) (ports.PromptReadinessHints, error) {
	if err := ctx.Err(); err != nil {
		return ports.PromptReadinessHints{}, err
	}
	return ports.PromptReadinessHints{
		InitialDelay: 2 * time.Second,
		Patterns:     []string{"Type your message or @path/to/file"},
		PollInterval: 200 * time.Millisecond,
		Timeout:      15 * time.Second,
		Lines:        80,
	}, nil
}

// ReviewCancel matches the pinned Qwen TUI behavior: one Escape aborts the
// active turn without exiting the long-lived process. Ctrl-C is a quit action.
func (*Reviewer) ReviewCancel(context.Context) (ports.ReviewCancelSpec, error) {
	return ports.ReviewCancelSpec{Mode: ports.ReviewCancelInput, Input: "\x1b"}, nil
}

func (r *Reviewer) prepareEnvironment(inv ports.ReviewInvocation) (reviewgateway.Environment, error) {
	dataDir := inv.DataDir
	if strings.TrimSpace(dataDir) == "" {
		return reviewgateway.Environment{}, errors.New("qwen reviewer: AO data directory is required")
	}
	env, err := reviewgateway.PrepareHostTrustedEnvironment(dataDir, inv.ReviewerID)
	if err != nil {
		return reviewgateway.Environment{}, fmt.Errorf("qwen reviewer: prepare environment: %w", err)
	}
	return env, nil
}

func seedHostQwenSettings(configRoot string) (map[string]string, error) {
	if strings.TrimSpace(configRoot) == "" {
		return nil, nil
	}
	home, err := os.UserHomeDir()
	if err == nil {
		home = strings.TrimSpace(home)
	}
	if home == "" {
		return nil, nil
	}
	src := filepath.Join(home, ".qwen", "settings.json")
	data, err := os.ReadFile(src)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("qwen reviewer: read host settings: %w", err)
	}
	dstDir := filepath.Join(configRoot, ".qwen")
	if err := os.MkdirAll(dstDir, 0o700); err != nil {
		return nil, fmt.Errorf("qwen reviewer: create private settings dir: %w", err)
	}
	if err := os.WriteFile(filepath.Join(dstDir, "settings.json"), data, 0o600); err != nil {
		return nil, fmt.Errorf("qwen reviewer: write private settings: %w", err)
	}
	settingsEnv, err := qwenSettingsEnv(data)
	if err != nil {
		return nil, fmt.Errorf("qwen reviewer: parse host settings env: %w", err)
	}
	return settingsEnv, nil
}

func qwenSettingsEnv(data []byte) (map[string]string, error) {
	var root struct {
		Env map[string]string `json:"env"`
	}
	if err := json.Unmarshal(data, &root); err != nil {
		return nil, err
	}
	out := map[string]string{}
	for key, value := range root.Env {
		if !validEnvName(key) || strings.TrimSpace(value) == "" {
			continue
		}
		out[key] = value
	}
	return out, nil
}

func validEnvName(name string) bool {
	if name == "" {
		return false
	}
	for i, r := range name {
		switch {
		case r == '_':
		case r >= 'A' && r <= 'Z':
		case r >= 'a' && r <= 'z':
		case i > 0 && r >= '0' && r <= '9':
		default:
			return false
		}
	}
	return true
}
