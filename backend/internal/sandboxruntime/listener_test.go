package sandboxruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/terminal"
	"github.com/aoagents/agent-orchestrator/backend/internal/terminal/muxproto"
)

type fakeObservation struct {
	mu          sync.Mutex
	calls       []string
	sessionIDs  []domain.SessionID
	events      chan ports.WorkspaceEvent
	invalidated domain.SessionID
}

func (f *fakeObservation) record(call string, id domain.SessionID) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
	if id != "" {
		f.sessionIDs = append(f.sessionIDs, id)
	}
}

func (f *fakeObservation) Snapshot(_ context.Context, info ports.WorkspaceInfo) (ports.WorkspaceSnapshot, error) {
	f.record("snapshot", "")
	return ports.WorkspaceSnapshot{Path: info.Path, HeadSHA: "abc123"}, nil
}
func (f *fakeObservation) ListWorkspaceFiles(_ context.Context, id domain.SessionID) (ports.WorkspaceFiles, error) {
	f.record("list", id)
	return ports.WorkspaceFiles{SessionID: id, Files: []ports.WorkspaceFileSummary{{Path: "README.md"}}}, nil
}
func (f *fakeObservation) ReadWorkspaceFile(_ context.Context, id domain.SessionID, path string) (ports.WorkspaceFile, error) {
	f.record("file:"+path, id)
	return ports.WorkspaceFile{SessionID: id, Path: path, Content: "hello", Diff: "diff"}, nil
}
func (f *fakeObservation) ReadWorkspaceBlob(_ context.Context, id domain.SessionID, path string, side ports.WorkspaceBlobSide) (ports.WorkspaceBlob, error) {
	f.record("blob:"+path+":"+string(side), id)
	return ports.WorkspaceBlob{Path: path, Side: side, MediaType: "image/png", Data: []byte("png")}, nil
}
func (f *fakeObservation) WatchWorkspace(_ context.Context, id domain.SessionID) (<-chan ports.WorkspaceEvent, error) {
	f.record("watch", id)
	return f.events, nil
}
func (f *fakeObservation) ReadPreviewFile(_ context.Context, id domain.SessionID, path string) (ports.PreviewFile, error) {
	f.record("preview:"+path, id)
	return ports.PreviewFile{Path: path, Name: "index.html", Data: []byte("<h1>AO</h1>"), Size: 11}, nil
}
func (f *fakeObservation) DiscoverPreview(_ context.Context, id domain.SessionID) (string, bool, error) {
	f.record("discover", id)
	return "dist/index.html", true, nil
}
func (f *fakeObservation) InvalidateWorkspace(id domain.SessionID) {
	f.record("invalidate", id)
	f.invalidated = id
}

type fakeRuntime struct {
	mu    sync.Mutex
	calls []string
}

func (f *fakeRuntime) record(call string) {
	f.mu.Lock()
	f.calls = append(f.calls, call)
	f.mu.Unlock()
}
func (f *fakeRuntime) Create(_ context.Context, cfg ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	f.record("create:" + string(cfg.SessionID))
	return ports.RuntimeHandle{ID: "runtime-1"}, nil
}
func (f *fakeRuntime) Restart(_ context.Context, handle ports.RuntimeHandle, _ ports.RuntimeConfig) (ports.RuntimeHandle, error) {
	f.record("restart:" + handle.ID)
	return handle, nil
}
func (f *fakeRuntime) Destroy(_ context.Context, handle ports.RuntimeHandle) error {
	f.record("destroy:" + handle.ID)
	return nil
}
func (f *fakeRuntime) GetOutput(_ context.Context, handle ports.RuntimeHandle, lines int) (string, error) {
	f.record("output:" + handle.ID)
	return "last " + string(rune('0'+lines)), nil
}
func (f *fakeRuntime) IsAlive(_ context.Context, handle ports.RuntimeHandle) (bool, error) {
	f.record("alive:" + handle.ID)
	return true, nil
}

type atomicTickets struct {
	mu       sync.Mutex
	issued   map[string]Operation
	consumed map[string]bool
}

func newAtomicTickets() *atomicTickets {
	return &atomicTickets{issued: map[string]Operation{}, consumed: map[string]bool{}}
}
func (t *atomicTickets) issue(token string, operation Operation) {
	t.mu.Lock()
	t.issued[token] = operation
	t.mu.Unlock()
}
func (t *atomicTickets) Consume(_ context.Context, token string, operation Operation) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.issued[token] != operation || t.consumed[token] {
		return ErrTicketRejected
	}
	t.consumed[token] = true
	return nil
}

type fakeMux struct{ served atomic.Int32 }

func (m *fakeMux) Serve(_ context.Context, conn terminal.WSConn) {
	m.served.Add(1)
	_ = conn.Close("done")
}

type listenerFixture struct {
	tickets     *atomicTickets
	observation *fakeObservation
	runtime     *fakeRuntime
	mux         *fakeMux
	listener    *Listener
	shutdown    chan struct{}
	ticketSeq   atomic.Uint64
}

