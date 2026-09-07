package cli

import (
	"net/http"
	"strings"
	"testing"
)

// --- Pure unit tests for deriveSessionResult -------------------------------

func TestDeriveSessionResult_CompletedTranscriptReturnsExactAssistantText(t *testing.T) {
	snapshot := conversationSnapshotDTO{
		Turns: []conversationTurnDTO{
			{ID: "turn-1", State: "completed"},
		},
		Messages: []conversationMessageDTO{
			{ID: "m1", TurnID: "turn-1", Sequence: 1, Role: "user", Text: "do the thing"},
			{ID: "m2", TurnID: "turn-1", Sequence: 2, Role: "assistant", Text: "done: found 3 files"},
		},
	}
	got := deriveSessionResult("demo-1", snapshot)
	if got.Status != string(sessionResultStatusCompleted) {
		t.Fatalf("status = %q, want completed", got.Status)
	}
	if got.Result != "done: found 3 files" {
		t.Fatalf("result = %q, want exact assistant text", got.Result)
	}
	if got.TurnID != "turn-1" {
		t.Fatalf("turnId = %q, want turn-1", got.TurnID)
	}
}

// TestDeriveSessionResult_SelectsFinalOutputOverIntermediateActivity covers
// requirement 3: intermediate assistant/tool activity plus a final assistant
// message must resolve to the final message, not an earlier one.
func TestDeriveSessionResult_SelectsFinalOutputOverIntermediateActivity(t *testing.T) {
	snapshot := conversationSnapshotDTO{
		Turns: []conversationTurnDTO{
			{ID: "turn-1", State: "completed"},
			{ID: "turn-2", State: "completed"},
		},
		Messages: []conversationMessageDTO{
			{ID: "m1", TurnID: "turn-1", Sequence: 1, Role: "user", Text: "step one"},
			{ID: "m2", TurnID: "turn-1", Sequence: 2, Role: "assistant", Text: "intermediate answer"},
			{ID: "m3", TurnID: "turn-2", Sequence: 3, Role: "user", Text: "step two"},
			{ID: "m4", TurnID: "turn-2", Sequence: 4, Role: "assistant", Text: "final answer"},
		},
	}
	got := deriveSessionResult("demo-1", snapshot)
	if got.Status != string(sessionResultStatusCompleted) {
		t.Fatalf("status = %q, want completed", got.Status)
	}
	if got.Result != "final answer" {
		t.Fatalf("result = %q, want the final turn's assistant message", got.Result)
	}
	if got.TurnID != "turn-2" {
		t.Fatalf("turnId = %q, want turn-2 (the final turn)", got.TurnID)
	}
}

// TestDeriveSessionResult_SingleTurnIntermediateThenFinalAssistantMessage is
// the narrower companion to the cross-turn case above: within one completed
// turn that produced intermediate assistant output before its real final
// assistant message (e.g. "let me check the repo" followed later by
// "FINDINGS: ..."), the final message must be selected -- not the
// intermediate one, even though both share the same turn.
func TestDeriveSessionResult_SingleTurnIntermediateThenFinalAssistantMessage(t *testing.T) {
	snapshot := conversationSnapshotDTO{
		Turns: []conversationTurnDTO{
			{ID: "turn-1", State: "completed"},
		},
		Messages: []conversationMessageDTO{
			{ID: "m1", TurnID: "turn-1", Sequence: 1, Role: "user", Text: "do some archaeology"},
			{ID: "m2", TurnID: "turn-1", Sequence: 2, Role: "assistant", Text: "Let me check the repository first."},
			{ID: "m3", TurnID: "turn-1", Sequence: 3, Role: "assistant", Text: "FINDINGS: three files, one commit."},
		},
	}
	got := deriveSessionResult("demo-1", snapshot)
	if got.Status != string(sessionResultStatusCompleted) {
		t.Fatalf("status = %q, want completed", got.Status)
	}
	if got.Result != "FINDINGS: three files, one commit." {
		t.Fatalf("result = %q, want the turn's final assistant message, not the intermediate one", got.Result)
	}
	if got.TurnID != "turn-1" {
		t.Fatalf("turnId = %q, want turn-1", got.TurnID)
	}
}

// TestDeriveSessionResult_RunningTurnIsNotReady covers requirement 4: a
// running/queued last turn must report "not ready", never a fabricated
// empty success.
func TestDeriveSessionResult_RunningTurnIsNotReady(t *testing.T) {
	for _, state := range []string{"queued", "running"} {
		snapshot := conversationSnapshotDTO{
			Turns: []conversationTurnDTO{{ID: "turn-1", State: state}},
		}
		got := deriveSessionResult("demo-1", snapshot)
		if got.Status != string(sessionResultStatusRunning) {
			t.Fatalf("state=%s: status = %q, want running", state, got.Status)
		}
		if got.Result != "" {
			t.Fatalf("state=%s: result should be empty while running, got %q", state, got.Result)
		}
	}
}

