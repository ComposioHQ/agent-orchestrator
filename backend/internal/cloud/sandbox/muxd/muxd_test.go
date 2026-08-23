package muxd

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox/ticket"
)

const (
	testSession = "sess-42"
	testRuntime = "rt-7"
)

func discardLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

// clock is a hand-wound clock so ticket expiry is exercised without sleeping.
type clock struct{ at time.Time }

func (c *clock) now() time.Time { return c.at }

type harness struct {
	issuer   *ticket.Issuer
	verifier *ticket.Verifier
	clock    *clock
	logs     *bytes.Buffer
	server   *httptest.Server
	// upstreamDials counts how often the listener reached for the daemon, which
	// is how the tests prove an unauthenticated caller never causes a dial.
	upstreamDials *atomic.Int64
}

// newHarness builds a listener in front of upstreamURL. A nil probe means the
// listener reports ready.
func newHarness(t *testing.T, upstreamURL string, probe Probe) *harness {
	t.Helper()
	key, err := ticket.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	c := &clock{at: time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)}
	issuer, err := ticket.NewIssuer(key, c.now, nil)
	if err != nil {
		t.Fatalf("NewIssuer: %v", err)
	}
	binding := ticket.Binding{SessionID: testSession, RuntimeID: testRuntime}
	verifier, err := ticket.NewVerifier(key, ticket.AudienceMux, binding, ticket.NewMemoryReplayGuard(c.now), c.now)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	logs := &bytes.Buffer{}
	dials := &atomic.Int64{}
	server, err := New(Options{
		Verifier:    verifier,
		UpstreamURL: upstreamURL,
		Probe:       probe,
		Logger:      slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		Dial: func(ctx context.Context, rawURL string) (*websocket.Conn, error) {
			dials.Add(1)
			conn, _, err := websocket.Dial(ctx, rawURL, nil)
			return conn, err
		},
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ts := httptest.NewServer(server.Handler())
	t.Cleanup(ts.Close)
	return &harness{issuer: issuer, verifier: verifier, clock: c, logs: logs, server: ts, upstreamDials: dials}
}

func (h *harness) ticket(t *testing.T) string {
	t.Helper()
	token, _, err := h.issuer.Issue(ticket.AudienceMux,
		ticket.Binding{SessionID: testSession, RuntimeID: testRuntime}, ticket.DefaultTTL)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	return token
}

func (h *harness) url() string { return "ws" + strings.TrimPrefix(h.server.URL, "http") + "/mux" }

// dial connects the way the desktop does: mux subprotocol plus the ticket.
func (h *harness) dial(t *testing.T, token string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return websocket.Dial(ctx, h.url(), &websocket.DialOptions{Subprotocols: ticket.Subprotocols(token)})
}

func (h *harness) mustDial(t *testing.T, token string) *websocket.Conn {
	t.Helper()
	conn, _, err := h.dial(t, token)
	if err != nil {
		t.Fatalf("dial sandbox mux: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(websocket.StatusNormalClosure, "test done") })
	return conn
}

// echoUpstream stands in for the daemon's loopback /mux for the transport
// tests: it returns every message unchanged, preserving opcode.
func echoUpstream(t *testing.T) string {
	t.Helper()
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		conn.SetReadLimit(readLimit)
		defer conn.CloseNow()
		for {
			typ, payload, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			if err := conn.Write(r.Context(), typ, payload); err != nil {
				return
			}
		}
	}))
	t.Cleanup(ts.Close)
	return "ws" + strings.TrimPrefix(ts.URL, "http") + "/mux"
}

func TestTicketedClientReachesTheDaemon(t *testing.T) {
	h := newHarness(t, echoUpstream(t), nil)
	conn := h.mustDial(t, h.ticket(t))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sent := []byte(`{"ch":"terminal","type":"open","id":"t1"}`)
	if err := conn.Write(ctx, websocket.MessageText, sent); err != nil {
		t.Fatalf("write: %v", err)
	}
	typ, got, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if typ != websocket.MessageText || !bytes.Equal(got, sent) {
		t.Fatalf("relayed %v %q, want text %q", typ, got, sent)
	}
}

