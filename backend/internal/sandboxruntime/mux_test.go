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
