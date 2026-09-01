package httpapi

// PROTOTYPE (AO_CLOUD_TERMINAL_STREAM=1): persistent duplex worker<->CP
// terminal stream. The bridge below is in-process memory keyed by terminal ID,
// so it assumes a SINGLE control-plane instance — no cross-instance fan-out.
// Default off; when the flag is unset none of this code changes behavior.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"

	"github.com/aoagents/agent-orchestrator/cloud/internal/worker"
	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
)

// bridgeFrame is one persisted PTY output chunk pushed to subscribed client
// connections the moment the worker stream delivers it.
type bridgeFrame struct {
	Sequence int64
	Data     []byte
}

// bridgeWorker is one live worker stream: the channel input frames are pushed
// down, plus the session the presenting worker token was scoped to.
type bridgeWorker struct {
	sessionID string
	input     chan []byte
}

// terminalBridge is the in-memory per-terminal rendezvous between a worker's
// persistent stream socket and any connected client terminal sockets.
type terminalBridge struct {
	mu      sync.Mutex
	workers map[string]*bridgeWorker
	subs    map[string]map[chan bridgeFrame]struct{}
}

func newTerminalBridge() *terminalBridge {
	return &terminalBridge{
		workers: make(map[string]*bridgeWorker),
		subs:    make(map[string]map[chan bridgeFrame]struct{}),
	}
}

// registerWorker installs the live worker stream for a terminal, replacing any
// previous stream (last dial wins).
func (b *terminalBridge) registerWorker(terminalID, sessionID string) *bridgeWorker {
	stream := &bridgeWorker{sessionID: sessionID, input: make(chan []byte, 64)}
	b.mu.Lock()
	b.workers[terminalID] = stream
	b.mu.Unlock()
	return stream
}

func (b *terminalBridge) unregisterWorker(terminalID string, stream *bridgeWorker) {
	b.mu.Lock()
	if b.workers[terminalID] == stream {
		delete(b.workers, terminalID)
	}
	b.mu.Unlock()
}

// pushInput hands a client keystroke to the live worker stream. false means
// there is no stream for this terminal (or its pipe is full) and the caller
// must fall back to the durable Postgres queue.
func (b *terminalBridge) pushInput(sessionID, terminalID string, data []byte) bool {
	b.mu.Lock()
	stream := b.workers[terminalID]
	b.mu.Unlock()
	if stream == nil || stream.sessionID != sessionID {
		return false
	}
	select {
	case stream.input <- data:
		return true
	default:
		return false
	}
}

// subscribe registers a client terminal connection for pushed output frames.
func (b *terminalBridge) subscribe(terminalID string) (chan bridgeFrame, func()) {
	subscription := make(chan bridgeFrame, 256)
	b.mu.Lock()
	if b.subs[terminalID] == nil {
		b.subs[terminalID] = make(map[chan bridgeFrame]struct{})
	}
	b.subs[terminalID][subscription] = struct{}{}
	b.mu.Unlock()
	return subscription, func() {
		b.mu.Lock()
		delete(b.subs[terminalID], subscription)
		if len(b.subs[terminalID]) == 0 {
			delete(b.subs, terminalID)
		}
		b.mu.Unlock()
	}
}

// broadcast fans a persisted output frame out to subscribers. Sends never
// block: a slow subscriber misses pushes and catches up via the Postgres poll.
func (b *terminalBridge) broadcast(terminalID string, frame bridgeFrame) {
	b.mu.Lock()
	for subscription := range b.subs[terminalID] {
		select {
		case subscription <- frame:
		default:
		}
	}
	b.mu.Unlock()
}

// terminalStreamMessage is one frame on the duplex worker stream, in either
// direction. Data carries raw PTY bytes (base64 in JSON).
type terminalStreamMessage struct {
	Type string `json:"type"`
	Data []byte `json:"data,omitempty"`
}

// workerTerminalStream is the prototype duplex path: the worker holds one
// WebSocket per open terminal. Upstream output frames are persisted first
// (replay stays intact) and then pushed to subscribed clients; client input is
// pushed downstream, skipping both the durable request queue and the worker's
// 100ms transport claim poll.
func (s *Server) workerTerminalStream(w http.ResponseWriter, r *http.Request) {
	if !s.terminalStreamEnabled {
		writeError(w, r, http.StatusNotFound, "not_found", "Terminal streaming is not enabled.")
		return
	}
	claims := workerFrom(r)
	if !worker.HasScope(claims, "worker:transport") {
		writeError(w, r, http.StatusForbidden, "SCOPE_REQUIRED", "The worker:transport scope is required.")
		return
	}
	terminalID := chi.URLParam(r, "terminalId")
	if requireUUID(terminalID, "terminalId") != nil {
		writeError(w, r, http.StatusBadRequest, "invalid_request", "terminalId must be a UUID.")
		return
	}
	connection, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	connection.SetReadLimit(maxTerminalFrame * 2)

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	stream := s.terminalStreams.registerWorker(terminalID, claims.SessionID)
	defer s.terminalStreams.unregisterWorker(terminalID, stream)

	readResult := make(chan error, 1)
	go func() {
		readResult <- s.readWorkerTerminalStream(ctx, connection, claims, terminalID)
	}()
	writeResult := make(chan error, 1)
	go func() {
		for {
			select {
			case <-ctx.Done():
				writeResult <- ctx.Err()
				return
			case data := <-stream.input:
				frame, err := json.Marshal(terminalStreamMessage{Type: "input", Data: data})
				if err == nil {
					err = connection.Write(ctx, websocket.MessageText, frame)
				}
				if err != nil {
					writeResult <- err
					return
				}
			}
		}
	}()
	select {
	case err = <-readResult:
	case err = <-writeResult:
	}
	cancel()
	if err != nil && !errors.Is(err, context.Canceled) &&
		websocket.CloseStatus(err) == -1 && s.logger != nil {
		s.logger.Warn("worker terminal stream ended", "error", err, "terminal_id", terminalID)
	}
	_ = connection.Close(websocket.StatusNormalClosure, "stream closed")
}

func (s *Server) readWorkerTerminalStream(
	ctx context.Context,
	connection *websocket.Conn,
	claims worker.Claims,
	terminalID string,
) error {
	for {
		_, data, err := connection.Read(ctx)
		if err != nil {
			return err
		}
		var message terminalStreamMessage
		if json.Unmarshal(data, &message) != nil || message.Type != "output" {
			continue
		}
		if len(message.Data) == 0 || len(message.Data) > maxTerminalFrame {
			continue
		}
		// Persist first so replay and the poll fallback cursor stay correct;
		// the store scopes the write to this worker's org/session/epoch, so a
		// stream registered for a foreign terminal cannot write output rows.
		sequence, err := s.store.AppendTerminalOutput(
			ctx, claims.OrgID, claims.SessionID, claims.WorkerID,
			terminalID, claims.Epoch, message.Data,
		)
		if err != nil {
			return err
		}
		s.terminalStreams.broadcast(terminalID, bridgeFrame{Sequence: sequence, Data: message.Data})
	}
}
