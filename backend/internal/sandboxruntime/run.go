package sandboxruntime

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/runtime/tmux"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/terminal"
)

// RunLocal composes the thin sandbox process: one materialized observation,
// one tmux runtime, its protocol-compatible PTY mux, and the authenticated
// listener. It opens no AO daemon or product database.
func RunLocal(ctx context.Context, config LaunchConfig, tickets TicketConsumer, log *slog.Logger) error {
	if err := config.Validate(); err != nil {
		return err
	}
	if tickets == nil {
		return errors.New("sandbox ticket consumer is required")
	}
	if log == nil {
		log = slog.Default()
	}
	if err := ClearReady(config.ReadyFile); err != nil {
		return err
	}
	defer func() { _ = ClearReady(config.ReadyFile) }()

	observation, err := NewMaterializedObservation(MaterializedConfig{
		SessionID: config.SessionID,
		Root:      config.WorkspacePath,
	})
	if err != nil {
		return err
	}
	runtime := tmux.New(tmux.Options{})
	handle, err := runtime.Create(ctx, ports.RuntimeConfig{
		SessionID:     config.SessionID,
		WorkspacePath: config.WorkspacePath,
		Argv:          append([]string(nil), config.ChildArgv...),
	})
	if err != nil {
		return fmt.Errorf("start sandbox child runtime: %w", err)
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		if err := runtime.Destroy(cleanupCtx, handle); err != nil {
			log.Warn("sandbox runtime cleanup failed", "err", err)
		}
	}()
	alive, err := runtime.IsAlive(ctx, handle)
	if err != nil {
		return fmt.Errorf("sandbox child runtime did not become live: %w", err)
	}
	if !alive {
		return errors.New("sandbox child runtime did not become live")
	}

	mux := terminal.NewManager(runtime, nil, log)
	defer mux.Close()
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	listener, err := NewListener(ListenerOptions{
		Observation: observation,
		Runtime:     runtime,
		Mux:         mux,
		Tickets:     tickets,
		SessionID:   config.SessionID,
		Shutdown:    cancel,
		Logger:      log,
	})
	if err != nil {
		return err
	}

	networkListener, err := net.Listen("tcp", config.ListenAddress)
	if err != nil {
		return fmt.Errorf("listen for sandbox control: %w", err)
	}
	defer networkListener.Close()
	server := &http.Server{
		Handler:           listener,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- server.Serve(networkListener) }()

	if err := PublishReady(config.ReadyFile); err != nil {
		_ = server.Close()
		return err
	}

	select {
	case <-runCtx.Done():
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return fmt.Errorf("shutdown sandbox listener: %w", err)
		}
		return nil
	case err := <-serveErrors:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return fmt.Errorf("serve sandbox listener: %w", err)
	}
}
