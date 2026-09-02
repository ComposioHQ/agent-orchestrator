package sessionimport

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func TestClassify(t *testing.T) {
	cases := []struct {
		name    string
		signals Signals
		want    Meaning
	}{
		{
			name:    "greeting that went nowhere",
			signals: Signals{UserMessages: 1, AssistantMessages: 1, FirstPrompt: "hi", Scanned: true},
			want:    MeaningTrivial,
		},
		{
			name:    "greeting with punctuation and case",
			signals: Signals{UserMessages: 1, AssistantMessages: 1, FirstPrompt: "  Hello!!  ", Scanned: true},
			want:    MeaningTrivial,
		},
		{
			name:    "smoke test",
			signals: Signals{UserMessages: 2, AssistantMessages: 2, FirstPrompt: "test test", Scanned: true},
			want:    MeaningTrivial,
		},
		{
			name:    "prompt with no reply is an aborted attempt",
			signals: Signals{UserMessages: 1, AssistantMessages: 0, FirstPrompt: "Refactor the billing module", Scanned: true},
			want:    MeaningTrivial,
		},
		{
			name:    "no human turn at all",
			signals: Signals{UserMessages: 0, AssistantMessages: 3, Scanned: true},
			want:    MeaningTrivial,
		},
		{
			name:    "session that only failed to log in",
			signals: Signals{UserMessages: 1, AssistantMessages: 1, AuthFailure: true, FirstPrompt: "Add a health endpoint to the API", Scanned: true},
			want:    MeaningTrivial,
		},
		{
			name: "debugging an auth bug is not an auth failure",
			signals: Signals{
				UserMessages: 4, AssistantMessages: 4, ToolCalls: 6, AuthFailure: true,
				FirstPrompt: "Our login returns 401 unauthorized after the token refresh", Scanned: true,
			},
			want: MeaningMeaningful,
		},
		{
			name: "short but productive coding session survives",
			signals: Signals{
				UserMessages: 1, AssistantMessages: 1, ToolCalls: 3,
				FirstPrompt: "fix ci", Scanned: true,
			},
			want: MeaningMeaningful,
		},
		{
			name: "discussion with no tool use is kept",
			signals: Signals{
				UserMessages: 4, AssistantMessages: 4,
				FirstPrompt: "How should we shard the sessions table?", Scanned: true,
			},
			want: MeaningMeaningful,
		},
		{
			name:    "one substantial question",
			signals: Signals{UserMessages: 1, AssistantMessages: 1, FirstPrompt: "What are the tradeoffs between optimistic and pessimistic locking for our order pipeline?", Scanned: true},
			want:    MeaningMeaningful,
		},
		{
			name:    "pasted multi-line context",
			signals: Signals{UserMessages: 1, AssistantMessages: 1, FirstPrompt: "why does this fail\npanic: runtime error", Scanned: true},
			want:    MeaningMeaningful,
		},
		{
			name:    "one short question is ambiguous, not discarded",
			signals: Signals{UserMessages: 1, AssistantMessages: 1, FirstPrompt: "what does idempotent mean", Scanned: true},
			want:    MeaningAmbiguous,
		},
		{
			name:    "a transcript too large to scan is substantial by size",
			signals: Signals{Scanned: false},
			want:    MeaningMeaningful,
		},
		{
			name:    "a greeting that turned into a real conversation is kept",
			signals: Signals{UserMessages: 6, AssistantMessages: 6, FirstPrompt: "hey", Scanned: true},
			want:    MeaningMeaningful,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Classify(tc.signals); got != tc.want {
				t.Errorf("Classify() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestMeaningImported(t *testing.T) {
	if MeaningTrivial.Imported() {
		t.Error("trivial conversations must never be imported")
	}
	if !MeaningAmbiguous.Imported() || !MeaningMeaningful.Imported() {
		t.Error("only trivial is withheld")
	}
}

func TestMergeSignalsAcrossSegments(t *testing.T) {
	// A conversation split across resume segments: the first did the work, the
	// second is a short follow-up that replays part of the history.
	first := Signals{UserMessages: 3, AssistantMessages: 3, ToolCalls: 5, FirstPrompt: "Add retries to the fetcher", Scanned: true}
	second := Signals{UserMessages: 1, AssistantMessages: 1, ToolCalls: 0, FirstPrompt: "thanks", Scanned: true}

	merged := mergeSignals(first, second)
	if merged.ToolCalls != 5 {
		t.Errorf("tool calls should stick across segments: got %d", merged.ToolCalls)
	}
	if merged.UserMessages != 3 {
		t.Errorf("counts should take the max, not the sum or the last: got %d", merged.UserMessages)
	}
	if merged.FirstPrompt != "Add retries to the fetcher" {
		t.Errorf("the earliest prompt should win: got %q", merged.FirstPrompt)
	}
	if Classify(merged) != MeaningMeaningful {
		t.Error("a conversation that did real work in any segment is meaningful")
	}

	// One unscannable segment makes the whole conversation unscanned.
	if mergeSignals(first, Signals{Scanned: false}).Scanned {
		t.Error("an unscanned segment must make the conversation unscanned")
	}
}

// A greeting-only Claude transcript: exactly the junk the user never wants to
// see in AO.
const claudeGreetingTranscript = `{"type":"user","message":{"role":"user","content":"hi"},"uuid":"u1","timestamp":"2026-08-20T10:00:00.000Z","sessionId":"22222222-2222-4222-8222-222222222222","cwd":"/Users/dev/project"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello! How can I help?"}]},"uuid":"a1","timestamp":"2026-08-20T10:00:02.000Z"}
`

// A short session that nonetheless edited a file: must survive.
const claudeToolTranscript = `{"type":"user","message":{"role":"user","content":"bump the version"},"uuid":"u1","timestamp":"2026-08-22T10:00:00.000Z","sessionId":"33333333-3333-4333-8333-333333333333","cwd":"/Users/dev/project"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Edit","input":{}}]},"uuid":"a1","timestamp":"2026-08-22T10:00:03.000Z"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]},"uuid":"u2","timestamp":"2026-08-22T10:00:04.000Z"}
`

func TestDiscoverDropsTrivialConversations(t *testing.T) {
	root := t.TempDir()
	claudeDir := filepath.Join(root, ".claude")
	writeFile(t, filepath.Join(claudeDir, "projects", "-Users-dev-project", "22222222-2222-4222-8222-222222222222.jsonl"), claudeGreetingTranscript)
	writeFile(t, filepath.Join(claudeDir, "projects", "-Users-dev-project", "33333333-3333-4333-8333-333333333333.jsonl"), claudeToolTranscript)

	svc := NewService(nil, NewClaudeSourceAt(claudeDir))

	got, err := svc.Discover(context.Background(), DiscoverOptions{})
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("want only the productive session, got %d: %+v", len(got), got)
	}
	if !strings.HasPrefix(got[0].NativeSessionID, "33333333") {
		t.Errorf("kept the wrong session: %q", got[0].NativeSessionID)
	}
	if got[0].Meaning != MeaningMeaningful {
		t.Errorf("a session that edited a file is meaningful: got %q", got[0].Meaning)
	}

	// The withheld session is still reachable for diagnostics and by id.
	all, err := svc.Discover(context.Background(), DiscoverOptions{IncludeTrivial: true})
	if err != nil {
		t.Fatalf("discover including trivial: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("IncludeTrivial should surface both, got %d", len(all))
	}
}

func TestLocateFindsATrivialConversation(t *testing.T) {
	root := t.TempDir()
	claudeDir := filepath.Join(root, ".claude")
	writeFile(t, filepath.Join(claudeDir, "projects", "-Users-dev-project", "22222222-2222-4222-8222-222222222222.jsonl"), claudeGreetingTranscript)

	svc := NewService(nil, NewClaudeSourceAt(claudeDir))

	// Browsing hides it, but naming it explicitly must still import it: the
	// heuristic decides what to show, never what the user is allowed to choose.
	found, ok, err := svc.Locate(context.Background(), "claude-code", "22222222-2222-4222-8222-222222222222")
	if err != nil || !ok {
		t.Fatalf("locate: ok=%v err=%v", ok, err)
	}
	if found.Meaning != MeaningTrivial {
		t.Errorf("want the trivial verdict preserved, got %q", found.Meaning)
	}
}

// A classification question asked of the user's own agent is recorded by some
// CLIs as a conversation. Those live under AO's data directory and must never
// come back as something to import.
func TestDiscoverExcludesAOsOwnDirectories(t *testing.T) {
	root := t.TempDir()
	claudeDir := filepath.Join(root, ".claude")
	aoData := filepath.Join(root, "ao-data")

	inAO := strings.Replace(claudeToolTranscript, "/Users/dev/project", filepath.Join(aoData, "classifier"), 1)
	writeFile(t, filepath.Join(claudeDir, "projects", "-ao", "44444444-4444-4444-8444-444444444444.jsonl"), inAO)
	writeFile(t, filepath.Join(claudeDir, "projects", "-Users-dev-project", "33333333-3333-4333-8333-333333333333.jsonl"), claudeToolTranscript)

	svc := NewService(nil, NewClaudeSourceAt(claudeDir))
	got, err := svc.Discover(context.Background(), DiscoverOptions{ExcludeRoots: []string{aoData}})
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("AO's own conversation should be excluded, got %d: %+v", len(got), got)
	}
	if !strings.HasPrefix(got[0].NativeSessionID, "33333333") {
		t.Errorf("excluded the wrong conversation: %q", got[0].NativeSessionID)
	}
}

func TestUnderAnyRoot(t *testing.T) {
	if !underAnyRoot("/a/b/c", []string{"/a/b"}) {
		t.Error("a directory inside a root is under it")
	}
	if !underAnyRoot("/a/b", []string{"/a/b"}) {
		t.Error("a root is under itself")
	}
	if underAnyRoot("/a/bc", []string{"/a/b"}) {
		t.Error("a sibling sharing a name prefix is not inside the root")
	}
	if underAnyRoot("/a/b", nil) || underAnyRoot("", []string{"/a"}) {
		t.Error("empty inputs must not match")
	}
}
