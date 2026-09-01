package persistenthost

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
)

const (
	// ACPEventIDMetaKey identifies one replayable provider event. AO assigns the
	// value to every durable event derived from that frame.
	ACPEventIDMetaKey = "ao.persistentEventId"
)

type acpClientRequest struct {
	clientID   json.RawMessage
	method     string
	params     json.RawMessage
	generation uint64
}

// acpRelay is deliberately only a JSON-RPC correlation layer. The pinned ACP
// SDK and all provider semantics remain in the adapter; the host owns only the
// connection state that cannot be reconstructed after a daemon dies.
type acpRelay struct {
	nextRequestID     int64
	nextEventID       uint64
	nextInteractionID uint64
	pending           map[string]acpClientRequest
	serverRequests    map[string]string
	state             ACPState
	promptJournal     *acpPromptJournal
	promptResult      []byte
	cancelRequested   bool
}

func newACPRelay(ctx context.Context, journalPath string) (*acpRelay, error) {
	journal, err := openACPPromptJournal(ctx, journalPath)
	if err != nil {
		return nil, err
	}
	return &acpRelay{
		pending: make(map[string]acpClientRequest), serverRequests: make(map[string]string),
		promptJournal: journal,
	}, nil
}

func (r *acpRelay) snapshot() *ACPState {
	state := r.state
	state.InitializeResult = append(json.RawMessage(nil), state.InitializeResult...)
	state.SessionResult = append(json.RawMessage(nil), state.SessionResult...)
	return &state
}

func (r *acpRelay) replayTo(ctx context.Context, dst io.Writer) error {
	if err := r.promptJournal.replayTo(ctx, dst); err != nil {
		return err
	}
	if len(r.promptResult) > 0 {
		_, err := dst.Write(r.promptResult)
		return err
	}
	return nil
}

func (r *acpRelay) close() { r.promptJournal.close() }

func (r *acpRelay) clientFrame(ctx context.Context, frame []byte, generation uint64) ([]byte, error) {
	var envelope map[string]json.RawMessage
	if json.Unmarshal(frame, &envelope) != nil {
		return frame, nil //nolint:nilerr // preserve malformed input so the ACP peer owns its protocol error
	}
	var method string
	_ = json.Unmarshal(envelope["method"], &method)
	if method == ACPPromptAckMethod {
		var params struct {
			EventID string `json:"eventId"`
		}
		_ = json.Unmarshal(envelope["params"], &params)
		if params.EventID != "" && params.EventID == r.state.PendingResultEventID {
			if err := r.promptJournal.reset(ctx); err != nil {
				return nil, err
			}
			r.promptResult = nil
			r.state.PendingResultEventID = ""
		}
		return nil, nil
	}
	if method == "$/cancel_request" {
		return r.clientCancellation(envelope, frame, generation), nil
	}
	if method == "session/cancel" && r.state.ActivePrompt {
		if r.cancelRequested {
			return nil, nil
		}
		r.cancelRequested = true
	}
	id := envelope["id"]
	if method == "" && len(id) > 0 {
		delete(r.serverRequests, string(id))
	}
	if method == "" || len(id) == 0 || string(id) == "null" {
		return frame, nil
	}

	r.nextRequestID++
	providerID, _ := json.Marshal(r.nextRequestID)
	r.pending[string(providerID)] = acpClientRequest{
		clientID: append(json.RawMessage(nil), id...), method: method,
		params: append(json.RawMessage(nil), envelope["params"]...), generation: generation,
	}
	envelope["id"] = providerID
	if method == "session/prompt" {
		r.state.ActivePrompt = true
		r.state.PendingResultEventID = ""
		r.cancelRequested = false
		if err := r.promptJournal.reset(ctx); err != nil {
			return nil, err
		}
		r.promptResult = nil
	}
	return marshalFrame(envelope, frame), nil
}

func (r *acpRelay) clientCancellation(
	envelope map[string]json.RawMessage,
	fallback []byte,
	generation uint64,
) []byte {
	var params map[string]json.RawMessage
	if json.Unmarshal(envelope["params"], &params) != nil {
		return fallback
	}
	target := params["requestId"]
	for providerID, request := range r.pending {
		if request.generation != generation || string(request.clientID) != string(target) {
			continue
		}
		params["requestId"] = json.RawMessage(providerID)
		encoded, _ := json.Marshal(params)
		envelope["params"] = encoded
		return marshalFrame(envelope, fallback)
	}
	return fallback
}

