package sandboxruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/terminal"
	"github.com/aoagents/agent-orchestrator/backend/internal/terminal/muxproto"
)

const (
	// DefaultRoutePrefix is the non-secret launch contract shared with the
	// compute provider. It identifies ao-sandbox's private authenticated RPC
	// surface; the control plane itself never mounts these routes.
	DefaultRoutePrefix = "/api/sandbox/v1"
	RPCPrefix          = DefaultRoutePrefix

	RouteSnapshot        = RPCPrefix + "/workspace/snapshot"
	RouteWorkspaceFiles  = RPCPrefix + "/workspace/files"
	RouteWorkspaceFile   = RPCPrefix + "/workspace/file"
	RouteWorkspaceBlob   = RPCPrefix + "/workspace/blob"
	RouteWorkspaceEvents = RPCPrefix + "/workspace/events"
	RoutePreviewFile     = RPCPrefix + "/workspace/preview/file"
	RoutePreviewDiscover = RPCPrefix + "/workspace/preview/discover"
	RouteInvalidate      = RPCPrefix + "/workspace/invalidate"

	RouteRuntimeCreate  = RPCPrefix + "/runtime"
	RouteRuntimeRestart = RPCPrefix + "/runtime/{runtimeId}/restart"
	RouteRuntimeDestroy = RPCPrefix + "/runtime/{runtimeId}"
	RouteRuntimeOutput  = RPCPrefix + "/runtime/{runtimeId}/output"
	RouteRuntimeAlive   = RPCPrefix + "/runtime/{runtimeId}/alive"

	RoutePrivateReady    = "/private/ready"
	RoutePrivateShutdown = "/private/shutdown"
	RouteMux             = "/mux"
)

type Operation string

const (
	OperationSnapshot        Operation = "workspace.snapshot"
	OperationWorkspaceFiles  Operation = "workspace.files.list"
	OperationWorkspaceFile   Operation = "workspace.file.read"
	OperationWorkspaceBlob   Operation = "workspace.blob.read"
	OperationWorkspaceEvents Operation = "workspace.events.watch"
	OperationPreviewFile     Operation = "workspace.preview.read"
	OperationPreviewDiscover Operation = "workspace.preview.discover"
	OperationInvalidate      Operation = "workspace.invalidate"
	OperationRuntimeCreate   Operation = "runtime.create"
	OperationRuntimeRestart  Operation = "runtime.restart"
	OperationRuntimeDestroy  Operation = "runtime.destroy"
	OperationRuntimeOutput   Operation = "runtime.output"
	OperationRuntimeAlive    Operation = "runtime.alive"
	OperationReady           Operation = "control.ready"
	OperationShutdown        Operation = "control.shutdown"
	OperationMux             Operation = "terminal.mux"
)

var ErrTicketRejected = errors.New("sandbox connection ticket rejected")

// TicketConsumer validates and atomically consumes a control-plane-issued
// connection ticket. The listener deliberately has no replay map: the durable
// control plane is the sole consume authority, so reconnects and multiple
// listener replicas cannot race through process-local state.
type TicketConsumer interface {
	Consume(ctx context.Context, ticket string, operation Operation) error
}

// Runtime is the lifecycle surface ao-sandbox exposes in addition to PTY
// attachment. The selected local runtime (tmux on Linux) satisfies it.
type Runtime interface {
	ports.Runtime
	ports.RuntimeRestarter
}

type Mux interface {
	Serve(ctx context.Context, conn terminal.WSConn)
}

type ListenerOptions struct {
	Observation ports.WorkspaceObservation
	Runtime     Runtime
	Mux         Mux
	Tickets     TicketConsumer
	SessionID   domain.SessionID
	Shutdown    context.CancelFunc
	Logger      *slog.Logger
}

// Listener is the authenticated sandbox-private HTTP surface. It contains no
// AO daemon, product store, relay, provider adapter, or local fallback.
type Listener struct {
	observation ports.WorkspaceObservation
	runtime     Runtime
	mux         Mux
	tickets     TicketConsumer
	sessionID   domain.SessionID
	shutdown    context.CancelFunc
	log         *slog.Logger
	handler     http.Handler
}

