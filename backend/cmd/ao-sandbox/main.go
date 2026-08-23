// ao-sandbox is the disposable compute listener. It is intentionally not an
// AO daemon and has no durable state or provider integration.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/sandboxruntime"
	"github.com/aoagents/agent-orchestrator/backend/internal/secretfile"
	"github.com/aoagents/agent-orchestrator/backend/internal/terminal/muxproto"
)

type options struct {
	listen          string
	controlPlaneURL string
	sandboxID       string
	workspaceID     string
	sessionID       string
	workspace       string
	readyFile       string
	secretDir       string
	routePrefix     string
	command         []string
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "ao-sandbox:", err)
		os.Exit(1)
	}
}

func run(args []string) error {
	opts, err := parseOptions(args)
	if err != nil {
		return err
	}
	target := sandboxruntime.TicketGrant{
		SandboxID: opts.sandboxID, WorkspaceID: opts.workspaceID, SessionID: opts.sessionID,
	}
	capability := sandboxruntime.FileCapability{Path: sandboxruntime.DefaultCapabilityPath}
	if _, err := capability.ReadCapability(); err != nil {
		return err
	}
	redeemer, err := sandboxruntime.NewControlPlaneRedeemer(opts.controlPlaneURL, capability, target)
	if err != nil {
		return err
	}
	secrets, err := secretfile.NewSink(opts.secretDir)
	if err != nil {
		return err
	}
	defer func() { _ = secrets.Purge() }()
	defer func() { _ = os.Remove(sandboxruntime.DefaultCapabilityPath) }()
	defer func() { _ = os.Remove(opts.readyFile) }()

	pty, err := (sandboxruntime.DirectPTYFactory{}).Start(opts.command, opts.workspace)
	if err != nil {
		return fmt.Errorf("start PTY: %w", err)
	}
	mux := sandboxruntime.NewPTYMux(pty, opts.sessionID)
	server, err := sandboxruntime.NewServer(sandboxruntime.ServerConfig{
		Target: target, WorkspaceDir: opts.workspace, RoutePrefix: opts.routePrefix,
		Redeemer: redeemer, Mux: mux,
	})
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", opts.listen)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	defer func() { _ = listener.Close() }()
	serveErr := make(chan error, 1)
	go func() { serveErr <- server.Serve(listener) }()
	if err := writeReadyFile(opts.readyFile, listener.Addr().String(), opts.routePrefix, opts.sessionID); err != nil {
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
		return err
	}

	signalCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	select {
	case <-signalCtx.Done():
	case <-mux.Done():
	case err := <-serveErr:
		if err != nil {
			return fmt.Errorf("serve: %w", err)
		}
	}
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return server.Shutdown(shutdownCtx)
}

func parseOptions(args []string) (options, error) {
	var opts options
	set := flag.NewFlagSet("ao-sandbox", flag.ContinueOnError)
	set.StringVar(&opts.listen, "listen", "0.0.0.0:8080", "published listener address")
	set.StringVar(&opts.controlPlaneURL, "control-plane-url", "", "control plane HTTPS base URL")
	set.StringVar(&opts.sandboxID, "sandbox-id", "", "sandbox placement id")
	set.StringVar(&opts.workspaceID, "workspace-id", "", "workspace placement id")
	set.StringVar(&opts.sessionID, "session-id", "", "session placement id")
	set.StringVar(&opts.workspace, "workspace", "/workspace", "workspace directory")
	set.StringVar(&opts.readyFile, "ready-file", "/run/ao/ready.json", "readiness signal file")
	set.StringVar(&opts.secretDir, "secret-dir", "/run/ao/secrets", "owner-only secret file directory")
	set.StringVar(&opts.routePrefix, "route-prefix", sandboxruntime.DefaultRoutePrefix, "sandbox RPC route prefix")
	if err := set.Parse(args); err != nil {
		return options{}, err
	}
	opts.command = set.Args()
	if opts.controlPlaneURL == "" || opts.sandboxID == "" || opts.workspaceID == "" || opts.sessionID == "" {
		return options{}, errors.New("control-plane-url, sandbox-id, workspace-id, and session-id are required")
	}
	if !filepath.IsAbs(opts.workspace) || !filepath.IsAbs(opts.readyFile) || !filepath.IsAbs(opts.secretDir) {
		return options{}, errors.New("workspace, ready-file, and secret-dir paths must be absolute")
	}
	if len(opts.command) == 0 {
		return options{}, errors.New("agent command is required after --")
	}
	if !filepath.IsAbs(opts.command[0]) {
		return options{}, errors.New("agent command must use an absolute executable path")
	}
	return opts, nil
}

func writeReadyFile(filename, address, routePrefix, sessionID string) error {
	if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
		return fmt.Errorf("create readiness directory: %w", err)
	}
	raw, err := json.Marshal(map[string]string{
		"address": address, "muxPath": muxproto.Path,
		"routePrefix": routePrefix, "sessionId": sessionID,
	})
	if err != nil {
		return errors.New("encode readiness signal")
	}
	tmp, err := os.CreateTemp(filepath.Dir(filename), ".ready-*")
	if err != nil {
		return fmt.Errorf("create readiness signal: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("secure readiness signal: %w", err)
	}
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write readiness signal: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close readiness signal: %w", err)
	}
	if err := os.Rename(tmpPath, filename); err != nil {
		return fmt.Errorf("publish readiness signal: %w", err)
	}
	return nil
}
