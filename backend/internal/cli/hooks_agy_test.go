package cli

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHooks_AgyStopReportsNativeFacts(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	t.Setenv("AO_PROJECT_ID", "")
	t.Setenv("AO_RUNTIME_LAUNCH_ID", "launch-3")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	payload := `{
		"conversationId":"agy-native-1",
		"transcriptPath":"/tmp/agy-transcript.jsonl",
		"executionNum":1,
		"terminationReason":"model_stop",
		"error":"",
		"fullyIdle":true
	}`
	out, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(payload),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "agy", "stop")
	if err != nil {
		t.Fatal(err)
	}

	var req setActivityAPIRequest
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatal(err)
	}
	if req.State != "idle" || req.Event != "stop" {
		t.Fatalf("activity = state %q event %q, want idle/stop", req.State, req.Event)
	}
	if req.AgentSessionID != "agy-native-1" {
		t.Fatalf("agent session id = %q, want agy-native-1", req.AgentSessionID)
	}
	if req.TranscriptPath != "/tmp/agy-transcript.jsonl" {
		t.Fatalf("transcript path = %q", req.TranscriptPath)
	}
	if req.LaunchID != "launch-3" {
		t.Fatalf("launch id = %q, want launch-3", req.LaunchID)
	}

	var response agyStopHookOutput
	if err := json.Unmarshal([]byte(out), &response); err != nil {
		t.Fatalf("decode Stop hook stdout %q: %v", out, err)
	}
	if response.Decision != "allow" {
		t.Fatalf("Stop decision = %q, want allow", response.Decision)
	}
}

func TestHooks_AgyPreInvocationReportsActiveAndInjectsSystemPrompt(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	t.Setenv("AO_PROJECT_ID", "")
	t.Setenv("AO_RUNTIME_LAUNCH_ID", "launch-3")
	cfg := setConfigEnv(t)

	promptDir := filepath.Join(cfg.dataDir, "prompts", "ao-7")
	if err := os.MkdirAll(promptDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(promptDir, "system.md"), []byte("AO SYSTEM RULE"), 0o600); err != nil {
		t.Fatal(err)
	}

	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)
	payload := `{
		"conversationId":"agy-native-1",
		"transcriptPath":"/tmp/agy-transcript.jsonl",
		"invocationNum":0
	}`
	out, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(payload),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "agy", "pre-invocation")
	if err != nil {
		t.Fatal(err)
	}

	var req setActivityAPIRequest
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatal(err)
	}
	if req.State != "active" || req.Event != "pre-invocation" {
		t.Fatalf("activity = state %q event %q, want active/pre-invocation", req.State, req.Event)
	}
	if req.AgentSessionID != "agy-native-1" || req.TranscriptPath != "/tmp/agy-transcript.jsonl" {
		t.Fatalf("native metadata = %+v", req)
	}

	var response agyPreInvocationHookOutput
	if err := json.Unmarshal([]byte(out), &response); err != nil {
		t.Fatalf("decode PreInvocation stdout %q: %v", out, err)
	}
	if len(response.InjectSteps) != 1 || response.InjectSteps[0].EphemeralMessage != "AO SYSTEM RULE" {
		t.Fatalf("injectSteps = %#v", response.InjectSteps)
	}
}

func TestHooks_AgyLaterPreInvocationDoesNotDuplicateSystemPrompt(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	t.Setenv("AO_PROJECT_ID", "")
	t.Setenv("AO_RUNTIME_LAUNCH_ID", "launch-3")
	cfg := setConfigEnv(t)

	promptDir := filepath.Join(cfg.dataDir, "prompts", "ao-7")
	if err := os.MkdirAll(promptDir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(promptDir, "system.md"), []byte("AO SYSTEM RULE"), 0o600); err != nil {
		t.Fatal(err)
	}

	srv, _ := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)
	out, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(`{"conversationId":"agy-native-1","invocationNum":1}`),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "agy", "pre-invocation")
	if err != nil {
		t.Fatal(err)
	}

	var response agyPreInvocationHookOutput
	if err := json.Unmarshal([]byte(out), &response); err != nil {
		t.Fatalf("decode PreInvocation stdout %q: %v", out, err)
	}
	if len(response.InjectSteps) != 0 {
		t.Fatalf("later invocation duplicated standing prompt: %#v", response.InjectSteps)
	}
}
