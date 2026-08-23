package muxd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox/ticket"
)

// readLimit caps a single relayed message in either direction.
//
// It is deliberately far above coder/websocket's 32 KiB default. The daemon
// reads the PTY in 32 KiB chunks and base64-encodes them into a JSON frame, so
// an ordinary burst of terminal output already exceeds the default and would be
// dropped as an oversized message. Matching the daemon's own 1 MiB inbound cap
// (httpd.terminalMuxReadLimit) keeps the relay transparent in both directions.
const readLimit = 1 << 20

// heartbeat is how often the listener pings the downstream client.
//
// The daemon's own heartbeat now terminates here rather than at the real
// client, so without this a wedged desktop would hold a pane open indefinitely
// while the daemon happily ponged the relay. Pinging downstream restores the
// end-to-end liveness the local transport has, and a failed ping tears down
// both halves.
const heartbeat = 15 * time.Second

// Probe reports whether the sandbox is ready to serve. bootstrap satisfies it;
// the interface lives here so muxd does not depend on the supervisor.
type Probe interface {
	// Ready returns the current phase and, when not ready, why not. The reason
	// is shown on an unauthenticated endpoint, so implementations must keep it
	// free of credentials and provider identifiers.
	Ready() (phase string, ready bool, reason string)
}

// Options configures the listener.
type Options struct {
	// Verifier authenticates presented tickets. Required.
	Verifier *ticket.Verifier
	// UpstreamURL is the daemon's loopback mux, e.g. ws://127.0.0.1:4317/mux.
	// Required.
	UpstreamURL string
	// Probe backs /readyz. A nil probe reports ready, which is what a listener
	// running without a supervisor (tests, manual bring-up) should say.
	Probe Probe
	// Dial opens the upstream connection. Nil uses websocket.Dial; tests
	// substitute a loopback dialer.
	Dial func(ctx context.Context, rawURL string) (*websocket.Conn, error)
	// Logger is required to be non-nil only in the sense that a nil one falls
	// back to slog.Default.
	Logger *slog.Logger
}

// Server serves the sandbox's published endpoints.
type Server struct {
	verifier *ticket.Verifier
	upstream string
	probe    Probe
	dial     func(ctx context.Context, rawURL string) (*websocket.Conn, error)
	log      *slog.Logger
}

// New validates options and builds the listener.
func New(opts Options) (*Server, error) {
	if opts.Verifier == nil {
		return nil, errors.New("muxd: a ticket verifier is required")
	}
	upstream := strings.TrimSpace(opts.UpstreamURL)
	if upstream == "" {
		return nil, errors.New("muxd: an upstream mux URL is required")
	}
	parsed, err := url.Parse(upstream)
	if err != nil || (parsed.Scheme != "ws" && parsed.Scheme != "wss") {
		return nil, fmt.Errorf("muxd: upstream mux URL must be ws:// or wss://, got %q", upstream)
	}
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	dial := opts.Dial
	if dial == nil {
		dial = func(ctx context.Context, rawURL string) (*websocket.Conn, error) {
			conn, _, err := websocket.Dial(ctx, rawURL, nil)
			return conn, err
		}
	}
	return &Server{verifier: opts.Verifier, upstream: upstream, probe: opts.Probe, dial: dial, log: log}, nil
}

// Handler builds the published mux. It is deliberately a bare mux and not the
// daemon's chi router: the published surface is three endpoints, and every
// route added here is a route reachable from the internet.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /mux", s.serveMux)
	mux.HandleFunc("GET /healthz", s.serveHealth)
	mux.HandleFunc("GET /readyz", s.serveReady)
	return mux
}

// serveHealth answers process liveness. It says nothing about the workload on
// purpose: it is unauthenticated, and "this port is answering" is all an edge
// proxy's health check needs.
func (s *Server) serveHealth(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok\n"))
}

// readiness is the /readyz body. Phase and Reason are coarse workload states,
// never credentials or provider identifiers — this endpoint is unauthenticated.
type readiness struct {
	Ready  bool   `json:"ready"`
	Phase  string `json:"phase"`
	Reason string `json:"reason,omitempty"`
}