func TestDeriveSessionResult_NoTurnsYetIsRunning(t *testing.T) {
	got := deriveSessionResult("demo-1", conversationSnapshotDTO{})
	if got.Status != string(sessionResultStatusRunning) {
		t.Fatalf("status = %q, want running", got.Status)
	}
	if got.Result != "" {
		t.Fatalf("result should be empty, got %q", got.Result)
	}
}

// TestDeriveSessionResult_FailedTurnIsClearFailure covers requirement 5.
func TestDeriveSessionResult_FailedTurnIsClearFailure(t *testing.T) {
	for _, state := range []string{"failed", "interrupted", "cancelled"} {
		snapshot := conversationSnapshotDTO{
			Turns: []conversationTurnDTO{{ID: "turn-1", State: state, ErrorMessage: "boom"}},
		}
		got := deriveSessionResult("demo-1", snapshot)
		if got.Status != string(sessionResultStatusFailed) {
			t.Fatalf("state=%s: status = %q, want failed", state, got.Status)
		}
		if got.Result != "" {
			t.Fatalf("state=%s: result should be empty on failure, got %q", state, got.Result)
		}
	}
}

// TestDeriveSessionResult_CompletedTurnWithoutAssistantMessageIsMalformed
// covers requirement 6: a conversation that contradicts its own turn state
// must be reported as malformed, not silently answered.
func TestDeriveSessionResult_CompletedTurnWithoutAssistantMessageIsMalformed(t *testing.T) {
	snapshot := conversationSnapshotDTO{
		Turns: []conversationTurnDTO{{ID: "turn-1", State: "completed"}},
		Messages: []conversationMessageDTO{
			{ID: "m1", TurnID: "turn-1", Role: "user", Text: "do the thing"},
		},
	}
	got := deriveSessionResult("demo-1", snapshot)
	if got.Status != string(sessionResultStatusMalformed) {
		t.Fatalf("status = %q, want malformed", got.Status)
	}
	if got.Result != "" {
		t.Fatalf("result should be empty when malformed, got %q", got.Result)
	}
	if got.ErrorMessage == "" {
		t.Fatal("expected a non-empty explanation of the malformed state")
	}
}

func TestDeriveSessionResult_UnrecognizedTurnStateIsMalformed(t *testing.T) {
	snapshot := conversationSnapshotDTO{
		Turns: []conversationTurnDTO{{ID: "turn-1", State: "some-future-state"}},
	}
	got := deriveSessionResult("demo-1", snapshot)
	if got.Status != string(sessionResultStatusMalformed) {
		t.Fatalf("status = %q, want malformed", got.Status)
	}
}

func TestDeriveSessionResult_StreamingAssistantMessageOnCompletedTurnIsMalformed(t *testing.T) {
	snapshot := conversationSnapshotDTO{
		Turns: []conversationTurnDTO{{ID: "turn-1", State: "completed"}},
		Messages: []conversationMessageDTO{
			{ID: "m1", TurnID: "turn-1", Role: "assistant", Text: "still typing", Streaming: true},
		},
	}
	got := deriveSessionResult("demo-1", snapshot)
	if got.Status != string(sessionResultStatusMalformed) {
		t.Fatalf("status = %q, want malformed", got.Status)
	}
}

func TestDeriveSessionResult_SkipsRolledBackFinalTurn(t *testing.T) {
	snapshot := conversationSnapshotDTO{
		Turns: []conversationTurnDTO{
			{ID: "turn-1", State: "completed"},
			{ID: "turn-2", State: "completed", RolledBack: true},
		},
		Messages: []conversationMessageDTO{
			{ID: "m1", TurnID: "turn-1", Role: "assistant", Text: "kept answer"},
		},
	}
	got := deriveSessionResult("demo-1", snapshot)
	if got.Status != string(sessionResultStatusCompleted) {
		t.Fatalf("status = %q, want completed", got.Status)
	}
	if got.Result != "kept answer" {
		t.Fatalf("result = %q, want the non-rolled-back turn's answer", got.Result)
	}
}

// --- CLI-level tests ---------------------------------------------------

func TestSessionResult_CompletedExitsZeroAndPrintsText(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := conversationServer(t, http.StatusOK, sampleConversationJSON)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "session", "result", "demo-1")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	if capture.path != "/api/v1/sessions/demo-1/conversation" {
		t.Fatalf("path = %q, want the existing conversation endpoint", capture.path)
	}
	if strings.TrimSpace(out) != "here is what I found" {
		t.Fatalf("stdout = %q, want exact final assistant text", out)
	}
}