func NewListener(options ListenerOptions) (*Listener, error) {
	if options.Observation == nil || options.Runtime == nil || options.Mux == nil || options.Tickets == nil {
		return nil, errors.New("sandbox listener requires observation, runtime, mux, and ticket consumer")
	}
	if strings.TrimSpace(string(options.SessionID)) == "" {
		return nil, errors.New("sandbox listener requires a self-bound session id")
	}
	if options.Shutdown == nil {
		return nil, errors.New("sandbox listener requires a shutdown callback")
	}
	if options.Logger == nil {
		options.Logger = slog.Default()
	}
	l := &Listener{
		observation: options.Observation,
		runtime:     options.Runtime,
		mux:         options.Mux,
		tickets:     options.Tickets,
		sessionID:   options.SessionID,
		shutdown:    options.Shutdown,
		log:         options.Logger,
	}
	l.handler = l.routes()
	return l, nil
}

func (l *Listener) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// No public liveness/readiness endpoint exists. Unknown and unauthenticated
	// requests get the same metadata-free response.
	l.handler.ServeHTTP(w, r)
}

func (l *Listener) routes() http.Handler {
	r := chi.NewRouter()
	r.NotFound(metadataFreeNotFound)
	r.MethodNotAllowed(metadataFreeNotFound)

	r.With(l.authenticate(OperationSnapshot)).Post(RouteSnapshot, l.snapshot)
	r.With(l.authenticate(OperationWorkspaceFiles)).Get(RouteWorkspaceFiles, l.listWorkspaceFiles)
	r.With(l.authenticate(OperationWorkspaceFile)).Get(RouteWorkspaceFile, l.readWorkspaceFile)
	r.With(l.authenticate(OperationWorkspaceBlob)).Get(RouteWorkspaceBlob, l.readWorkspaceBlob)
	r.With(l.authenticate(OperationWorkspaceEvents)).Get(RouteWorkspaceEvents, l.watchWorkspace)
	r.With(l.authenticate(OperationPreviewFile)).Get(RoutePreviewFile, l.readPreviewFile)
	r.With(l.authenticate(OperationPreviewDiscover)).Get(RoutePreviewDiscover, l.discoverPreview)
	r.With(l.authenticate(OperationInvalidate)).Post(RouteInvalidate, l.invalidateWorkspace)

	r.With(l.authenticate(OperationRuntimeCreate)).Post(RouteRuntimeCreate, l.createRuntime)
	r.With(l.authenticate(OperationRuntimeRestart)).Post(RouteRuntimeRestart, l.restartRuntime)
	r.With(l.authenticate(OperationRuntimeDestroy)).Delete(RouteRuntimeDestroy, l.destroyRuntime)
	r.With(l.authenticate(OperationRuntimeOutput)).Get(RouteRuntimeOutput, l.runtimeOutput)
	r.With(l.authenticate(OperationRuntimeAlive)).Get(RouteRuntimeAlive, l.runtimeAlive)

	r.With(l.authenticate(OperationReady)).Get(RoutePrivateReady, l.ready)
	r.With(l.authenticate(OperationShutdown)).Post(RoutePrivateShutdown, l.stop)
	r.Get(RouteMux, l.serveMux)
	return r
}

func metadataFreeNotFound(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNotFound) }

