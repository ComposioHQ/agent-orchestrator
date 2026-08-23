package sandboxruntime

import (
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/terminal/muxproto"
)

func TestPTYMuxUsesLocalFrameContractAndDirectPTY(t *testing.T) {
	pty := newFakePTY()
	mux := NewPTYMux(pty, "session-1")
	client, remove := mux.AddClient(true)
	defer remove()
	mux.Handle(client, muxproto.ClientFrame{
		Channel: muxproto.ChannelTerminal, ID: "session-1", Type: muxproto.TypeOpen,
		Rows: 30, Cols: 100,
	})
	resized := recvFrame(t, client)
	if resized.Type != muxproto.TypeResize || resized.Rows != 30 || resized.Cols != 100 {
		t.Fatalf("initial resize = %#v", resized)
	}
	opened := recvFrame(t, client)
	if opened.Channel != "terminal" || opened.Type != "opened" || opened.ID != "session-1" {
		t.Fatalf("opened = %#v", opened)
	}

	mux.Handle(client, muxproto.ClientFrame{
		Channel: muxproto.ChannelTerminal, ID: "session-1", Type: muxproto.TypeData,
		Data: base64.StdEncoding.EncodeToString([]byte("hello")),
	})
	pty.readCh <- []byte{0, 1, 2, 255}
	data := recvFrame(t, client)
	if data.Type != "data" || data.Data != "AAEC/w==" {
		t.Fatalf("data = %#v", data)
	}
	pty.mu.Lock()
	defer pty.mu.Unlock()
	if string(pty.writes) != "hello" {
		t.Fatalf("PTY input = %q", pty.writes)
	}
	if len(pty.resizes) != 1 || pty.resizes[0] != [2]uint16{30, 100} {
		t.Fatalf("PTY resizes = %v", pty.resizes)
	}
}

func TestPTYMuxMatchesPrimarySecondaryGridArbitration(t *testing.T) {
	pty := newFakePTY()
	mux := NewPTYMux(pty, "session-1")
	primary, removePrimary := mux.AddClient(true)
	secondary, removeSecondary := mux.AddClient(true)
	defer removeSecondary()

	mux.Handle(primary, muxproto.ClientFrame{
		Channel: muxproto.ChannelTerminal, ID: "session-1", Type: muxproto.TypeOpen,
		Rows: 40, Cols: 120,
	})
	assertResize(t, recvFrame(t, primary), 40, 120)
	if opened := recvFrame(t, primary); opened.Type != muxproto.TypeOpened {
		t.Fatalf("primary opened = %#v", opened)
	}

	mux.Handle(secondary, muxproto.ClientFrame{
		Channel: muxproto.ChannelTerminal, ID: "session-1", Type: muxproto.TypeOpen,
		Rows: 48, Cols: 55, Role: muxproto.RoleSecondary,
	})
	assertResize(t, recvFrame(t, secondary), 40, 120)
	if opened := recvFrame(t, secondary); opened.Type != muxproto.TypeOpened {
		t.Fatalf("secondary opened = %#v", opened)
	}

	pty.mu.Lock()
	initialResizeCount := len(pty.resizes)
	pty.mu.Unlock()
	mux.Handle(secondary, muxproto.ClientFrame{
		Channel: muxproto.ChannelTerminal, ID: "session-1", Type: muxproto.TypeResize,
		Rows: 50, Cols: 60,
	})
	assertNoFrame(t, primary)
	assertNoFrame(t, secondary)
	pty.mu.Lock()
	if got := len(pty.resizes); got != initialResizeCount {
		pty.mu.Unlock()
		t.Fatalf("secondary resize changed PTY %d times, want %d", got, initialResizeCount)
	}
	pty.mu.Unlock()

	removePrimary()
	assertResize(t, recvFrame(t, secondary), 50, 60)
	pty.mu.Lock()
	if got := pty.resizes[len(pty.resizes)-1]; got != [2]uint16{50, 60} {
		pty.mu.Unlock()
		t.Fatalf("fallback PTY resize = %v, want [50 60]", got)
	}
	pty.mu.Unlock()

	pty.mu.Lock()
	beforeForce := len(pty.resizes)
	pty.mu.Unlock()
	mux.Handle(secondary, muxproto.ClientFrame{
		Channel: muxproto.ChannelTerminal, ID: "session-1", Type: muxproto.TypeResize,
		Rows: 50, Cols: 60, Force: true,
	})
	assertNoFrame(t, secondary)
	pty.mu.Lock()
	if got := len(pty.resizes); got != beforeForce+1 {
		pty.mu.Unlock()
		t.Fatalf("forced resize count = %d, want %d", got, beforeForce+1)
	}
	pty.mu.Unlock()
}

func TestPTYMuxReadScopeCannotOperate(t *testing.T) {
	pty := newFakePTY()
	mux := NewPTYMux(pty, "session-1")
	client, remove := mux.AddClient(false)
	defer remove()
	mux.Handle(client, muxproto.ClientFrame{Channel: "terminal", ID: "session-1", Type: "open"})
	_ = recvFrame(t, client)
	mux.Handle(client, muxproto.ClientFrame{Channel: "terminal", ID: "session-1", Type: "data", Data: "eA=="})
	frame := recvFrame(t, client)
	if frame.Type != "error" {
		t.Fatalf("read-only input response = %#v", frame)
	}
	pty.mu.Lock()
	defer pty.mu.Unlock()
	if len(pty.writes) != 0 {
		t.Fatalf("read-only ticket wrote %q", pty.writes)
	}
}

func TestMuxprotoFrameJSONMatchesLocalProtocol(t *testing.T) {
	raw, err := json.Marshal(muxproto.ClientFrame{Channel: "terminal", ID: "t1", Type: "resize", Cols: 120, Rows: 40, Force: true, Role: "secondary"})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"ch":"terminal","id":"t1","type":"resize","cols":120,"rows":40,"force":true,"role":"secondary"}`
	if string(raw) != want {
		t.Fatalf("frame JSON = %s, want %s", raw, want)
	}
}

func recvFrame(t *testing.T, client *muxClient) muxproto.ServerFrame {
	t.Helper()
	select {
	case frame := <-client.out:
		return frame
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for mux frame")
		return muxproto.ServerFrame{}
	}
}

func assertResize(t *testing.T, frame muxproto.ServerFrame, rows, cols uint16) {
	t.Helper()
	if frame.Type != muxproto.TypeResize || frame.Rows != rows || frame.Cols != cols {
		t.Fatalf("resize = %#v, want %dx%d", frame, cols, rows)
	}
}

func assertNoFrame(t *testing.T, client *muxClient) {
	t.Helper()
	select {
	case frame := <-client.out:
		t.Fatalf("unexpected mux frame: %#v", frame)
	case <-time.After(25 * time.Millisecond):
	}
}
