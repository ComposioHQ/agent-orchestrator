package muxd

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/ptyexec"
	"github.com/aoagents/agent-orchestrator/backend/internal/config"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/terminal"
)

// This file is the conformance check that the hosted terminal transport is the
// SAME protocol as the local one, not a compatible-looking sibling.
//
// It deliberately imports internal/httpd and internal/terminal and stands up
// the daemon's real /mux, then drives one scripted exchange twice: once
// straight at the daemon, the way the desktop talks to a local session, and
// once through this package's published listener, the way it talks to a hosted
// one. The two transcripts must match.
//
// A hand-written expectation would only ever prove that the relay matches what
// the test author believed the protocol to be on the day they wrote it.
// Comparing against the live local implementation is what makes a future change
// to internal/terminal/protocol.go show up here instead of in production.

// stubSource attaches a throwaway command instead of a real tmux pane, so the
// exchange exercises the genuine Manager + upgrade + wsjson path without a
// runtime. It mirrors the stub in internal/httpd's own mux test: alive until
// the first attach, then dead, so the command's exit reads as the pane going
// away rather than as a drop to re-attach.
type stubSource struct {
	argv     []string
	attached atomic.Bool
}

func (s *stubSource) Attach(ctx context.Context, _ ports.RuntimeHandle, rows, cols uint16) (ports.Stream, error) {
	s.attached.Store(true)
	return ptyexec.Spawn(ctx, s.argv, nil, rows, cols)
}

func (s *stubSource) IsAlive(context.Context, ports.RuntimeHandle) (bool, error) {
	return !s.attached.Load(), nil
}

// localDaemonMux starts the daemon's real router with a terminal manager behind
// it and returns its ws:// mux URL.
func localDaemonMux(t *testing.T, argv []string) string {
	t.Helper()
	manager := terminal.NewManager(&stubSource{argv: argv}, nil, discardLogger())
	t.Cleanup(manager.Close)
	router := httpd.NewRouterWithControl(config.Config{}, discardLogger(), manager, httpd.APIDeps{}, httpd.ControlDeps{})
	ts := httptest.NewServer(router)
	t.Cleanup(ts.Close)
	return "ws" + strings.TrimPrefix(ts.URL, "http") + "/mux"
}

// transcript is one exchange reduced to what the protocol actually promises:
// the ordered channel/type sequence (consecutive data frames collapsed, since
// PTY chunking is a property of the pipe and not of the protocol) and the
// decoded terminal bytes.
type transcript struct {
	frames []string
	output string
}

type muxFrame struct {
	Ch   string `json:"ch"`
	ID   string `json:"id,omitempty"`
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols uint16 `json:"cols,omitempty"`
	Rows uint16 `json:"rows,omitempty"`
}

// scriptedExchange runs the same client script against any /mux: open a pane,
// ping the system channel, then read until the pane exits.
func scriptedExchange(t *testing.T, conn *websocket.Conn) transcript {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	conn.SetReadLimit(readLimit)

	write(t, ctx, conn, muxFrame{Ch: "terminal", Type: "open", ID: "t1", Cols: 80, Rows: 24})
	write(t, ctx, conn, muxFrame{Ch: "system", Type: "ping"})

	var got transcript
	for {
		_, payload, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		var frame muxFrame
		if err := json.Unmarshal(payload, &frame); err != nil {
			t.Fatalf("decode %q: %v", payload, err)
		}
		if frame.Ch == "terminal" && frame.Type == "data" {
			raw, err := base64.StdEncoding.DecodeString(frame.Data)
			if err != nil {
				t.Fatalf("decode terminal data: %v", err)
			}
			got.output += string(raw)
		}
		label := frame.Ch + "/" + frame.Type
		if n := len(got.frames); n == 0 || got.frames[n-1] != label {
			got.frames = append(got.frames, label)
		}
		if frame.Ch == "terminal" && frame.Type == "exited" {
			return got
		}
	}
}

func write(t *testing.T, ctx context.Context, conn *websocket.Conn, frame muxFrame) {
	t.Helper()
	payload, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("encode %+v: %v", frame, err)
	}
	if err := conn.Write(ctx, websocket.MessageText, payload); err != nil {
		t.Fatalf("write %+v: %v", frame, err)
	}
}

func TestSandboxMuxIsTheSameProtocolAsTheLocalMux(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("PTY spawning not supported on Windows")
	}
	argv := []string{"/bin/sh", "-c", "printf MUXOK; exit 0"}

	directURL := localDaemonMux(t, argv)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	direct, _, err := websocket.Dial(ctx, directURL, nil)
	if err != nil {
		t.Fatalf("dial the local daemon mux: %v", err)
	}
	defer func() { _ = direct.Close(websocket.StatusNormalClosure, "test done") }()
	local := scriptedExchange(t, direct)

	h := newHarness(t, localDaemonMux(t, argv), nil)
	hosted := scriptedExchange(t, h.mustDial(t, h.ticket(t)))

	if !reflect.DeepEqual(local.frames, hosted.frames) {
		t.Fatalf("frame sequence differs:\n  local  %v\n  hosted %v", local.frames, hosted.frames)
	}
	if local.output != hosted.output {
		t.Fatalf("terminal output differs:\n  local  %q\n  hosted %q", local.output, hosted.output)
	}
	if !strings.Contains(hosted.output, "MUXOK") {
		t.Fatalf("hosted transcript did not carry the pane's output: %q", hosted.output)
	}
	for _, want := range []string{"terminal/opened", "system/pong", "terminal/exited"} {
		if !containsFrame(hosted.frames, want) {
			t.Fatalf("hosted transcript is missing %s: %v", want, hosted.frames)
		}
	}
}

func containsFrame(frames []string, want string) bool {
	for _, frame := range frames {
		if frame == want {
			return true
		}
	}
	return false
}
