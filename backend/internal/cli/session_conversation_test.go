package cli

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// conversationServer wires an httptest server that answers
// GET /api/v1/sessions/{id}/conversation with a fixed body, and records the
// exact request path it received.
func conversationServer(t *testing.T, status int, respBody string) (*httptest.Server, *sendCapture) {
	t.Helper()
	capture := &sendCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || !strings.HasSuffix(r.URL.Path, "/conversation") {
			http.NotFound(w, r)
			return
		}
		capture.path = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, respBody)
	}))
	t.Cleanup(srv.Close)
	return srv, capture
}

const sampleConversationJSON = `{
	"conversationId": "conv-1",
	"sessionId": "demo-1",
	"mode": "chat",
	"controller": "ready",
	"latestSequence": 3,
	"turns": [
		{"id": "turn-1", "state": "completed", "requestedAt": "2026-06-02T12:00:00Z"}
	],
	"messages": [
		{"id": "msg-1", "turnId": "turn-1", "sequence": 1, "role": "user", "origin": "human", "text": "read the repo", "createdAt": "2026-06-02T12:00:00Z"},
		{"id": "msg-2", "turnId": "turn-1", "sequence": 2, "role": "assistant", "origin": "provider", "text": "here is what I found", "createdAt": "2026-06-02T12:00:05Z"}
	]
}`

// TestSessionConversation_CallsExistingEndpoint covers requirement 1: the CLI
// reuses the daemon's existing GET conversation route rather than a new one.
func TestSessionConversation_CallsExistingEndpoint(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := conversationServer(t, http.StatusOK, sampleConversationJSON)
	writeRunFileFor(t, cfg, srv)

	_, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "session", "conversation", "demo-1")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.path != "/api/v1/sessions/demo-1/conversation" {
		t.Fatalf("path = %q, want /api/v1/sessions/demo-1/conversation", capture.path)
	}
}

// TestSessionConversation_JSON covers requirement 7: machine-readable output.
func TestSessionConversation_JSON(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := conversationServer(t, http.StatusOK, sampleConversationJSON)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "session", "conversation", "demo-1", "--json")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	for _, want := range []string{`"conversationId": "conv-1"`, `"role": "assistant"`, `"text": "here is what I found"`} {
		if !strings.Contains(out, want) {
			t.Fatalf("json output missing %q:\n%s", want, out)
		}
	}
}

// TestSessionConversation_HumanReadable covers requirement 8.
func TestSessionConversation_HumanReadable(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := conversationServer(t, http.StatusOK, sampleConversationJSON)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "session", "conversation", "demo-1")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if !strings.Contains(out, "session: demo-1") {
		t.Fatalf("human output missing session id:\n%s", out)
	}
	if !strings.Contains(out, "[user]") || !strings.Contains(out, "read the repo") {
		t.Fatalf("human output missing user message:\n%s", out)
	}
	if !strings.Contains(out, "[assistant]") || !strings.Contains(out, "here is what I found") {
		t.Fatalf("human output missing assistant message:\n%s", out)
	}
}

// TestSessionConversation_EmptyTranscript exercises a session with no turns yet.
func TestSessionConversation_EmptyTranscript(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := conversationServer(t, http.StatusOK,
		`{"conversationId":"conv-1","sessionId":"demo-1","mode":"chat","controller":"ready","latestSequence":0,"turns":[],"messages":[]}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "session", "conversation", "demo-1")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if !strings.Contains(out, "(no conversation activity yet)") {
		t.Fatalf("expected empty-transcript hint, got:\n%s", out)
	}
}

// TestSessionCommand_HelpDiscoversNewSubcommands covers requirement 9:
// discoverability through normal CLI help.
func TestSessionCommand_HelpDiscoversNewSubcommands(t *testing.T) {
	setConfigEnv(t)
	out, errOut, err := executeCLI(t, Deps{}, "session", "--help")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	for _, want := range []string{"conversation", "result"} {
		if !strings.Contains(out, want) {
			t.Fatalf("`ao session --help` does not mention %q:\n%s", want, out)
		}
	}
}

func TestSessionResultCommand_HelpDiscoverable(t *testing.T) {
	setConfigEnv(t)
	out, errOut, err := executeCLI(t, Deps{}, "session", "result", "--help")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if !strings.Contains(out, "--json") {
		t.Fatalf("`ao session result --help` does not document --json:\n%s", out)
	}
}
