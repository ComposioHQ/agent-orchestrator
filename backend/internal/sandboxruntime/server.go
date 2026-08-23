package sandboxruntime

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"path"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/terminal/muxproto"
)

const (
	DefaultRoutePrefix       = "/api/sandbox/v1"
	WorkspaceObservationPath = "/workspace/observation"
	websocketReadLimit       = 1 << 20
)

type ServerConfig struct {
	Target       TicketGrant
	WorkspaceDir string
	RoutePrefix  string
	Redeemer     ControlPlaneRedeemer
	Mux          *PTYMux
	Observer     interface {
		ObserveWorkspace(context.Context, ports.WorkspaceInfo) (ports.WorkspaceObservation, error)
	}
	Logger *slog.Logger
}

type Server struct {
	cfg   ServerConfig
	http  *http.Server
	ready atomic.Bool
}

func NewServer(cfg ServerConfig) (*Server, error) {
	if cfg.Target.SandboxID == "" || cfg.Target.WorkspaceID == "" || cfg.Target.SessionID == "" {
		return nil, errors.New("sandbox, workspace, and session ids are required")
	}
	if cfg.WorkspaceDir == "" || cfg.Redeemer == nil || cfg.Mux == nil {
		return nil, errors.New("workspace, redeemer, and mux are required")
	}
	if cfg.RoutePrefix == "" {
		cfg.RoutePrefix = DefaultRoutePrefix
	}
	cfg.RoutePrefix = "/" + strings.Trim(strings.TrimSpace(cfg.RoutePrefix), "/")
	if cfg.Observer == nil {
		cfg.Observer = WorkspaceObserver{}
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	s := &Server{cfg: cfg}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /readyz", s.handleReady)
	mux.HandleFunc("GET "+muxproto.Path, s.handleMux)
	mux.HandleFunc("GET "+path.Join(cfg.RoutePrefix, WorkspaceObservationPath), s.handleObservation)
	s.http = &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	return s, nil
}

func (s *Server) Serve(listener net.Listener) error {
	s.ready.Store(true)
	err := s.http.Serve(listener)
	s.ready.Store(false)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (s *Server) Shutdown(ctx context.Context) error {
	s.ready.Store(false)
	err := s.http.Shutdown(ctx)
	if muxErr := s.cfg.Mux.Close(ctx); err == nil {
		err = muxErr
	}
	return err
}

func (s *Server) handleReady(w http.ResponseWriter, _ *http.Request) {
	if !s.ready.Load() {
		http.Error(w, "not ready", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ready": true, "muxPath": muxproto.Path,
		"routePrefix": s.cfg.RoutePrefix, "sessionId": s.cfg.Target.SessionID,
	})
}

func (s *Server) handleMux(w http.ResponseWriter, r *http.Request) {
	// A published sandbox is never a browser-origin endpoint. Reject same-origin
	// requests too; only native clients with no Origin header may upgrade.
	if r.Header.Get("Origin") != "" {
		http.Error(w, "origin is not accepted", http.StatusForbidden)
		return
	}
	if r.Header.Get("Authorization") != "" {
		http.Error(w, "ticket required", http.StatusUnauthorized)
		return
	}
	offered := splitSubprotocols(r.Header.Values("Sec-WebSocket-Protocol"))
	if !muxproto.Offered(offered) {
		http.Error(w, "mux subprotocol required", http.StatusBadRequest)
		return
	}
	ticket, err := muxproto.Ticket(offered)
	if err != nil {
		http.Error(w, "ticket required", http.StatusUnauthorized)
		return
	}
	grant, err := s.cfg.Redeemer.Redeem(r.Context(), ticket)
	if err != nil || validateGrant(grant, s.cfg.Target) != nil || !grant.HasScope(ScopeTerminalRead) {
		http.Error(w, "ticket rejected", http.StatusUnauthorized)
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{muxproto.Subprotocol}})
	if err != nil {
		return
	}
	c.SetReadLimit(websocketReadLimit)
	client, remove := s.cfg.Mux.AddClient(grant.HasScope(ScopeTerminalOperate))
	defer remove()
	defer c.Close(websocket.StatusNormalClosure, "sandbox mux closed")

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case frame := <-client.out:
				if err := wsjson.Write(ctx, c, frame); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	for {
		var frame muxproto.ClientFrame
		if err := wsjson.Read(ctx, c, &frame); err != nil {
			return
		}
		s.cfg.Mux.Handle(client, frame)
	}
}

type workspaceObservationResponse struct {
	Path      string                  `json:"path"`
	Branch    string                  `json:"branch,omitempty"`
	HeadSHA   string                  `json:"headSha,omitempty"`
	Dirty     bool                    `json:"dirty"`
	Staged    bool                    `json:"staged"`
	Untracked bool                    `json:"untracked"`
	Changes   []ports.WorkspaceChange `json:"changes"`
	Commits   []ports.WorkspaceCommit `json:"commits"`
}

func (s *Server) handleObservation(w http.ResponseWriter, r *http.Request) {
	ticket, err := authorizationTicket(r)
	if err != nil {
		http.Error(w, "ticket required", http.StatusUnauthorized)
		return
	}
	if _, err := redeemForScope(r.Context(), s.cfg.Redeemer, ticket, ScopeWorkspaceObserve, s.cfg.Target); err != nil {
		http.Error(w, "ticket rejected", http.StatusUnauthorized)
		return
	}
	observation, err := s.cfg.Observer.ObserveWorkspace(r.Context(), ports.WorkspaceInfo{Path: s.cfg.WorkspaceDir})
	if err != nil {
		s.cfg.Logger.Warn("workspace observation failed", "err", err)
		http.Error(w, "workspace observation failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(workspaceObservationResponse{
		Path: observation.Path, Branch: observation.Branch, HeadSHA: observation.HeadSHA,
		Dirty: observation.Dirty, Staged: observation.Staged, Untracked: observation.Untracked,
		Changes: observation.Changes, Commits: observation.Commits,
	})
}

func splitSubprotocols(values []string) []string {
	var protocols []string
	for _, value := range values {
		for _, protocol := range strings.Split(value, ",") {
			protocols = append(protocols, strings.TrimSpace(protocol))
		}
	}
	return protocols
}