// The negotiated subprotocol is what tells a client its offer was understood.
func TestListenerSelectsTheMuxSubprotocol(t *testing.T) {
	h := newHarness(t, echoUpstream(t), nil)
	conn := h.mustDial(t, h.ticket(t))
	if got := conn.Subprotocol(); got != ticket.Subprotocol {
		t.Fatalf("negotiated subprotocol = %q, want %q", got, ticket.Subprotocol)
	}
}

// A message larger than coder/websocket's 32 KiB default read limit must
// survive. The daemon reads the PTY in 32 KiB chunks and base64-encodes them,
// so ordinary terminal output already exceeds the default; a relay that kept it
// would truncate real panes.
func TestLargeTerminalOutputSurvivesTheRelay(t *testing.T) {
	h := newHarness(t, echoUpstream(t), nil)
	conn := h.mustDial(t, h.ticket(t))
	conn.SetReadLimit(readLimit)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	sent := bytes.Repeat([]byte("x"), 200*1024)
	if err := conn.Write(ctx, websocket.MessageText, sent); err != nil {
		t.Fatalf("write: %v", err)
	}
	_, got, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if !bytes.Equal(got, sent) {
		t.Fatalf("relayed %d bytes, want %d", len(got), len(sent))
	}
}

func TestRelayPreservesMessageOpcodes(t *testing.T) {
	h := newHarness(t, echoUpstream(t), nil)
	conn := h.mustDial(t, h.ticket(t))

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, want := range []websocket.MessageType{websocket.MessageText, websocket.MessageBinary} {
		if err := conn.Write(ctx, want, []byte{0x00, 0xff, 0x7f}); err != nil {
			t.Fatalf("write %v: %v", want, err)
		}
		got, payload, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read %v: %v", want, err)
		}
		if got != want {
			t.Fatalf("opcode = %v, want %v", got, want)
		}
		if !bytes.Equal(payload, []byte{0x00, 0xff, 0x7f}) {
			t.Fatalf("payload = %v", payload)
		}
	}
}

func TestNoTicketIsRefusedWithoutDiallingTheDaemon(t *testing.T) {
	h := newHarness(t, echoUpstream(t), nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, h.url(), &websocket.DialOptions{Subprotocols: []string{ticket.Subprotocol}})
	if err == nil {
		t.Fatal("dial without a ticket succeeded")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %v, want 401", resp)
	}
	if dials := h.upstreamDials.Load(); dials != 0 {
		t.Fatalf("unauthenticated dial reached the daemon %d times, want 0", dials)
	}
}

// A client that presents a credential but does not speak the protocol is
// refused: accepting it would leave a socket that can never carry a frame.
func TestTicketWithoutTheMuxSubprotocolIsRefused(t *testing.T) {
	h := newHarness(t, echoUpstream(t), nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, h.url(), &websocket.DialOptions{
		Subprotocols: []string{ticket.TicketSubprotocolPrefix + h.ticket(t)},
	})
	if err == nil {
		t.Fatal("dial without the mux subprotocol succeeded")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %v, want 401", resp)
	}
}

func TestReplayedTicketIsRefused(t *testing.T) {
	h := newHarness(t, echoUpstream(t), nil)
	token := h.ticket(t)
	h.mustDial(t, token)

	_, resp, err := h.dial(t, token)
	if err == nil {
		t.Fatal("second dial with the same ticket succeeded")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %v, want 401", resp)
	}
}

func TestExpiredTicketIsRefused(t *testing.T) {
	h := newHarness(t, echoUpstream(t), nil)
	token := h.ticket(t)
	h.clock.at = h.clock.at.Add(ticket.DefaultTTL + time.Second)

	_, resp, err := h.dial(t, token)
	if err == nil {
		t.Fatal("dial with an expired ticket succeeded")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %v, want 401", resp)
	}
}