func (l *Listener) authenticate(operation Operation) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ticket, ok := bearerTicket(r.Header.Values("Authorization"))
			if !ok || l.tickets.Consume(r.Context(), ticket, operation) != nil {
				metadataFreeNotFound(w, r)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func bearerTicket(values []string) (string, bool) {
	if len(values) != 1 {
		return "", false
	}
	value := values[0]
	if !strings.HasPrefix(value, "Bearer ") {
		return "", false
	}
	ticket := strings.TrimPrefix(value, "Bearer ")
	if ticket == "" || strings.TrimSpace(ticket) != ticket || strings.ContainsAny(ticket, "\r\n") {
		return "", false
	}
	return ticket, true
}

func (l *Listener) snapshot(w http.ResponseWriter, r *http.Request) {
	var info ports.WorkspaceInfo
	if !decodeJSON(w, r, &info) {
		return
	}
	// The configured session is authoritative. Implementations execute where
	// the workspace lives and must not interpret a control-plane path locally.
	snapshot, err := l.observation.Snapshot(r.Context(), info)
	writeResult(w, snapshot, err)
}

func (l *Listener) listWorkspaceFiles(w http.ResponseWriter, r *http.Request) {
	result, err := l.observation.ListWorkspaceFiles(r.Context(), l.sessionID)
	writeResult(w, result, err)
}

func (l *Listener) readWorkspaceFile(w http.ResponseWriter, r *http.Request) {
	path, ok := requiredQuery(w, r, "path")
	if !ok {
		return
	}
	result, err := l.observation.ReadWorkspaceFile(r.Context(), l.sessionID, path)
	writeResult(w, result, err)
}

func (l *Listener) readWorkspaceBlob(w http.ResponseWriter, r *http.Request) {
	path, ok := requiredQuery(w, r, "path")
	if !ok {
		return
	}
	side := ports.WorkspaceBlobSide(r.URL.Query().Get("side"))
	if side != ports.WorkspaceBlobBefore && side != ports.WorkspaceBlobAfter {
		writeError(w, http.StatusBadRequest, "invalid blob side")
		return
	}
	result, err := l.observation.ReadWorkspaceBlob(r.Context(), l.sessionID, path, side)
	writeResult(w, result, err)
}

func (l *Listener) watchWorkspace(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "streaming unavailable")
		return
	}
	events, err := l.observation.WatchWorkspace(r.Context(), l.sessionID)
	if err != nil {
		writeError(w, http.StatusBadGateway, "workspace observation failed")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	for {
		select {
		case <-r.Context().Done():
			return
		case _, open := <-events:
			if !open {
				return
			}
			_, _ = fmt.Fprint(w, "event: change\ndata: {}\n\n")
			flusher.Flush()
		}
	}
}

func (l *Listener) readPreviewFile(w http.ResponseWriter, r *http.Request) {
	path, ok := requiredQuery(w, r, "path")
	if !ok {
		return
	}
	result, err := l.observation.ReadPreviewFile(r.Context(), l.sessionID, path)
	writeResult(w, result, err)
}

func (l *Listener) discoverPreview(w http.ResponseWriter, r *http.Request) {
	entry, found, err := l.observation.DiscoverPreview(r.Context(), l.sessionID)
	writeResult(w, struct {
		Entry string `json:"entry,omitempty"`
		Found bool   `json:"found"`
	}{Entry: entry, Found: found}, err)
}

func (l *Listener) invalidateWorkspace(w http.ResponseWriter, _ *http.Request) {
	l.observation.InvalidateWorkspace(l.sessionID)
	w.WriteHeader(http.StatusNoContent)
}

func (l *Listener) createRuntime(w http.ResponseWriter, r *http.Request) {
	var config ports.RuntimeConfig
	if !decodeJSON(w, r, &config) {
		return
	}
	if config.SessionID != l.sessionID {
		writeError(w, http.StatusBadRequest, "runtime session does not match listener")
		return
	}
	handle, err := l.runtime.Create(r.Context(), config)
	writeResult(w, handle, err)
}

func (l *Listener) restartRuntime(w http.ResponseWriter, r *http.Request) {
	var config ports.RuntimeConfig
	if !decodeJSON(w, r, &config) {
		return
	}
	if config.SessionID != l.sessionID {
		writeError(w, http.StatusBadRequest, "runtime session does not match listener")
		return
	}
	handle, err := l.runtime.Restart(r.Context(), runtimeHandle(r), config)
	writeResult(w, handle, err)
}

