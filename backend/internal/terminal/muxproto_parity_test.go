package terminal

import (
	"encoding/json"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/terminal/muxproto"
)

func TestMuxprotoFramesMatchLocalFlatJSONContract(t *testing.T) {
	localClient, err := json.Marshal(clientMsg{
		Ch: chTerminal, ID: "session-1", Type: msgResize,
		Data: "AAE=", Cols: 120, Rows: 40, Force: true, Role: roleSecondary,
	})
	if err != nil {
		t.Fatal(err)
	}
	sandboxClient, err := json.Marshal(muxproto.ClientFrame{
		Channel: muxproto.ChannelTerminal, ID: "session-1", Type: muxproto.TypeResize,
		Data: "AAE=", Cols: 120, Rows: 40, Force: true, Role: muxproto.RoleSecondary,
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(localClient) != string(sandboxClient) {
		t.Fatalf("client frames differ: local=%s sandbox=%s", localClient, sandboxClient)
	}

	localServer, err := json.Marshal(serverMsg{
		Ch: chTerminal, ID: "session-1", Type: msgData,
		Data: "AAE=", Cols: 120, Rows: 40, Error: "bounded",
	})
	if err != nil {
		t.Fatal(err)
	}
	sandboxServer, err := json.Marshal(muxproto.ServerFrame{
		Channel: muxproto.ChannelTerminal, ID: "session-1", Type: muxproto.TypeData,
		Data: "AAE=", Cols: 120, Rows: 40, Error: "bounded",
	})
	if err != nil {
		t.Fatal(err)
	}
	if string(localServer) != string(sandboxServer) {
		t.Fatalf("server frames differ: local=%s sandbox=%s", localServer, sandboxServer)
	}
}