func TestTicketForAnotherSessionIsRefused(t *testing.T) {
	h := newHarness(t, echoUpstream(t), nil)
	token, _, err := h.issuer.Issue(ticket.AudienceMux, ticket.Binding{SessionID: "sess-99"}, ticket.DefaultTTL)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	_, resp, dialErr := h.dial(t, token)
	if dialErr == nil {
		t.Fatal("dial with another session's ticket succeeded")
	}
	if resp == nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %v, want 401", resp)
	}
}

// Clients that can set headers may present the ticket as a bearer credential.
func TestBearerTicketIsAccepted(t *testing.T) {
	h := newHarness(t, echoUpstream(t), nil)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, h.url(), &websocket.DialOptions{
		Subprotocols: []string{ticket.Subprotocol},
		HTTPHeader:   http.Header{"Authorization": []string{"Bearer " + h.ticket(t)}},
	})
	if err != nil {
		t.Fatalf("dial with a bearer ticket: %v", err)
	}
	_ = conn.Close(websocket.StatusNormalClosure, "test done")
}

// Every rejection is the same opaque 401. Distinguishing expired from forged
// for an unauthenticated caller tells an attacker which half they got right.
func TestEveryRejectionLooksIdentical(t *testing.T) {
	h := newHarness(t, echoUpstream(t), nil)
	spent := h.ticket(t)
	h.mustDial(t, spent)
	expired := h.ticket(t)
	h.clock.at = h.clock.at.Add(ticket.DefaultTTL + time.Second)

	bodies := make([]string, 0, 3)
	for _, token := range []string{spent, expired, "aotkt_v1.forged.forged"} {
		_, resp, err := h.dial(t, token)
		if err == nil {
			t.Fatalf("dial with %q succeeded", token)
		}
		if resp == nil {
			t.Fatalf("no response for %q", token)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		bodies = append(bodies, resp.Status+"|"+string(body))
	}
	for _, body := range bodies[1:] {
		if body != bodies[0] {
			t.Fatalf("rejections differ: %q vs %q", body, bodies[0])
		}
	}
}

// A refusal must not write the presented ticket into the log: sandbox logs are
// shipped off the box, and a ticket in a log line is a ticket in a log store.
func TestRefusalsDoNotLogTicketMaterial(t *testing.T) {
	h := newHarness(t, echoUpstream(t), nil)
	token := h.ticket(t)
	h.mustDial(t, token)
	if _, _, err := h.dial(t, token); err == nil {
		t.Fatal("replay succeeded")
	}
	if strings.Contains(h.logs.String(), token) {
		t.Fatalf("ticket material leaked into the log: %s", h.logs.String())
	}
}

func TestUnreachableDaemonIsABadGateway(t *testing.T) {
	// A port nothing listens on: 127.0.0.1:1 is reserved and never bound.
	h := newHarness(t, "ws://127.0.0.1:1/mux", nil)
	_, resp, err := h.dial(t, h.ticket(t))
	if err == nil {
		t.Fatal("dial with no daemon behind the listener succeeded")
	}
	if resp == nil || resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %v, want 502", resp)
	}
}

// When the daemon closes, the client sees the daemon's own close status rather
// than a generic relay failure — the difference between reconnecting and
// surfacing an error.
func TestDaemonCloseIsPropagatedToTheClient(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		_ = conn.Close(websocket.StatusNormalClosure, "daemon done")
	}))
	defer upstream.Close()

	h := newHarness(t, "ws"+strings.TrimPrefix(upstream.URL, "http")+"/mux", nil)
	conn := h.mustDial(t, h.ticket(t))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err := conn.Read(ctx)
	if got := websocket.CloseStatus(err); got != websocket.StatusNormalClosure {
		t.Fatalf("close status = %v (err %v), want %v", got, err, websocket.StatusNormalClosure)
	}
}