func (l *Listener) destroyRuntime(w http.ResponseWriter, r *http.Request) {
	if err := l.runtime.Destroy(r.Context(), runtimeHandle(r)); err != nil {
		writeError(w, http.StatusBadGateway, "runtime operation failed")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (l *Listener) runtimeOutput(w http.ResponseWriter, r *http.Request) {
	lines := 200
	if raw := r.URL.Query().Get("lines"); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 10000 {
			writeError(w, http.StatusBadRequest, "invalid line count")
			return
		}
		lines = parsed
	}
	output, err := l.runtime.GetOutput(r.Context(), runtimeHandle(r), lines)
	writeResult(w, struct {
		Output string `json:"output"`
	}{Output: output}, err)
}

func (l *Listener) runtimeAlive(w http.ResponseWriter, r *http.Request) {
	alive, err := l.runtime.IsAlive(r.Context(), runtimeHandle(r))
	writeResult(w, struct {
		Alive bool `json:"alive"`
	}{Alive: alive}, err)
}

func runtimeHandle(r *http.Request) ports.RuntimeHandle {
	return ports.RuntimeHandle{ID: chi.URLParam(r, "runtimeId")}
}

func (l *Listener) ready(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(struct {
		Ready bool `json:"ready"`
	}{Ready: true})
}

func (l *Listener) stop(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusAccepted)
	l.shutdown()
}

func (l *Listener) serveMux(w http.ResponseWriter, r *http.Request) {
	// Browser origins are never trusted on the published listener. Electron's
	// main process sends no Origin. Authorization bearer and query/cookie
	// fallbacks are explicitly rejected; the ticket subprotocol is mandatory.
	if r.Header.Get("Origin") != "" || len(r.Header.Values("Authorization")) != 0 || r.URL.RawQuery != "" {
		metadataFreeNotFound(w, r)
		return
	}
	offered := offeredSubprotocols(r.Header.Values("Sec-WebSocket-Protocol"))
	if !muxproto.Offered(offered) {
		metadataFreeNotFound(w, r)
		return
	}
	ticket, err := muxproto.Ticket(offered)
	if err != nil || l.tickets.Consume(r.Context(), ticket, OperationMux) != nil {
		metadataFreeNotFound(w, r)
		return
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{muxproto.Subprotocol}})
	if err != nil {
		l.log.Debug("sandbox mux upgrade refused", "err", err)
		return
	}
	conn.SetReadLimit(1 << 20)
	l.mux.Serve(r.Context(), &muxConn{conn: conn})
}

func offeredSubprotocols(values []string) []string {
	var protocols []string
	for _, value := range values {
		for _, protocol := range strings.Split(value, ",") {
			if protocol = strings.TrimSpace(protocol); protocol != "" {
				protocols = append(protocols, protocol)
			}
		}
	}
	return protocols
}

type muxConn struct{ conn *websocket.Conn }

func (c *muxConn) ReadJSON(ctx context.Context, value any) error {
	return wsjson.Read(ctx, c.conn, value)
}
func (c *muxConn) WriteJSON(ctx context.Context, value any) error {
	return wsjson.Write(ctx, c.conn, value)
}
func (c *muxConn) Ping(ctx context.Context) error { return c.conn.Ping(ctx) }
func (c *muxConn) Close(reason string) error {
	return c.conn.Close(websocket.StatusNormalClosure, reason)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request")
		return false
	}
	return true
}

func requiredQuery(w http.ResponseWriter, r *http.Request, name string) (string, bool) {
	value := strings.TrimSpace(r.URL.Query().Get(name))
	if value == "" {
		writeError(w, http.StatusBadRequest, name+" is required")
		return "", false
	}
	return value, true
}

func writeResult(w http.ResponseWriter, result any, err error) {
	if err != nil {
		writeError(w, http.StatusBadGateway, "sandbox operation failed")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if encodeErr := json.NewEncoder(w).Encode(result); encodeErr != nil {
		return
	}
}

func writeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(struct {
		Error string `json:"error"`
	}{Error: message})
}
