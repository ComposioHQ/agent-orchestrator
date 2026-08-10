package opencodeacp

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/opencode"
	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/ptyexec"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Run explicitly with AO_LIVE_OPENCODE_ACP=1. It uses the user's existing
// OpenCode executable, configuration, providers, and credentials; CI never
// depends on any of them.
func TestLiveOpenCodeACP(t *testing.T) {
	if os.Getenv("AO_LIVE_OPENCODE_ACP") != "1" {
		t.Skip("set AO_LIVE_OPENCODE_ACP=1 to run against the local OpenCode account")
	}

	plugin := opencode.New()
	driver := New(plugin, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	if _, err := driver.Probe(ctx); err != nil {
		t.Fatalf("Probe: %v", err)
	}
	workspace := t.TempDir()
	dataDir := t.TempDir()
	conversation, err := driver.Start(ctx, ports.ChatStartConfig{
		SessionID: "live-opencode-acp", DataDir: dataDir, WorkspacePath: workspace,
		Env: envMap(), SystemPrompt: "Answer in one short sentence.",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { _ = conversation.Close() })

	ref, err := conversation.SendTurn(ctx, ports.ChatUserMessage{
		Text: "Reply with exactly: AO OpenCode ACP works", ClientMessageID: "live-1",
		Origin: domain.MessageOriginHuman,
	})
	if err != nil {
		t.Fatalf("SendTurn: %v", err)
	}
	if err := conversation.(ports.ChatDeferredTurnStarter).StartDeferredTurn(ref.ProviderTurnID); err != nil {
		t.Fatalf("StartDeferredTurn: %v", err)
	}

	var answer strings.Builder
	for {
		select {
		case event, ok := <-conversation.Events():
			if !ok {
				t.Fatalf("controller closed before completion; answer=%q", answer.String())
			}
			switch event.Kind {
			case ports.ChatEventMessageDelta:
				answer.WriteString(event.Delta)
			case ports.ChatEventTurnCompleted:
				if event.TurnState != domain.TurnStateCompleted {
					t.Fatalf("turn state = %q; answer=%q", event.TurnState, answer.String())
				}
				if !strings.Contains(answer.String(), "AO OpenCode ACP works") {
					t.Fatalf("answer = %q", answer.String())
				}
				providerID := conversation.ProviderConversationID()
				if providerID == "" {
					t.Fatal("ACP conversation returned an empty provider conversation id")
				}
				if err := conversation.Close(); err != nil {
					t.Fatalf("Close ACP conversation: %v", err)
				}
				assertLiveTUIRestore(ctx, t, plugin, workspace, providerID, "AO OpenCode ACP works")
				return
			}
		case <-ctx.Done():
			t.Fatalf("live turn timed out: %v; answer=%q", ctx.Err(), answer.String())
		}
	}
}

func assertLiveTUIRestore(
	ctx context.Context,
	t *testing.T,
	plugin *opencode.Plugin,
	workspace, providerID, historyMarker string,
) {
	t.Helper()
	nativeID, ok, err := plugin.NativeConversationID(
		ctx, ports.SessionRef{}, domain.SessionModeChat, providerID,
	)
	if err != nil || !ok {
		t.Fatalf("NativeConversationID(%q): id=%q ok=%v err=%v", providerID, nativeID, ok, err)
	}
	restore, resumable, err := plugin.GetRestoreCommand(ctx, ports.RestoreConfig{
		Session: ports.SessionRef{
			ID:            "live-opencode-tui-restore",
			WorkspacePath: workspace,
			Metadata:      map[string]string{ports.MetadataKeyAgentSessionID: nativeID},
		},
	})
	if err != nil {
		t.Fatalf("GetRestoreCommand: %v", err)
	}
	if !resumable {
		t.Fatal("GetRestoreCommand reported the ACP provider conversation as non-resumable")
	}
	if len(restore) < 3 || restore[len(restore)-2] != "--session" || restore[len(restore)-1] != providerID {
		t.Fatalf("restore command = %#v, want trailing --session %q", restore, providerID)
	}

	// OpenCode's TUI requires a real terminal. Starting the adapter-produced
	// command on AO's shared PTY path and finding the ACP turn in its replay
	// proves the provider id names the same native session on both surfaces.
	t.Chdir(workspace)
	stream, err := ptyexec.Spawn(ctx, restore, liveTUIEnv(), 40, 120)
	if err != nil {
		t.Fatalf("start TUI restore: %v", err)
	}
	defer stream.Close()
	output, err := readUntilMarker(stream, historyMarker, 30*time.Second)
	if err != nil {
		t.Fatalf("TUI did not replay ACP history: %v; output=%q", err, output)
	}
}

func readUntilMarker(stream ports.Stream, marker string, timeout time.Duration) (string, error) {
	type result struct {
		output string
		err    error
	}
	results := make(chan result, 1)
	go func() {
		var output bytes.Buffer
		buf := make([]byte, 4096)
		for {
			n, err := stream.Read(buf)
			if n > 0 {
				output.Write(buf[:n])
				if bytes.Contains(output.Bytes(), []byte(marker)) {
					results <- result{output: output.String()}
					return
				}
			}
			if err != nil {
				if errors.Is(err, io.EOF) {
					err = nil
				}
				results <- result{output: output.String(), err: err}
				return
			}
		}
	}()

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case got := <-results:
		if !strings.Contains(got.output, marker) {
			if got.err == nil {
				got.err = fmt.Errorf("terminal closed before marker %q appeared", marker)
			}
			return got.output, got.err
		}
		return got.output, nil
	case <-timer.C:
		_ = stream.Close()
		got := <-results
		return got.output, fmt.Errorf("timed out waiting for marker %q", marker)
	}
}

func liveTUIEnv() []string {
	env := make([]string, 0, len(os.Environ())+2)
	for _, pair := range os.Environ() {
		if strings.HasPrefix(pair, "TERM=") || strings.HasPrefix(pair, "COLORTERM=") ||
			strings.HasPrefix(pair, "NO_COLOR=") {
			continue
		}
		env = append(env, pair)
	}
	return append(env, "TERM=xterm-256color", "COLORTERM=truecolor")
}

func envMap() map[string]string {
	out := make(map[string]string)
	for _, pair := range os.Environ() {
		name, value, ok := strings.Cut(pair, "=")
		if ok {
			out[name] = value
		}
	}
	return out
}