func newListenerFixture(t *testing.T) *listenerFixture {
	t.Helper()
	f := &listenerFixture{
		tickets:     newAtomicTickets(),
		observation: &fakeObservation{events: make(chan ports.WorkspaceEvent, 1)},
		runtime:     &fakeRuntime{},
		mux:         &fakeMux{},
		shutdown:    make(chan struct{}),
	}
	var once sync.Once
	listener, err := NewListener(ListenerOptions{
		Observation: f.observation,
		Runtime:     f.runtime,
		Mux:         f.mux,
		Tickets:     f.tickets,
		SessionID:   "session-1",
		Shutdown:    func() { once.Do(func() { close(f.shutdown) }) },
	})
	if err != nil {
		t.Fatal(err)
	}
	f.listener = listener
	return f
}

func authenticatedRequest(t *testing.T, f *listenerFixture, method, target string, operation Operation, body any) *httptest.ResponseRecorder {
	t.Helper()
	token := fmt.Sprintf("ticket-%s-%d", strings.ReplaceAll(string(operation), ".", "-"), f.ticketSeq.Add(1))
	f.tickets.issue(token, operation)
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	req := httptest.NewRequest(method, target, reader)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	f.listener.ServeHTTP(w, req)
	return w
}

func TestListenerWorkspaceObservationConformance(t *testing.T) {
	f := newListenerFixture(t)

	tests := []struct {
		method    string
		target    string
		operation Operation
		body      any
		status    int
	}{
		{http.MethodPost, RouteSnapshot, OperationSnapshot, ports.WorkspaceInfo{Path: "/workspace"}, http.StatusOK},
		{http.MethodGet, RouteWorkspaceFiles, OperationWorkspaceFiles, nil, http.StatusOK},
		{http.MethodGet, RouteWorkspaceFile + "?path=README.md", OperationWorkspaceFile, nil, http.StatusOK},
		{http.MethodGet, RouteWorkspaceBlob + "?path=logo.png&side=before", OperationWorkspaceBlob, nil, http.StatusOK},
		{http.MethodGet, RoutePreviewFile + "?path=index.html", OperationPreviewFile, nil, http.StatusOK},
		{http.MethodGet, RoutePreviewDiscover, OperationPreviewDiscover, nil, http.StatusOK},
		{http.MethodPost, RouteInvalidate, OperationInvalidate, nil, http.StatusNoContent},
	}
	for _, test := range tests {
		w := authenticatedRequest(t, f, test.method, test.target, test.operation, test.body)
		if w.Code != test.status {
			t.Errorf("%s %s status = %d, body=%s", test.method, test.target, w.Code, w.Body.String())
		}
	}

	f.observation.mu.Lock()
	defer f.observation.mu.Unlock()
	if strings.Join(f.observation.calls, ",") != "snapshot,list,file:README.md,blob:logo.png:before,preview:index.html,discover,invalidate" {
		t.Fatalf("calls = %v", f.observation.calls)
	}
	for _, id := range f.observation.sessionIDs {
		if id != "session-1" {
			t.Fatalf("operation escaped self-bound session: %q", id)
		}
	}
}

func TestListenerWorkspaceWatchStreamsConformanceEvent(t *testing.T) {
	f := newListenerFixture(t)
	server := httptest.NewServer(f.listener)
	defer server.Close()
	token := "watch-ticket"
	f.tickets.issue(token, OperationWorkspaceEvents)
	req, err := http.NewRequest(http.MethodGet, server.URL+RouteWorkspaceEvents, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)

	done := make(chan string, 1)
	go func() {
		response, requestErr := server.Client().Do(req)
		if requestErr != nil {
			done <- requestErr.Error()
			return
		}
		body, _ := io.ReadAll(response.Body)
		_ = response.Body.Close()
		done <- string(body)
	}()
	f.observation.events <- ports.WorkspaceEvent{}
	close(f.observation.events)
	select {
	case body := <-done:
		if !strings.Contains(body, "event: change\ndata: {}") {
			t.Fatalf("SSE body = %q", body)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("workspace watch did not complete")
	}
}

func TestListenerLifecycleParityAndSelfBinding(t *testing.T) {
	f := newListenerFixture(t)
	config := ports.RuntimeConfig{SessionID: "session-1", WorkspacePath: "/workspace", Argv: []string{"agent"}}
	for _, test := range []struct {
		method    string
		target    string
		operation Operation
		body      any
		status    int
	}{
		{http.MethodPost, RouteRuntimeCreate, OperationRuntimeCreate, config, http.StatusOK},
		{http.MethodPost, strings.Replace(RouteRuntimeRestart, "{runtimeId}", "runtime-1", 1), OperationRuntimeRestart, config, http.StatusOK},
		{http.MethodGet, strings.Replace(RouteRuntimeOutput, "{runtimeId}", "runtime-1", 1) + "?lines=5", OperationRuntimeOutput, nil, http.StatusOK},
		{http.MethodGet, strings.Replace(RouteRuntimeAlive, "{runtimeId}", "runtime-1", 1), OperationRuntimeAlive, nil, http.StatusOK},
		{http.MethodDelete, strings.Replace(RouteRuntimeDestroy, "{runtimeId}", "runtime-1", 1), OperationRuntimeDestroy, nil, http.StatusNoContent},
	} {
		w := authenticatedRequest(t, f, test.method, test.target, test.operation, test.body)
		if w.Code != test.status {
			t.Errorf("%s status = %d, body=%s", test.target, w.Code, w.Body.String())
		}
	}

	foreign := config
	foreign.SessionID = "another-session"
	w := authenticatedRequest(t, f, http.MethodPost, RouteRuntimeCreate, OperationRuntimeCreate, foreign)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("foreign create status = %d", w.Code)
	}
}