func TestSessionResult_CompletedJSON(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := conversationServer(t, http.StatusOK, sampleConversationJSON)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "session", "result", "demo-1", "--json")
	if err != nil {
		t.Fatalf("unexpected error: %v\nstderr=%s", err, errOut)
	}
	for _, want := range []string{`"status": "completed"`, `"result": "here is what I found"`, `"sessionId": "demo-1"`} {
		if !strings.Contains(out, want) {
			t.Fatalf("json output missing %q:\n%s", want, out)
		}
	}
}

func TestSessionResult_RunningExitsNonZeroWithoutFabricatingSuccess(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := conversationServer(t, http.StatusOK,
		`{"conversationId":"conv-1","sessionId":"demo-1","mode":"chat","controller":"busy","latestSequence":1,
		  "turns":[{"id":"turn-1","state":"running","requestedAt":"2026-06-02T12:00:00Z"}],
		  "messages":[{"id":"m1","turnId":"turn-1","sequence":1,"role":"user","origin":"human","text":"go","createdAt":"2026-06-02T12:00:00Z"}]}`)
	writeRunFileFor(t, cfg, srv)

	out, _, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "session", "result", "demo-1", "--json")
	if err == nil {
		t.Fatal("expected non-zero exit while the session is still running")
	}
	if ExitCode(err) != 1 {
		t.Fatalf("exit code = %d, want 1", ExitCode(err))
	}
	if !strings.Contains(out, `"status": "running"`) {
		t.Fatalf("json output missing running status:\n%s", out)
	}
	if strings.Contains(out, `"result"`) {
		t.Fatalf("running session must not report a result field:\n%s", out)
	}
}

func TestSessionResult_FailedExitsNonZero(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := conversationServer(t, http.StatusOK,
		`{"conversationId":"conv-1","sessionId":"demo-1","mode":"chat","controller":"stopped","latestSequence":1,
		  "turns":[{"id":"turn-1","state":"failed","errorMessage":"provider crashed","requestedAt":"2026-06-02T12:00:00Z"}],
		  "messages":[]}`)
	writeRunFileFor(t, cfg, srv)

	out, _, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "session", "result", "demo-1", "--json")
	if err == nil {
		t.Fatal("expected non-zero exit for a failed session")
	}
	if ExitCode(err) != 1 {
		t.Fatalf("exit code = %d, want 1", ExitCode(err))
	}
	if !strings.Contains(out, `"status": "failed"`) || !strings.Contains(out, "provider crashed") {
		t.Fatalf("json output missing failure detail:\n%s", out)
	}
}

func TestSessionResult_MalformedConversationExitsNonZero(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := conversationServer(t, http.StatusOK,
		`{"conversationId":"conv-1","sessionId":"demo-1","mode":"chat","controller":"ready","latestSequence":1,
		  "turns":[{"id":"turn-1","state":"completed","requestedAt":"2026-06-02T12:00:00Z"}],
		  "messages":[]}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "session", "result", "demo-1", "--json")
	if err == nil {
		t.Fatal("expected non-zero exit for a malformed conversation")
	}
	if ExitCode(err) != 1 {
		t.Fatalf("exit code = %d, want 1", ExitCode(err))
	}
	if !strings.Contains(out, `"status": "malformed"`) {
		t.Fatalf("json output missing malformed status:\n%s", out)
	}
	if !strings.Contains(err.Error(), "malformed") && !strings.Contains(errOut, "malformed") {
		t.Fatalf("error text should explain the malformed state: %v\nstderr=%s", err, errOut)
	}
}

func TestSessionResult_HumanReadableNonCompletedState(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := conversationServer(t, http.StatusOK,
		`{"conversationId":"conv-1","sessionId":"demo-1","mode":"chat","controller":"busy","latestSequence":1,
		  "turns":[{"id":"turn-1","state":"running","requestedAt":"2026-06-02T12:00:00Z"}],"messages":[]}`)
	writeRunFileFor(t, cfg, srv)

	out, _, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "session", "result", "demo-1")
	if err == nil {
		t.Fatal("expected non-zero exit while running")
	}
	if !strings.Contains(out, "demo-1") || !strings.Contains(out, "running") {
		t.Fatalf("human output should name the session and its status:\n%s", out)
	}
}

func TestSessionResult_DaemonErrorPropagates(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := conversationServer(t, http.StatusNotFound,
		`{"error":"not_found","code":"SESSION_NOT_FOUND","message":"Unknown session"}`)
	writeRunFileFor(t, cfg, srv)

	_, _, err := executeCLI(t, Deps{
		ProcessAlive: func(int) bool { return true },
	}, "session", "result", "missing")
	if err == nil {
		t.Fatal("expected error for unknown session")
	}
	if ExitCode(err) != 1 {
		t.Fatalf("exit code = %d, want 1", ExitCode(err))
	}
}