type fixedProbe struct {
	phase  string
	ready  bool
	reason string
}

func (p fixedProbe) Ready() (string, bool, string) { return p.phase, p.ready, p.reason }

func TestReadyzReflectsTheProbe(t *testing.T) {
	for _, tc := range []struct {
		name  string
		probe Probe
		want  int
	}{
		{"not ready", fixedProbe{phase: "starting-daemon", ready: false, reason: "daemon has not answered readyz"}, http.StatusServiceUnavailable},
		{"ready", fixedProbe{phase: "ready", ready: true}, http.StatusOK},
		{"no probe", nil, http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHarness(t, echoUpstream(t), tc.probe)
			resp, err := http.Get(h.server.URL + "/readyz")
			if err != nil {
				t.Fatalf("GET /readyz: %v", err)
			}
			defer func() { _ = resp.Body.Close() }()
			if resp.StatusCode != tc.want {
				t.Fatalf("status = %d, want %d", resp.StatusCode, tc.want)
			}
			var body readiness
			if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if tc.probe != nil {
				want, _ := tc.probe.(fixedProbe)
				if body.Phase != want.phase || body.Ready != want.ready || body.Reason != want.reason {
					t.Fatalf("body = %+v, want %+v", body, want)
				}
			}
		})
	}
}

func TestHealthzAnswersWithoutATicket(t *testing.T) {
	h := newHarness(t, echoUpstream(t), fixedProbe{phase: "starting-daemon"})
	resp, err := http.Get(h.server.URL + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 even while the workload is still starting", resp.StatusCode)
	}
}

// The published surface is exactly three endpoints. Anything else reachable
// from the internet is a route nobody decided to publish.
func TestPublishedSurfaceIsOnlyTheThreeEndpoints(t *testing.T) {
	h := newHarness(t, echoUpstream(t), nil)
	for _, path := range []string{"/", "/api/v1/sessions", "/shutdown", "/debug/pprof/"} {
		resp, err := http.Get(h.server.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Fatalf("GET %s = %d, want 404", path, resp.StatusCode)
		}
	}
}

func TestNewRejectsAnUnusableUpstream(t *testing.T) {
	key, err := ticket.GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	verifier, err := ticket.NewVerifier(key, ticket.AudienceMux,
		ticket.Binding{SessionID: testSession}, ticket.NewMemoryReplayGuard(nil), nil)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	for _, upstream := range []string{"", "http://127.0.0.1:4317/mux", "://nonsense"} {
		if _, err := New(Options{Verifier: verifier, UpstreamURL: upstream, Logger: discardLogger()}); err == nil {
			t.Fatalf("New accepted upstream %q", upstream)
		}
	}
	if _, err := New(Options{UpstreamURL: "ws://127.0.0.1:4317/mux", Logger: discardLogger()}); err == nil {
		t.Fatal("New accepted a nil verifier")
	}
}

// The reverse direction matters too: when the desktop closes a tab, the daemon
// must see a real close rather than a hung socket it keeps a PTY attached to.
func TestClientCloseIsPropagatedToTheDaemon(t *testing.T) {
	closed := make(chan websocket.StatusCode, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer conn.CloseNow()
		_, _, readErr := conn.Read(r.Context())
		closed <- websocket.CloseStatus(readErr)
	}))
	defer upstream.Close()

	h := newHarness(t, "ws"+strings.TrimPrefix(upstream.URL, "http")+"/mux", nil)
	conn, _, err := h.dial(t, h.ticket(t))
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	if err := conn.Close(websocket.StatusNormalClosure, "tab closed"); err != nil {
		t.Fatalf("close: %v", err)
	}
	select {
	case got := <-closed:
		if got != websocket.StatusNormalClosure {
			t.Fatalf("daemon saw close status %v, want %v", got, websocket.StatusNormalClosure)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("daemon never saw the client's close")
	}
}
