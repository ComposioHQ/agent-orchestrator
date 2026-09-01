package persistenthost

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
)

func TestACPRelayReclaimsPromptAcrossAttachment(t *testing.T) {
	relay := newTestACPRelay(t)

	providerInit := relayClientFrame(t, relay, []byte(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`+"\n"), 1)
	initID := frameID(t, providerInit)
	clientInit, journaled := relayProviderFrame(t, relay, []byte(`{"jsonrpc":"2.0","id":`+initID+`,"result":{"protocolVersion":1,"agentCapabilities":{},"agentInfo":{"name":"fake","version":"1"}}}`+"\n"), 1, true)
	if journaled || frameID(t, clientInit) != "1" {
		t.Fatalf("initialize relay = journaled:%v frame:%s", journaled, clientInit)
	}

	providerSession := relayClientFrame(t, relay, []byte(`{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}`+"\n"), 1)
	sessionID := frameID(t, providerSession)
	relayProviderFrame(t, relay, []byte(`{"jsonrpc":"2.0","id":`+sessionID+`,"result":{"sessionId":"session-live"}}`+"\n"), 1, true)

	providerPrompt := relayClientFrame(t, relay, []byte(`{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"session-live","prompt":[]}}`+"\n"), 1)
	promptID := frameID(t, providerPrompt)

	update, journaled := relayProviderFrame(t, relay, []byte(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-live","update":{"agent_message_chunk":{"content":{"type":"text","text":"survived"}}}}}`+"\n"), 1, true)
	if !journaled || !strings.Contains(string(update), ACPEventIDMetaKey) {
		t.Fatalf("prompt update = journaled:%v frame:%s", journaled, update)
	}

	response, journaled := relayProviderFrame(t, relay, []byte(`{"jsonrpc":"2.0","id":`+promptID+`,"result":{"stopReason":"end_turn"}}`+"\n"), 1, true)
	if !journaled || frameID(t, response) != "3" || !strings.Contains(string(response), ACPEventIDMetaKey) {
		t.Fatalf("prompt response = journaled:%v frame:%s", journaled, response)
	}

	state := relay.snapshot()
	if state.SessionID != "session-live" || state.ActivePrompt ||
		state.PendingResultEventID == "" || len(state.InitializeResult) == 0 {
		t.Fatalf("reconnect state = %+v", state)
	}
	replay := relayReplayFrames(t, relay)
	if len(replay) != 2 || !strings.Contains(string(replay[0]), "session/update") ||
		!strings.Contains(string(replay[1]), ACPPromptResultMethod) {
		t.Fatalf("replay frames = %q", replay)
	}

	// A new SDK starts its local request IDs over. The host still allocates a
	// fresh provider-side ID, so it cannot collide with the old prompt.
	providerNext := relayClientFrame(t, relay, []byte(`{"jsonrpc":"2.0","id":1,"method":"session/set_mode","params":{}}`+"\n"), 2)
	if nextID := frameID(t, providerNext); nextID == "1" || nextID == promptID {
		t.Fatalf("replacement request reused provider id %s", nextID)
	}

	if frame := relayClientFrame(t, relay, []byte(`{"jsonrpc":"2.0","method":"_ao/persistent_prompt_ack","params":{"eventId":"wrong"}}`+"\n"), 2); len(frame) != 0 {
		t.Fatalf("private ack leaked to provider: %s", frame)
	}
	if replay := relayReplayFrames(t, relay); len(replay) != 2 {
		t.Fatalf("mismatched ack discarded %d replay frames", len(replay))
	}
	ack, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "method": ACPPromptAckMethod,
		"params": map[string]string{"eventId": state.PendingResultEventID},
	})
	if frame := relayClientFrame(t, relay, append(ack, '\n'), 2); len(frame) != 0 {
		t.Fatalf("private ack leaked to provider: %s", frame)
	}
	if replay := relayReplayFrames(t, relay); len(replay) != 0 {
		t.Fatalf("acknowledged replay retained %d frames", len(replay))
	}
}

func TestACPRelayGivesReplayedProviderRequestStableIdentity(t *testing.T) {
	relay := newTestACPRelay(t)
	frame := []byte(`{"jsonrpc":"2.0","id":"permission-7","method":"session/request_permission","params":{"sessionId":"s","options":[]}}` + "\n")
	first, _ := relayProviderFrame(t, relay, frame, 1, true)
	second, _ := relayProviderFrame(t, relay, frame, 2, true)
	firstID := frameMetaString(t, first, ACPRequestIDMetaKey)
	secondID := frameMetaString(t, second, ACPRequestIDMetaKey)
	if firstID == "" || firstID != secondID {
		t.Fatalf("stable request identities = %q, %q", firstID, secondID)
	}
	relayClientFrame(t, relay, []byte(`{"jsonrpc":"2.0","id":"permission-7","result":{"outcome":"cancelled"}}`+"\n"), 2)
	third, _ := relayProviderFrame(t, relay, frame, 2, true)
	thirdID := frameMetaString(t, third, ACPRequestIDMetaKey)
	if thirdID == firstID {
		t.Fatalf("reused provider wire id retained completed interaction identity %q", thirdID)
	}
}

