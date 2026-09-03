package qwen

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/nativeqwen"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func invocation(t *testing.T) ports.ReviewInvocation {
	t.Helper()
	root := t.TempDir()
	prompts := filepath.Join(root, "prompts")
	if err := os.MkdirAll(prompts, 0o700); err != nil {
		t.Fatal(err)
	}
	task := filepath.Join(prompts, "task.md")
	if err := os.WriteFile(task, []byte("secret task contents"), 0o600); err != nil {
		t.Fatal(err)
	}
	return ports.ReviewInvocation{
		ReviewerID: "review-worker-1", RunID: "run-1", WorkerSessionID: "worker-1",
		PRURL: "https://github.com/acme/widgets/pull/42", TargetSHA: "0123456789abcdef",
		WorkspacePath: filepath.Join(root, "checkout"), DataDir: filepath.Join(root, "ao-data"),
		Prompt: "Read the AO review task reference.", SystemPrompt: "secret system contents",
		TaskPromptFile: task, TaskPromptRoot: prompts,
	}
}

func TestReviewCommandIsExactPermanentTUIWithPostReadinessReference(t *testing.T) {
	reviewer := New()
	qwenBinary := filepath.Join(t.TempDir(), "qwen")
	reviewer.resolveBinary = func(context.Context) (string, error) { return qwenBinary, nil }
	inv := invocation(t)

	spec, err := reviewer.ReviewCommand(context.Background(), inv)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{qwenBinary, "--bare", "--approval-mode", "plan"}
	if !reflect.DeepEqual(spec.Argv, want) {
		t.Fatalf("argv = %#v, want %#v", spec.Argv, want)
	}
	if spec.InitialMessage != inv.Prompt {
		t.Fatalf("initial message = %q, want short reference %q", spec.InitialMessage, inv.Prompt)
	}
	joined := strings.Join(spec.Argv, " ")
	for _, forbidden := range []string{
		inv.Prompt, inv.SystemPrompt, inv.TaskPromptFile, "secret task contents",
		"--prompt", "--prompt-interactive", " -p ", " -i ", "--output-format",
		"--json", "--json-schema", "--acp", "serve", "--yolo", "--resume",
		"--continue", "--worktree",
	} {
		if strings.Contains(" "+joined+" ", forbidden) {
			t.Fatalf("interactive command contains forbidden value %q: %q", forbidden, joined)
		}
	}
	if spec.WorkingDirectory == inv.WorkspacePath || !strings.HasPrefix(spec.WorkingDirectory, inv.DataDir+string(filepath.Separator)) {
		t.Fatalf("working directory = %q", spec.WorkingDirectory)
	}
	if spec.Env["HOME"] == "" || spec.Env["TMPDIR"] == "" || spec.Env["AO_DATA_DIR"] != inv.DataDir {
		t.Fatalf("neutral environment = %#v", spec.Env)
	}
	if strings.HasPrefix(spec.Env["HOME"], inv.WorkspacePath) {
		t.Fatalf("HOME points into checkout: %q", spec.Env["HOME"])
	}
	if _, ok := spec.Env["AO_REVIEW_GATEWAY_MANIFEST"]; ok {
		t.Fatalf("unexpected gateway manifest env = %#v", spec.Env)
	}
	for _, path := range []string{spec.WorkingDirectory, spec.Env["HOME"], spec.Env["TMPDIR"]} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("neutral runtime path %q: %v", path, err)
		}
	}
}

