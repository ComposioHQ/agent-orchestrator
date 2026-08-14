package cli

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type usageCapture struct {
	bodies []string
	hits   int
}

func usageServer(t *testing.T) (*httptest.Server, *usageCapture) {
	t.Helper()
	capture := &usageCapture{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/usage") {
			http.NotFound(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		capture.bodies = append(capture.bodies, string(body))
		capture.hits++
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true,"sessionId":"ao-7"}`)
	}))
	t.Cleanup(srv.Close)
	return srv, capture
}

func decodeUsage(t *testing.T, body string) recordUsageAPIRequest {
	t.Helper()
	var req recordUsageAPIRequest
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatalf("decode usage body: %v\nbody=%s", err, body)
	}
	return req
}

const turnA = `{"type":"assistant","timestamp":"2026-08-14T10:00:00Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}` + "\n"
const turnB = `{"type":"assistant","timestamp":"2026-08-14T10:00:30Z","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":80,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}` + "\n"

func runUsageHook(t *testing.T, transcriptPath, event string) {
	t.Helper()
	payload, _ := json.Marshal(map[string]string{"transcript_path": transcriptPath})
	_, errOut, err := executeCLI(t, Deps{
		In:           strings.NewReader(string(payload)),
		ProcessAlive: func(int) bool { return true },
	}, "hooks", "claude-code", event)
	if err != nil {
		t.Fatalf("hook %s: %v\nstderr=%s", event, err, errOut)
	}
}

func TestUsageHook_StopReportsNewTurnsAndAdvancesOffset(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := usageServer(t)
	writeRunFileFor(t, cfg, srv)

	transcript := filepath.Join(t.TempDir(), "transcript.jsonl")
	if err := os.WriteFile(transcript, []byte(turnA+turnB), 0o600); err != nil {
		t.Fatal(err)
	}

	// First Stop: both turns reported.
	runUsageHook(t, transcript, "stop")
	if capture.hits != 1 {
		t.Fatalf("hits after first stop = %d, want 1", capture.hits)
	}
	if got := decodeUsage(t, capture.bodies[0]); len(got.Turns) != 2 {
		t.Fatalf("first stop turns = %d, want 2", len(got.Turns))
	}

	// Second Stop, transcript unchanged: nothing new, so no POST at all.
	runUsageHook(t, transcript, "stop")
	if capture.hits != 1 {
		t.Fatalf("hits after unchanged second stop = %d, want 1 (no double count)", capture.hits)
	}

	// A third turn arrives; next Stop reports only that one.
	turnC := `{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1,"output_tokens":2,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}` + "\n"
	f, _ := os.OpenFile(transcript, os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.WriteString(turnC)
	_ = f.Close()

	runUsageHook(t, transcript, "stop")
	if capture.hits != 2 {
		t.Fatalf("hits after third turn = %d, want 2", capture.hits)
	}
	if got := decodeUsage(t, capture.bodies[1]); len(got.Turns) != 1 {
		t.Fatalf("incremental stop turns = %d, want 1", len(got.Turns))
	}
}

func TestUsageHook_SessionEndReportsSummary(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := usageServer(t)
	writeRunFileFor(t, cfg, srv)

	transcript := filepath.Join(t.TempDir(), "transcript.jsonl")
	if err := os.WriteFile(transcript, []byte(turnA+turnB), 0o600); err != nil {
		t.Fatal(err)
	}

	runUsageHook(t, transcript, "session-end")
	if capture.hits != 1 {
		t.Fatalf("hits = %d, want 1", capture.hits)
	}
	got := decodeUsage(t, capture.bodies[0])
	if got.Summary == nil {
		t.Fatal("session-end must include a summary")
	}
	if got.Summary.TurnCount != 2 {
		t.Fatalf("summary turnCount = %d, want 2", got.Summary.TurnCount)
	}
	if got.Summary.InputTokens != 110 || got.Summary.OutputTokens != 130 {
		t.Fatalf("summary tokens = %+v", got.Summary)
	}
	if got.Summary.DurationMs != 30000 {
		t.Fatalf("summary duration = %d, want 30000", got.Summary.DurationMs)
	}
}

func TestUsageHook_NonClaudeIgnored(t *testing.T) {
	t.Setenv("AO_SESSION_ID", "ao-7")
	cfg := setConfigEnv(t)
	srv, capture := usageServer(t)
	writeRunFileFor(t, cfg, srv)
	transcript := filepath.Join(t.TempDir(), "t.jsonl")
	_ = os.WriteFile(transcript, []byte(turnA), 0o600)

	runUsageHook(t, transcript, "stop") // agent is claude-code here; sanity that it DOES post
	base := capture.hits
	// Now a non-claude agent stop must not post usage.
	payload, _ := json.Marshal(map[string]string{"transcript_path": transcript})
	_, _, _ = executeCLI(t, Deps{In: strings.NewReader(string(payload)), ProcessAlive: func(int) bool { return true }}, "hooks", "codex", "stop")
	if capture.hits != base {
		t.Fatalf("non-claude agent posted usage: hits went %d -> %d", base, capture.hits)
	}
}