// providerFrame returns the daemon-facing frame and whether it is retained in
// the active-prompt journal. A journaled frame must not also enter the generic
// detached buffer or it would be replayed twice.
func (r *acpRelay) providerFrame(
	ctx context.Context,
	frame []byte,
	generation uint64,
	attached bool,
) ([]byte, bool, error) {
	var envelope map[string]json.RawMessage
	if json.Unmarshal(frame, &envelope) != nil {
		return frame, false, nil //nolint:nilerr // preserve malformed output for the SDK's protocol error
	}
	var method string
	_ = json.Unmarshal(envelope["method"], &method)
	id := envelope["id"]

	if method != "" {
		if len(id) > 0 && string(id) != "null" {
			return r.providerRequest(envelope, frame), false, nil
		}
		if r.state.ActivePrompt {
			eventID := r.newEventID()
			injectMeta(envelope, ACPEventIDMetaKey, eventID)
			rewritten := marshalFrame(envelope, frame)
			if err := r.promptJournal.append(ctx, rewritten); err != nil {
				return nil, false, err
			}
			if !attached {
				return nil, true, nil
			}
			return rewritten, true, nil
		}
		return frame, false, nil
	}
	if len(id) == 0 {
		return frame, false, nil
	}

	request, ok := r.pending[string(id)]
	if !ok {
		return frame, false, nil
	}
	delete(r.pending, string(id))
	r.captureResponse(request, envelope)

	if request.method == "session/prompt" {
		r.state.ActivePrompt = false
		r.cancelRequested = false
		eventID := r.newEventID()
		injectResultMeta(envelope, ACPEventIDMetaKey, eventID)
		rewritten := rewriteResponseID(envelope, request.clientID, frame)
		r.promptResult = promptResultNotification(envelope, eventID)
		r.state.PendingResultEventID = eventID
		if !attached {
			return nil, true, nil
		}
		if request.generation != generation {
			return append([]byte(nil), r.promptResult...), true, nil
		}
		return rewritten, true, nil
	}
	if request.generation != generation || !attached {
		return nil, false, nil
	}
	return rewriteResponseID(envelope, request.clientID, frame), false, nil
}

func (r *acpRelay) providerRequest(envelope map[string]json.RawMessage, fallback []byte) []byte {
	id := envelope["id"]
	key := string(id)
	requestID := r.serverRequests[key]
	if requestID == "" {
		r.nextInteractionID++
		requestID = fmt.Sprintf("acp-request:%d", r.nextInteractionID)
		r.serverRequests[key] = requestID
	}
	injectMeta(envelope, ACPRequestIDMetaKey, requestID)
	return marshalFrame(envelope, fallback)
}

func (r *acpRelay) captureResponse(request acpClientRequest, envelope map[string]json.RawMessage) {
	if len(envelope["error"]) > 0 && string(envelope["error"]) != "null" {
		return
	}
	result := envelope["result"]
	switch request.method {
	case "initialize":
		r.state.InitializeResult = append(json.RawMessage(nil), result...)
	case "session/new", "session/load", "session/resume":
		r.state.SessionResult = append(json.RawMessage(nil), result...)
		var response struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(result, &response)
		if response.SessionID != "" {
			r.state.SessionID = response.SessionID
		} else {
			var params struct {
				SessionID string `json:"sessionId"`
			}
			_ = json.Unmarshal(request.params, &params)
			if params.SessionID != "" {
				r.state.SessionID = params.SessionID
			}
		}
	}
}

func (r *acpRelay) newEventID() string {
	r.nextEventID++
	return fmt.Sprintf("acp-host:%d", r.nextEventID)
}

func rewriteResponseID(envelope map[string]json.RawMessage, id json.RawMessage, fallback []byte) []byte {
	envelope["id"] = append(json.RawMessage(nil), id...)
	return marshalFrame(envelope, fallback)
}

func promptResultNotification(response map[string]json.RawMessage, eventID string) []byte {
	params := map[string]json.RawMessage{}
	if result := response["result"]; len(result) > 0 {
		params["result"] = result
	}
	if rpcErr := response["error"]; len(rpcErr) > 0 {
		params["error"] = rpcErr
	}
	eventJSON, _ := json.Marshal(eventID)
	params["eventId"] = eventJSON
	encodedParams, _ := json.Marshal(params)
	method, _ := json.Marshal(ACPPromptResultMethod)
	return marshalFrame(map[string]json.RawMessage{
		"jsonrpc": json.RawMessage(`"2.0"`), "method": method, "params": encodedParams,
	}, nil)
}

func injectResultMeta(envelope map[string]json.RawMessage, key, value string) {
	var result map[string]json.RawMessage
	if json.Unmarshal(envelope["result"], &result) != nil {
		return
	}
	injectRawMeta(result, key, value)
	encoded, _ := json.Marshal(result)
	envelope["result"] = encoded
}

func injectMeta(envelope map[string]json.RawMessage, key, value string) {
	var params map[string]json.RawMessage
	if json.Unmarshal(envelope["params"], &params) != nil {
		params = make(map[string]json.RawMessage)
	}
	injectRawMeta(params, key, value)
	encoded, _ := json.Marshal(params)
	envelope["params"] = encoded
}

func injectRawMeta(object map[string]json.RawMessage, key, value string) {
	var meta map[string]json.RawMessage
	if json.Unmarshal(object["_meta"], &meta) != nil {
		meta = make(map[string]json.RawMessage)
	}
	encoded, _ := json.Marshal(value)
	meta[key] = encoded
	encodedMeta, _ := json.Marshal(meta)
	object["_meta"] = encodedMeta
}

func marshalFrame(envelope map[string]json.RawMessage, fallback []byte) []byte {
	encoded, err := json.Marshal(envelope)
	if err != nil {
		return fallback
	}
	return append(encoded, '\n')
}
