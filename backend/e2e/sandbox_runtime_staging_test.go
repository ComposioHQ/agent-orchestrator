package e2e

import (
	"context"
	"encoding/base64"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/aoagents/agent-orchestrator/backend/internal/terminal/muxproto"
)

// TestSandboxRuntimeStaging is opt-in because its ticket is single-use and it
// drives a real cloud PTY. See docs/cloud-sandbox-runtime.md.
func TestSandboxRuntimeStaging(t *testing.T) {
	baseURL := os.Getenv("AO_SANDBOX_URL")
	ticket := os.Getenv("AO_SANDBOX_TICKET")
	sessionID := os.Getenv("AO_SANDBOX_SESSION_ID")
	if baseURL == "" || ticket == "" || sessionID == "" {
		t.Skip("AO_SANDBOX_URL, AO_SANDBOX_TICKET, and AO_SANDBOX_SESSION_ID are required")
	}
	offer, err := muxproto.Offer(ticket)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	conn, response, err := websocket.Dial(ctx, strings.TrimRight(baseURL, "/")+muxproto.Path, &websocket.DialOptions{Subprotocols: offer})
	if err != nil {
		t.Fatalf("dial sandbox mux: %v (response %#v)", err, response)
	}
	defer conn.Close(websocket.StatusNormalClosure, "staging acceptance complete")
	if conn.Subprotocol() != muxproto.Subprotocol {
		t.Fatalf("selected subprotocol = %q", conn.Subprotocol())
	}
	if err := wsjson.Write(ctx, conn, muxproto.ClientFrame{
		Channel: muxproto.ChannelTerminal, ID: sessionID, Type: muxproto.TypeOpen,
		Rows: 30, Cols: 100,
	}); err != nil {
		t.Fatal(err)
	}
	marker := "AO_SANDBOX_E2E_" + time.Now().UTC().Format("20060102T150405.000000000")
	command := "printf '" + marker + "\\n'\n"
	if err := wsjson.Write(ctx, conn, muxproto.ClientFrame{
		Channel: muxproto.ChannelTerminal, ID: sessionID, Type: muxproto.TypeData,
		Data: base64.StdEncoding.EncodeToString([]byte(command)),
	}); err != nil {
		t.Fatal(err)
	}
	for {
		var frame muxproto.ServerFrame
		if err := wsjson.Read(ctx, conn, &frame); err != nil {
			t.Fatal(err)
		}
		if frame.Channel != muxproto.ChannelTerminal || frame.Type != muxproto.TypeData {
			continue
		}
		data, err := base64.StdEncoding.DecodeString(frame.Data)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(data), marker) {
			return
		}
	}
}