func TestReviewCommandSeedsPrivateProfileFromHostSettings(t *testing.T) {
	hostHome := t.TempDir()
	t.Setenv("HOME", hostHome)
	t.Setenv("USERPROFILE", hostHome)
	settings := filepath.Join(hostHome, ".qwen", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settings), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(settings, []byte(`{"model":{"name":"GLM-5.2"},"env":{"ZAI_API_KEY":"test-key"}}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	reviewer := New()
	reviewer.resolveBinary = func(context.Context) (string, error) { return filepath.Join(t.TempDir(), "qwen"), nil }

	spec, err := reviewer.ReviewCommand(context.Background(), invocation(t))
	if err != nil {
		t.Fatal(err)
	}

	copied := filepath.Join(spec.Env["HOME"], ".qwen", "settings.json")
	data, err := os.ReadFile(copied)
	if err != nil {
		t.Fatalf("read copied settings: %v", err)
	}
	if string(data) != `{"model":{"name":"GLM-5.2"},"env":{"ZAI_API_KEY":"test-key"}}`+"\n" {
		t.Fatalf("copied settings = %q", string(data))
	}
	info, err := os.Stat(copied)
	if err != nil {
		t.Fatal(err)
	}
	// Windows does not preserve Unix permission bits for ordinary files.
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("copied settings mode = %o, want 600", info.Mode().Perm())
	}
}

func TestReviewCommandExportsEnvValuesFromHostSettings(t *testing.T) {
	hostHome := t.TempDir()
	t.Setenv("HOME", hostHome)
	t.Setenv("USERPROFILE", hostHome)
	settings := filepath.Join(hostHome, ".qwen", "settings.json")
	if err := os.MkdirAll(filepath.Dir(settings), 0o700); err != nil {
		t.Fatal(err)
	}
	raw := `{
		"env": {
			"ZAI_API_KEY": "test-key",
			"EMPTY_VALUE": "",
			"bad-name": "ignored"
		}
	}` + "\n"
	if err := os.WriteFile(settings, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	reviewer := New()
	reviewer.resolveBinary = func(context.Context) (string, error) { return filepath.Join(t.TempDir(), "qwen"), nil }

	spec, err := reviewer.ReviewCommand(context.Background(), invocation(t))
	if err != nil {
		t.Fatal(err)
	}

	if spec.Env["ZAI_API_KEY"] != "test-key" {
		t.Fatalf("ZAI_API_KEY was not exported into reviewer env")
	}
	if _, ok := spec.Env["EMPTY_VALUE"]; ok {
		t.Fatalf("empty settings env value should not be exported")
	}
	if _, ok := spec.Env["bad-name"]; ok {
		t.Fatalf("invalid env name should not be exported")
	}
}

func TestReviewPromptReadinessHintsWaitForQwenInput(t *testing.T) {
	hints, err := New().ReviewPromptReadinessHints(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if hints.InitialDelay <= 0 || hints.Timeout <= 0 || !contains(hints.Patterns, "Type your message or @path/to/file") {
		t.Fatalf("readiness hints = %+v", hints)
	}
}

func TestReviewCommandRequiresAODataDir(t *testing.T) {
	inv := invocation(t)
	inv.DataDir = ""
	reviewer := New()
	reviewer.resolveBinary = func(context.Context) (string, error) { return filepath.Join(t.TempDir(), "qwen"), nil }
	if _, err := reviewer.ReviewCommand(context.Background(), inv); err == nil || !strings.Contains(err.Error(), "AO data directory is required") {
		t.Fatalf("ReviewCommand error = %v", err)
	}
}

func TestReviewCommandPreflightShapeNeedsNoRequestData(t *testing.T) {
	reviewer := New()
	qwenBinary := filepath.Join(t.TempDir(), "qwen")
	reviewer.resolveBinary = func(context.Context) (string, error) { return qwenBinary, nil }
	spec, err := reviewer.ReviewCommand(context.Background(), ports.ReviewInvocation{WorkspacePath: "/ws"})
	if err != nil {
		t.Fatalf("ReviewCommand: %v", err)
	}
	if !reflect.DeepEqual(spec.Argv, []string{qwenBinary}) {
		t.Fatalf("argv = %#v", spec.Argv)
	}
}

func TestNativeReviewCommandUsesRepositoryAndAOOwnedManifest(t *testing.T) {
	inv := invocation(t)
	inv.Config = domain.AgentConfig{Mode: "native-review", NativeReview: &domain.NativeReviewConfig{
		Effort: "high", Comment: true, Resume: true, Quiet: true, TimeoutMinutes: 7,
	}}
	qwenBinary := filepath.Join(t.TempDir(), "qwen")
	aoBinary := filepath.Join(t.TempDir(), "ao")
	reviewer := New()
	reviewer.resolveBinary = func(context.Context) (string, error) { return qwenBinary, nil }
	reviewer.resolveExecutable = func() (string, error) { return aoBinary, nil }

	spec, err := reviewer.ReviewCommand(context.Background(), inv)
	if err != nil {
		t.Fatal(err)
	}
	if spec.WorkingDirectory != inv.WorkspacePath {
		t.Fatalf("working directory = %q, want repository checkout %q", spec.WorkingDirectory, inv.WorkspacePath)
	}
	if len(spec.Argv) != 5 || spec.Argv[0] != aoBinary || spec.Argv[1] != "review" || spec.Argv[2] != "qwen-native-run" || spec.Argv[3] != "--manifest" {
		t.Fatalf("argv = %#v", spec.Argv)
	}
	data, err := os.ReadFile(spec.Argv[4])
	if err != nil {
		t.Fatal(err)
	}
	var manifest nativeqwen.Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.QwenBinary != qwenBinary || manifest.WorkspacePath != inv.WorkspacePath || len(manifest.Tasks) != 1 {
		t.Fatalf("manifest = %+v", manifest)
	}
	if manifest.Tasks[0].Options.Resume {
		t.Fatal("first review must not use --resume without an interrupted same-head predecessor")
	}
	if !manifest.Tasks[0].Options.Comment || manifest.Tasks[0].Options.Effort != "high" {
		t.Fatalf("native options = %+v", manifest.Tasks[0].Options)
	}
	if !reviewer.SkipIdleReviewRestore(inv) {
		t.Fatal("native one-shot reviewer should skip idle terminal restore")
	}
}

func TestNativeReviewResumeIsFencedToSameTargetAndHead(t *testing.T) {
	inv := invocation(t)
	inv.Config = domain.AgentConfig{Mode: "native-review", NativeReview: &domain.NativeReviewConfig{Resume: true}}
	inv.PreviousRuns = []domain.ReviewRun{
		{PRURL: inv.PRURL, TargetSHA: "older", Status: domain.ReviewRunFailed},
		{PRURL: inv.PRURL, TargetSHA: inv.TargetSHA, Status: domain.ReviewRunCancelled},
	}
	reviewer := New()
	reviewer.resolveBinary = func(context.Context) (string, error) { return filepath.Join(t.TempDir(), "qwen"), nil }
	reviewer.resolveExecutable = func() (string, error) { return filepath.Join(t.TempDir(), "ao"), nil }
	spec, err := reviewer.ReviewCommand(context.Background(), inv)
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(spec.Argv[4])
	if err != nil {
		t.Fatal(err)
	}
	var manifest nativeqwen.Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if !manifest.Tasks[0].Options.Resume {
		t.Fatal("same-target interrupted review should use --resume")
	}
}

func TestNativeReviewRestoreResumesOnlyRecordedRunningHead(t *testing.T) {
	inv := invocation(t)
	inv.RunID, inv.PRURL, inv.TargetSHA = "", "", ""
	inv.Config = domain.AgentConfig{Mode: "native-review", NativeReview: &domain.NativeReviewConfig{Resume: true}}
	inv.PreviousRuns = []domain.ReviewRun{
		{ID: "run-old", PRURL: "pr-old", TargetSHA: "old", Status: domain.ReviewRunComplete},
		{ID: "run-running", PRURL: "pr-current", TargetSHA: "sha-current", Status: domain.ReviewRunRunning},
	}
	reviewer := New()
	reviewer.resolveBinary = func(context.Context) (string, error) { return filepath.Join(t.TempDir(), "qwen"), nil }
	reviewer.resolveExecutable = func() (string, error) { return filepath.Join(t.TempDir(), "ao"), nil }
	spec, ok, err := reviewer.ReviewRestoreCommand(context.Background(), inv)
	if err != nil || !ok {
		t.Fatalf("ReviewRestoreCommand ok=%v err=%v", ok, err)
	}
	data, err := os.ReadFile(spec.Argv[4])
	if err != nil {
		t.Fatal(err)
	}
	var manifest nativeqwen.Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Tasks) != 1 || manifest.Tasks[0].RunID != "run-running" || !manifest.Tasks[0].Options.Resume {
		t.Fatalf("restore manifest = %+v", manifest)
	}
}

func TestReviewCommandRejectsRelativeBinary(t *testing.T) {
	reviewer := New()
	reviewer.resolveBinary = func(context.Context) (string, error) { return "qwen", nil }
	if _, err := reviewer.ReviewCommand(context.Background(), invocation(t)); err == nil {
		t.Fatal("relative executable accepted")
	}
}

func TestReviewMessageReusesPaneInjectionWithoutAddingAuthority(t *testing.T) {
	inv := invocation(t)
	inv.Prompt = "Read /ao/task.md"
	message, err := New().ReviewMessage(context.Background(), inv)
	if err != nil || message != inv.Prompt {
		t.Fatalf("message = %q, %v", message, err)
	}
}

func TestReviewProcessIsNotReusableBecauseContextIsLaunchScoped(t *testing.T) {
	if New().ReviewProcessReusable() {
		t.Fatal("Qwen reviewer must launch a fresh process for each task")
	}
}

func TestReviewCancelUsesOneEscapeAndNeverCtrlC(t *testing.T) {
	spec, err := New().ReviewCancel(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if spec.Mode != ports.ReviewCancelInput || spec.Input != "\x1b" {
		t.Fatalf("cancel spec = %+v, want one Escape", spec)
	}
}

func TestQwenReviewerIdentityAndHostTrustWarning(t *testing.T) {
	if New().Harness() != domain.ReviewerQwen {
		t.Fatal("wrong harness")
	}
	for _, phrase := range []string{"host-trusted", "no OS isolation", "! shell"} {
		if !strings.Contains(HostTrustWarning, phrase) {
			t.Fatalf("warning %q does not contain %q", HostTrustWarning, phrase)
		}
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
