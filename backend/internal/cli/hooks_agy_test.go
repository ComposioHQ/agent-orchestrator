package cli

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

func TestHooks_AgyAfterAgentReportsConversationFacts(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	t.Setenv("AO_PROJECT_ID", "")
	t.Setenv("AO_RUNTIME_LAUNCH_ID", "launch-3")
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	payload := `{
		"session_id":"agy-native-1",
		"prompt":"rebase PR #135 and resolve the conflicts",
		"prompt_response":"Rebased the branch and resolved the conflicts."
	}`
	_, _, err := executeCLI(t, Deps{
		In:           strings.NewReader(payload),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "agy", "after-agent")
	if err != nil {
		t.Fatal(err)
	}

	var req setActivityAPIRequest
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatal(err)
	}
	if req.State != "idle" || req.Event != "after-agent" {
		t.Fatalf("activity = state %q event %q, want idle/after-agent", req.State, req.Event)
	}
	if req.AgentSessionID != "agy-native-1" {
		t.Fatalf("agent session id = %q, want agy-native-1", req.AgentSessionID)
	}
	if req.LatestUserPrompt != "rebase PR #135 and resolve the conflicts" {
		t.Fatalf("latest user prompt = %q", req.LatestUserPrompt)
	}
	if req.LatestAssistantUpdate != "Rebased the branch and resolved the conflicts." {
		t.Fatalf("latest assistant update = %q", req.LatestAssistantUpdate)
	}
	if req.LaunchID != "launch-3" {
		t.Fatalf("launch id = %q, want launch-3", req.LaunchID)
	}
}