func TestACPRelayRewritesClientCancellationToProviderRequestID(t *testing.T) {
	relay := newTestACPRelay(t)
	relayClientFrame(t, relay, []byte(`{"jsonrpc":"2.0","id":99,"method":"initialize","params":{}}`+"\n"), 7)
	request := relayClientFrame(t, relay, []byte(`{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{}}`+"\n"), 7)
	providerID := frameID(t, request)
	cancel := relayClientFrame(t, relay, []byte(`{"jsonrpc":"2.0","method":"$/cancel_request","params":{"requestId":1}}`+"\n"), 7)
	var envelope struct {
		Params struct {
			RequestID json.RawMessage `json:"requestId"`
		} `json:"params"`
	}
	if err := json.Unmarshal(cancel, &envelope); err != nil {
		t.Fatal(err)
	}
	if string(envelope.Params.RequestID) != providerID {
		t.Fatalf("cancel target = %s, want provider id %s", envelope.Params.RequestID, providerID)
	}
}

func TestACPRelayDeduplicatesSessionCancelAcrossAttachments(t *testing.T) {
	relay := newTestACPRelay(t)
	prompt := relayClientFrame(t, relay,
		[]byte(`{"jsonrpc":"2.0","id":1,"method":"session/prompt","params":{}}`+"\n"), 1)
	cancel := []byte(`{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s"}}` + "\n")
	if frame := relayClientFrame(t, relay, cancel, 1); len(frame) == 0 {
		t.Fatal("first session/cancel was suppressed")
	}
	if frame := relayClientFrame(t, relay, cancel, 2); len(frame) != 0 {
		t.Fatalf("duplicate session/cancel crossed attachment boundary: %s", frame)
	}

	relayProviderFrame(t, relay, []byte(`{"jsonrpc":"2.0","id":`+frameID(t, prompt)+`,"result":{"stopReason":"cancelled"}}`+"\n"), 2, true)
	relayClientFrame(t, relay,
		[]byte(`{"jsonrpc":"2.0","id":2,"method":"session/prompt","params":{}}`+"\n"), 2)
	if frame := relayClientFrame(t, relay, cancel, 2); len(frame) == 0 {
		t.Fatal("new prompt inherited prior cancellation")
	}
}

func newTestACPRelay(t *testing.T) *acpRelay {
	t.Helper()
	relay, err := newACPRelay(context.Background(), filepath.Join(t.TempDir(), "prompt.journal"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(relay.close)
	return relay
}

func relayReplayFrames(t *testing.T, relay *acpRelay) [][]byte {
	t.Helper()
	var replay bytes.Buffer
	if err := relay.replayTo(context.Background(), &replay); err != nil {
		t.Fatal(err)
	}
	lines := bytes.SplitAfter(replay.Bytes(), []byte{'\n'})
	frames := make([][]byte, 0, len(lines))
	for _, line := range lines {
		if len(line) > 0 {
			frames = append(frames, append([]byte(nil), line...))
		}
	}
	return frames
}

func relayClientFrame(t *testing.T, relay *acpRelay, frame []byte, generation uint64) []byte {
	t.Helper()
	rewritten, err := relay.clientFrame(context.Background(), frame, generation)
	if err != nil {
		t.Fatal(err)
	}
	return rewritten
}

func relayProviderFrame(
	t *testing.T,
	relay *acpRelay,
	frame []byte,
	generation uint64,
	attached bool,
) ([]byte, bool) {
	t.Helper()
	rewritten, journaled, err := relay.providerFrame(context.Background(), frame, generation, attached)
	if err != nil {
		t.Fatal(err)
	}
	return rewritten, journaled
}

func frameID(t *testing.T, frame []byte) string {
	t.Helper()
	var envelope struct {
		ID json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal(frame, &envelope); err != nil {
		t.Fatalf("decode frame %q: %v", frame, err)
	}
	return string(envelope.ID)
}

func frameMetaString(t *testing.T, frame []byte, key string) string {
	t.Helper()
	var envelope struct {
		Params struct {
			Meta map[string]any `json:"_meta"`
		} `json:"params"`
	}
	if err := json.Unmarshal(frame, &envelope); err != nil {
		t.Fatalf("decode frame %q: %v", frame, err)
	}
	value, _ := envelope.Params.Meta[key].(string)
	return value
}
