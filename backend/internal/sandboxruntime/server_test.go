package sandboxruntime

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/terminal/muxproto"
)

type fixedObserver struct{}

func (fixedObserver) ObserveWorkspace(context.Context, ports.WorkspaceInfo) (ports.WorkspaceObservation, error) {
	return ports.WorkspaceObservation{Path: "/workspace", Branch: "main", HeadSHA: "abc", Dirty: true}, nil
}

func TestMuxTicketIsConsumedAndReplayRejected(t *testing.T) {
	target := testTarget()
	redeemer := &fakeRedeemer{grants: map[string]TicketGrant{"once": grantFor(target, ScopeTerminalRead, ScopeTerminalOperate)}}
	server, pty := testServer(t, target, redeemer)
	httpServer := httptest.NewServer(server.http.Handler)
	defer httpServer.Close()
	defer pty.stop()

	offer, err := muxproto.Offer("once")
	if err != nil {
		t.Fatal(err)
	}
	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + muxproto.Path
	conn, response, err := websocket.Dial(context.Background(), wsURL, &websocket.DialOptions{Subprotocols: offer})
	if err != nil {
		t.Fatalf("first dial: %v (response %#v)", err, response)
	}
	_ = conn.Close(websocket.StatusNormalClosure, "test")
	conn, response, err = websocket.Dial(context.Background(), wsURL, &websocket.DialOptions{Subprotocols: offer})
	if err == nil {
		_ = conn.CloseNow()
		t.Fatal("replayed ticket was accepted")
	}
	if response == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("replay status = %#v, want 401", response)
	}
}

func TestMuxRejectsEveryNonEmptyOriginBeforeRedemption(t *testing.T) {
	target := testTarget()
	redeemer := &fakeRedeemer{grants: map[string]TicketGrant{"unused": grantFor(target, ScopeTerminalRead)}}
	server, pty := testServer(t, target, redeemer)
	httpServer := httptest.NewServer(server.http.Handler)
	defer httpServer.Close()
	defer pty.stop()
	offer, _ := muxproto.Offer("unused")
	wsURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + muxproto.Path
	for _, origin := range []string{"https://evil.example", httpServer.URL} {
		header := http.Header{"Origin": []string{origin}}
		conn, response, err := websocket.Dial(context.Background(), wsURL, &websocket.DialOptions{Subprotocols: offer, HTTPHeader: header})
		if err == nil {
			_ = conn.CloseNow()
			t.Fatalf("origin %q was accepted", origin)
		}
		if response == nil || response.StatusCode != http.StatusForbidden {
			t.Fatalf("origin %q status = %#v", origin, response)
		}
	}
	if redeemer.calls != 0 {
		t.Fatalf("origin rejection consumed %d tickets", redeemer.calls)
	}
}

func TestMuxRejectsBearerFallback(t *testing.T) {
	target := testTarget()
	redeemer := &fakeRedeemer{grants: map[string]TicketGrant{"ticket": grantFor(target, ScopeTerminalRead)}}
	server, pty := testServer(t, target, redeemer)
	httpServer := httptest.NewServer(server.http.Handler)
	defer httpServer.Close()
	defer pty.stop()
	req, err := http.NewRequest(http.MethodGet, httpServer.URL+muxproto.Path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer ticket")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", response.StatusCode)
	}
	if redeemer.calls != 0 {
		t.Fatalf("bearer fallback reached redeemer %d times", redeemer.calls)
	}
}

func TestWorkspaceObservationRequiresScopedConsumedTicket(t *testing.T) {
	target := testTarget()
	redeemer := &fakeRedeemer{grants: map[string]TicketGrant{
		"observe":  grantFor(target, ScopeWorkspaceObserve),
		"terminal": grantFor(target, ScopeTerminalRead),
	}}
	server, pty := testServer(t, target, redeemer)
	server.cfg.Observer = fixedObserver{}
	httpServer := httptest.NewServer(server.http.Handler)
	defer httpServer.Close()
	defer pty.stop()
	endpoint := httpServer.URL + DefaultRoutePrefix + WorkspaceObservationPath

	request := func(ticket string) *http.Response {
		t.Helper()
		req, err := http.NewRequest(http.MethodGet, endpoint, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("X-AO-Ticket", ticket)
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	response := request("terminal")
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong scope status = %d", response.StatusCode)
	}
	response = request("observe")
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		t.Fatalf("observation status = %d", response.StatusCode)
	}
	var observation workspaceObservationResponse
	if err := json.NewDecoder(response.Body).Decode(&observation); err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if observation.HeadSHA != "abc" || !observation.Dirty {
		t.Fatalf("observation = %#v", observation)
	}
	response = request("observe")
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("replay status = %d", response.StatusCode)
	}
}

func TestServerReadinessAndShutdown(t *testing.T) {
	target := testTarget()
	server, pty := testServer(t, target, &fakeRedeemer{grants: map[string]TicketGrant{}})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()
	response, err := http.Get("http://" + listener.Addr().String() + "/readyz")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("ready status = %d", response.StatusCode)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-serveErr; err != nil {
		t.Fatal(err)
	}
	pty.mu.Lock()
	terminated := pty.terminated
	pty.mu.Unlock()
	if !terminated {
		t.Fatal("shutdown did not terminate PTY")
	}
}

func testTarget() TicketGrant {
	return TicketGrant{SandboxID: "sandbox-1", WorkspaceID: "workspace-1", SessionID: "session-1"}
}

func grantFor(target TicketGrant, scopes ...string) TicketGrant {
	target.Scopes = scopes
	target.ExpiresAt = time.Now().Add(time.Minute)
	return target
}

func testServer(t *testing.T, target TicketGrant, redeemer ControlPlaneRedeemer) (*Server, *fakePTY) {
	t.Helper()
	pty := newFakePTY()
	mux := NewPTYMux(pty, target.SessionID)
	server, err := NewServer(ServerConfig{
		Target: target, WorkspaceDir: t.TempDir(), Redeemer: redeemer, Mux: mux,
	})
	if err != nil {
		t.Fatal(err)
	}
	server.ready.Store(true)
	return server, pty
}
