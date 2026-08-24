package codexappserver

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// TestLiveCodexAppServer drives a real `codex app-server`. It is skipped unless
// AO_CODEX_LIVE=1, because it needs a local Codex install, working auth, and it
// makes real model calls. Everything else in this package runs against pipes.
//
// Run it after changing the protocol layer:
//
//	AO_CODEX_LIVE=1 go test ./internal/adapters/chatdriver/codexappserver/ -run Live -v
func TestLiveCodexAppServer(t *testing.T) {
	if os.Getenv("AO_CODEX_LIVE") != "1" {
		t.Skip("set AO_CODEX_LIVE=1 to run against a real codex app-server")
	}

	bin := os.Getenv("AO_CODEX_BIN")
	if bin == "" {
		bin = "codex"
	}
	if _, err := exec.LookPath(bin); err != nil {
		t.Skipf("codex binary %q not on PATH: %v", bin, err)
	}

	workspace := t.TempDir()
	seedGitWorkspace(t, workspace)

	d := New(livePlugin{bin: bin}, slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))

	caps, err := d.Probe(context.Background())
	if err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if missing := ports.MissingProductionCapabilities(caps); len(missing) != 0 {
		t.Fatalf("missing production capabilities: %v", missing)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()

	conv, err := d.Start(ctx, ports.ChatStartConfig{
		SessionID:     "ao-live",
		WorkspacePath: workspace,
		Env:           envMap(),
		Permissions:   ports.PermissionModeDefault,
		SystemPrompt:  "You are in an automated test. Answer in one short sentence.",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	defer func() { _ = conv.Close() }()

	threadID := conv.ProviderConversationID()
	if threadID == "" {
		t.Fatal("no provider conversation id after Start")
	}
	t.Logf("thread %s", threadID)

	if _, err := conv.SendTurn(ctx, ports.ChatUserMessage{
		Text:            "Reply with exactly the word: acknowledged",
		ClientMessageID: "live-1",
		Origin:          domain.MessageOriginHuman,
	}); err != nil {
		t.Fatalf("SendTurn: %v", err)
	}

	var (
		sawDelta                bool
		state                   domain.TurnState
		completedProviderTurnID string
	)
collect:
	for {
		select {
		case ev, ok := <-conv.Events():
			if !ok {
				t.Fatal("event stream closed before the turn completed")
			}
			switch ev.Kind {
			case ports.ChatEventMessageDelta:
				sawDelta = true
			case ports.ChatEventApprovalRequested:
				// Default posture is never-ask, so an approval here means the
				// permission mapping regressed.
				t.Errorf("unexpected approval request under default permissions: %s", ev.Summary)
				_ = conv.ResolveRequest(ctx, ev.RequestID, ports.ChatDecision{ID: "accept"})
			case ports.ChatEventTurnCompleted:
				state = ev.TurnState
				completedProviderTurnID = ev.ProviderTurnID
				break collect
			case ports.ChatEventControllerState:
				if ev.ControllerState == ports.ChatControllerStopped {
					t.Fatalf("controller stopped before the turn completed: %v", ev.Err)
				}
			}
		case <-ctx.Done():
			t.Fatalf("timed out: %v", ctx.Err())
		}
	}

	if !sawDelta {
		t.Error("no streaming deltas observed")
	}
	if state != domain.TurnStateCompleted {
		t.Errorf("turn state = %q, want completed", state)
	}

	// Resume on a fresh process must recover the same thread — this is the
	// daemon-restart path.
	if err := conv.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	resumed, err := d.Resume(ctx, ports.ChatResumeConfig{
		SessionID:              "ao-live",
		ProviderConversationID: threadID,
		WorkspacePath:          workspace,
		Env:                    envMap(),
		Permissions:            ports.PermissionModeDefault,
	})
	if err != nil {
		t.Fatalf("Resume: %v", err)
	}
	defer func() { _ = resumed.Close() }()

	if got := resumed.ProviderConversationID(); got != threadID {
		t.Fatalf("resumed thread = %q, want %q", got, threadID)
	}
	t.Logf("resumed thread %s on a fresh app-server process", threadID)

	// thread/fork loads and writer-locks the fork in this same app-server. AO must
	// therefore rebind this live connection instead of trying to resume the fork in
	// a second process, which Codex rejects as another active writer.
	forker, ok := resumed.(ports.ChatForker)
	if !ok {
		t.Fatal("live Codex conversation does not implement ChatForker")
	}
	binder, ok := resumed.(ports.ChatConversationBinder)
	if !ok {
		t.Fatal("live Codex conversation does not implement ChatConversationBinder")
	}
	forkedID, err := forker.Fork(ctx, &completedProviderTurnID)
	if err != nil {
		t.Fatalf("Fork through completed turn: %v", err)
	}
	if !binder.BindProviderConversation(forkedID) {
		t.Fatalf("bind loaded fork %s", forkedID)
	}
	if got := resumed.ProviderConversationID(); got != forkedID {
		t.Fatalf("bound thread = %q, want fork %q", got, forkedID)
	}
	if _, err := resumed.SendTurn(ctx, ports.ChatUserMessage{
		Text:            "Reply with exactly the word: forked",
		ClientMessageID: "live-fork-1",
		Origin:          domain.MessageOriginHuman,
	}); err != nil {
		t.Fatalf("SendTurn on loaded fork: %v", err)
	}
forkComplete:
	for {
		select {
		case ev, ok := <-resumed.Events():
			if !ok {
				t.Fatal("fork event stream closed before the turn completed")
			}
			if ev.Kind == ports.ChatEventTurnCompleted {
				if ev.TurnState != domain.TurnStateCompleted {
					t.Fatalf("fork turn state = %q", ev.TurnState)
				}
				break forkComplete
			}
			if ev.Kind == ports.ChatEventControllerState && ev.ControllerState == ports.ChatControllerStopped {
				t.Fatalf("controller stopped before fork turn completed: %v", ev.Err)
			}
		case <-ctx.Done():
			t.Fatalf("waiting for fork turn: %v", ctx.Err())
		}
	}

	// A fork is loaded and writer-owned by the app-server that created it. Starting
	// another app-server against the same thread must fail until that creator exits;
	// this is the production boundary that made resume-after-fork lose edited sends.
	forkResumeConfig := ports.ChatResumeConfig{
		SessionID:              "ao-live-fork-resume",
		ProviderConversationID: forkedID,
		WorkspacePath:          workspace,
		Env:                    envMap(),
		Permissions:            ports.PermissionModeDefault,
	}
	contender, err := d.Resume(ctx, forkResumeConfig)
	if err == nil {
		_ = contender.Close()
		t.Fatalf("second app-server resumed writer-owned fork %s", forkedID)
	}
	if !errors.Is(err, ports.ErrChatResumeFailed) {
		t.Fatalf("resume writer-owned fork error = %v, want ErrChatResumeFailed", err)
	}
	t.Logf("second app-server rejected while fork owner remained open: %v", err)

	if err := resumed.Close(); err != nil {
		t.Fatalf("Close fork owner: %v", err)
	}
	released, err := d.Resume(ctx, forkResumeConfig)
	if err != nil {
		t.Fatalf("Resume fork after owner close: %v", err)
	}
	defer func() { _ = released.Close() }()
	if got := released.ProviderConversationID(); got != forkedID {
		t.Fatalf("resumed released fork = %q, want %q", got, forkedID)
	}
	t.Logf("resumed fork %s after creator app-server closed", forkedID)
}

// livePlugin stands in for AO's Codex agent plugin so this test exercises the
// driver rather than binary discovery.
type livePlugin struct{ bin string }

func (p livePlugin) ResolveBinary(context.Context) (string, error) { return p.bin, nil }
func (p livePlugin) AuthStatus(context.Context) (ports.AgentAuthStatus, error) {
	return ports.AgentAuthStatusAuthorized, nil
}

func envMap() map[string]string {
	out := map[string]string{}
	for _, kv := range os.Environ() {
		for i := 0; i < len(kv); i++ {
			if kv[i] == '=' {
				out[kv[:i]] = kv[i+1:]
				break
			}
		}
	}
	return out
}

func seedGitWorkspace(t *testing.T, dir string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("one\ntwo\n"), 0o644); err != nil {
		t.Fatalf("seed file: %v", err)
	}
	for _, args := range [][]string{
		{"init", "-q"},
		{"add", "."},
		{"-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "-m", "seed"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
}