func TestListenerAtomicTicketReplayIsRejected(t *testing.T) {
	f := newListenerFixture(t)
	token := "one-time"
	f.tickets.issue(token, OperationWorkspaceFiles)
	request := func() int {
		req := httptest.NewRequest(http.MethodGet, RouteWorkspaceFiles, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		f.listener.ServeHTTP(w, req)
		return w.Code
	}
	if status := request(); status != http.StatusOK {
		t.Fatalf("first status = %d", status)
	}
	if status := request(); status != http.StatusNotFound {
		t.Fatalf("replay status = %d", status)
	}
}

func TestListenerReadinessAndShutdownArePrivateAndMetadataFree(t *testing.T) {
	f := newListenerFixture(t)
	for _, target := range []string{"/readyz", RoutePrivateReady, "/unknown"} {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		w := httptest.NewRecorder()
		f.listener.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound || w.Body.Len() != 0 {
			t.Errorf("unauthenticated %s = %d %q", target, w.Code, w.Body.String())
		}
	}

	w := authenticatedRequest(t, f, http.MethodGet, RoutePrivateReady, OperationReady, nil)
	if w.Code != http.StatusOK || strings.Contains(w.Body.String(), "session") || strings.Contains(w.Body.String(), "runtime") {
		t.Fatalf("ready = %d %q", w.Code, w.Body.String())
	}
	w = authenticatedRequest(t, f, http.MethodPost, RoutePrivateShutdown, OperationShutdown, nil)
	if w.Code != http.StatusAccepted {
		t.Fatalf("shutdown = %d", w.Code)
	}
	select {
	case <-f.shutdown:
	case <-time.After(time.Second):
		t.Fatal("shutdown callback not called")
	}
}

func TestListenerMuxRejectsOriginBearerFallbackAndReplay(t *testing.T) {
	f := newListenerFixture(t)
	server := httptest.NewTLSServer(f.listener)
	defer server.Close()
	muxURL := "wss" + strings.TrimPrefix(server.URL, "https") + RouteMux

	dial := func(token string, header http.Header) (*websocket.Conn, *http.Response, error) {
		offer, err := muxproto.Offer(token)
		if err != nil {
			t.Fatal(err)
		}
		return websocket.Dial(context.Background(), muxURL, &websocket.DialOptions{
			HTTPClient:   server.Client(),
			HTTPHeader:   header,
			Subprotocols: offer,
		})
	}

	f.tickets.issue("origin-ticket", OperationMux)
	_, response, err := dial("origin-ticket", http.Header{"Origin": []string{"https://example.test"}})
	if err == nil || response == nil || response.StatusCode != http.StatusNotFound {
		t.Fatalf("origin dial err=%v response=%v", err, response)
	}

	f.tickets.issue("bearer-ticket", OperationMux)
	_, response, err = dial("bearer-ticket", http.Header{"Authorization": []string{"Bearer fallback"}})
	if err == nil || response == nil || response.StatusCode != http.StatusNotFound {
		t.Fatalf("bearer dial err=%v response=%v", err, response)
	}

	f.tickets.issue("mux-ticket", OperationMux)
	conn, response, err := dial("mux-ticket", nil)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusSwitchingProtocols || conn.Subprotocol() != muxproto.Subprotocol {
		t.Fatalf("mux response=%d subprotocol=%q", response.StatusCode, conn.Subprotocol())
	}
	_ = conn.CloseNow()

	_, response, err = dial("mux-ticket", nil)
	if err == nil || response == nil || response.StatusCode != http.StatusNotFound {
		t.Fatalf("mux replay err=%v response=%v", err, response)
	}
	if f.mux.served.Load() != 1 {
		t.Fatalf("mux served = %d", f.mux.served.Load())
	}
}

func TestListenerMuxRequiresNormalTLSVerification(t *testing.T) {
	f := newListenerFixture(t)
	server := httptest.NewTLSServer(f.listener)
	defer server.Close()
	f.tickets.issue("tls-ticket", OperationMux)
	offer, err := muxproto.Offer("tls-ticket")
	if err != nil {
		t.Fatal(err)
	}
	muxURL := (&url.URL{Scheme: "wss", Host: strings.TrimPrefix(server.URL, "https://"), Path: RouteMux}).String()
	if _, _, err := websocket.Dial(context.Background(), muxURL, &websocket.DialOptions{Subprotocols: offer}); err == nil {
		t.Fatal("mux client trusted an unknown TLS certificate")
	}
}