func (s *Server) serveReady(w http.ResponseWriter, _ *http.Request) {
	body := readiness{Ready: true, Phase: "ready"}
	if s.probe != nil {
		phase, ready, reason := s.probe.Ready()
		body = readiness{Ready: ready, Phase: phase, Reason: reason}
	}
	status := http.StatusOK
	if !body.Ready {
		status = http.StatusServiceUnavailable
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// serveMux authenticates a connection and relays it to the daemon's loopback
// mux.
//
// The ordering here is the security-relevant part. The ticket is verified
// BEFORE anything else happens, so unauthenticated traffic cannot make this
// process dial the daemon; and the upstream is dialled BEFORE the downstream
// upgrade, so a client that cannot be served gets an HTTP status it can read
// instead of a WebSocket that closes a millisecond later.
//
// One consequence is worth stating plainly: a ticket is spent even if the
// upstream dial then fails. That is what single-use means, and the client's
// recovery is to fetch fresh terminal metadata — the same path it already takes
// after any dropped socket.
func (s *Server) serveMux(w http.ResponseWriter, r *http.Request) {
	presented, speaksMux := presentedTicket(r)
	if presented == "" {
		s.refuse(w, r, "no ticket presented")
		return
	}
	if !speaksMux {
		s.refuse(w, r, "client did not offer the "+ticket.Subprotocol+" subprotocol")
		return
	}
	verified, err := s.verifier.Verify(presented)
	if err != nil {
		// The reason is logged, never returned. Telling an unauthenticated
		// caller whether a ticket was expired, replayed, or forged tells an
		// attacker which half of the credential they got right.
		s.refuse(w, r, err.Error())
		return
	}

	ctx := r.Context()
	dialCtx, cancelDial := context.WithTimeout(ctx, 10*time.Second)
	upstream, err := s.dial(dialCtx, s.upstream)
	cancelDial()
	if err != nil {
		s.log.Warn("Sandbox mux could not reach the daemon", "ticket", verified.ID, "error", err)
		http.Error(w, "terminal backend unavailable", http.StatusBadGateway)
		return
	}
	upstream.SetReadLimit(readLimit)

	// Selecting the mux subprotocol is what tells the client its offer was
	// understood. InsecureSkipVerify disables the same-origin check for the
	// reason recorded in the package doc: this listener trusts the ticket and
	// nothing about the caller's origin.
	downstream, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		Subprotocols:       []string{ticket.Subprotocol},
		InsecureSkipVerify: true,
	})
	if err != nil {
		s.log.Warn("Sandbox mux upgrade failed", "ticket", verified.ID, "error", err)
		_ = upstream.Close(websocket.StatusInternalError, "downstream upgrade failed")
		return
	}
	downstream.SetReadLimit(readLimit)

	s.log.Info("Sandbox mux connection opened",
		"ticket", verified.ID, "session", verified.Binding.SessionID)
	relay(ctx, downstream, upstream, s.log)
	s.log.Info("Sandbox mux connection closed", "ticket", verified.ID)
}

// refuse answers every authentication failure identically.
func (s *Server) refuse(w http.ResponseWriter, r *http.Request, reason string) {
	s.log.Warn("Sandbox mux refused a connection", "reason", reason, "remote", r.RemoteAddr)
	http.Error(w, "unauthorized", http.StatusUnauthorized)
}

// presentedTicket pulls the ticket off the handshake.
//
// Sec-WebSocket-Protocol is the canonical carrier and the one the control plane
// publishes, because it is the only place a browser can put a credential on a
// WebSocket handshake and it keeps the value out of URLs and access logs. A
// bearer header is also accepted for clients that can set headers (the CLI, the
// desktop's main process, tests); it is never required, and when both are
// present the subprotocol wins so there is one answer rather than a merge rule.
func presentedTicket(r *http.Request) (presented string, speaksMux bool) {
	offered := make([]string, 0, 2)
	for _, header := range r.Header.Values("Sec-WebSocket-Protocol") {
		for _, entry := range strings.Split(header, ",") {
			if entry = strings.TrimSpace(entry); entry != "" {
				offered = append(offered, entry)
			}
		}
	}
	presented, speaksMux = ticket.FromSubprotocols(offered)
	if presented != "" {
		return presented, speaksMux
	}
	const bearer = "Bearer "
	if authorization := r.Header.Get("Authorization"); strings.HasPrefix(authorization, bearer) {
		return strings.TrimSpace(strings.TrimPrefix(authorization, bearer)), speaksMux
	}
	return "", speaksMux
}
