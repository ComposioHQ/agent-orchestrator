// Command ao-worker is the headless process that runs inside one sandbox. It
// receives no permanent credential and opens no inbound port: it reads a
// one-time bootstrap ticket from its environment, dials the control plane
// outward to exchange it for a short-lived token, and then heartbeats.
//
// It prepares the repository checkout and supervises durable coding-agent
// turns while a separate heartbeat loop keeps its epoch-scoped token current.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/worker"
	"github.com/Untrivial-ai/ao-cloud/internal/workerexec"
	"github.com/Untrivial-ai/ao-cloud/internal/workertransport"
)

const (
	workerVersion     = "0.1.0"
	heartbeatInterval = 20 * time.Second
	// The control plane recreates a sandbox whose worker has been silent for a
	// minute, so a worker that cannot reach home for longer than that is
	// already being replaced and should exit rather than compete with its
	// successor.
	maxHeartbeatFailures = 3
	requestTimeout       = 30 * time.Second
	maxResponseBody      = 1 << 20
)

var workerCapabilities = []string{
	"worker.heartbeat",
	"worker.events",
	"worker.turns",
	"worker.credentials",
	"repository.checkout",
	"workspace.files",
	"terminal.workspace",
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(logger); err != nil {
		logger.Error("worker exited", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	publicURL := strings.TrimRight(strings.TrimSpace(os.Getenv("AO_CLOUD_PUBLIC_URL")), "/")
	sessionID := strings.TrimSpace(os.Getenv("AO_CLOUD_SESSION_ID"))
	bootstrapToken := strings.TrimSpace(os.Getenv("AO_WORKER_BOOTSTRAP_TOKEN"))
	workspace := strings.TrimSpace(os.Getenv("AO_WORKSPACE_DIR"))
	if publicURL == "" {
		return errors.New("AO_CLOUD_PUBLIC_URL is required")
	}
	if sessionID == "" {
		return errors.New("AO_CLOUD_SESSION_ID is required")
	}
	if bootstrapToken == "" {
		return errors.New("AO_WORKER_BOOTSTRAP_TOKEN is required")
	}
	if workspace == "" {
		return errors.New("AO_WORKSPACE_DIR is required")
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	client := &client{
		baseURL: publicURL + "/api/cloud/v1",
		http:    &http.Client{Timeout: requestTimeout},
	}

	bootstrap, err := client.bootstrap(ctx, bootstrapToken)
	if err != nil {
		return fmt.Errorf("bootstrap: %w", err)
	}
	if bootstrap.SessionID != sessionID {
		return errors.New("bootstrap session does not match AO_CLOUD_SESSION_ID")
	}
	// The ticket is single-use and now spent; from here the only credential is
	// the rotating worker token.
	_ = os.Unsetenv("AO_WORKER_BOOTSTRAP_TOKEN")
	bootstrapToken = ""
	client.setToken(bootstrap.WorkerToken)
	logger.Info("worker bootstrapped",
		"session_id", bootstrap.SessionID,
		"worker_id", bootstrap.WorkerID,
		"epoch", bootstrap.Epoch,
		"harness", bootstrap.Launch.Harness,
		"repository_url", bootstrap.Launch.RepositoryURL,
	)

	if worker.IsScratchRepositoryURL(bootstrap.Launch.RepositoryURL) {
		if err := worker.PrepareScratchWorkspace(
			ctx,
			worker.ExecGitRunner{},
			workspace,
		); err != nil {
			return fmt.Errorf("prepare scratch workspace: %w", err)
		}
		logger.Info("initialized scratch workspace")
	} else {
		checkoutGrant, err := client.checkoutGrant(ctx)
		if err != nil {
			if !anonymousCheckoutEnabled() {
				return fmt.Errorf("request checkout grant: %w", err)
			}
			checkoutGrant = worker.CheckoutGrantResponse{
				CloneURL: bootstrap.Launch.RepositoryURL,
			}
			logger.Info("using anonymous public GitHub checkout")
		}
		if err := worker.PrepareCheckout(
			ctx,
			worker.ExecGitRunner{},
			workspace,
			checkoutGrant,
		); err != nil {
			return fmt.Errorf("prepare repository checkout: %w", err)
		}
	}
	if err := verifyHarnessAvailable(bootstrap.Launch.Harness); err != nil {
		return err
	}

	if err := client.publishEvent(ctx, "worker.ready", map[string]any{
		"workerId":     bootstrap.WorkerID,
		"epoch":        bootstrap.Epoch,
		"version":      workerVersion,
		"capabilities": workerCapabilities,
	}); err != nil {
		logger.Warn("publish worker.ready failed", "error", err)
	}

	// Heartbeat before waiting out the first interval. Bootstrap registration is
	// not a check-in, so a repaired worker can otherwise be replaced again
	// before the control plane ever observes it.
	if renewed, err := client.heartbeat(ctx); err != nil {
		logger.Warn("first heartbeat failed", "error", err)
	} else {
		client.setToken(renewed)
	}
	dataDir := strings.TrimSpace(os.Getenv("AO_DATA_DIR"))
	if dataDir == "" {
		dataDir = os.TempDir()
	}
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	supervisor := workerexec.Supervisor{
		Control:   client,
		Builder:   workerexec.HarnessBuilder{DataDir: dataDir},
		Runner:    workerexec.OSRunner{},
		Workspace: workspace,
		Logger:    logger,
	}
	transportSupervisor := workertransport.Supervisor{
		Control: client, Workspace: workspace, Logger: logger,
	}
	results := make(chan error, 3)
	go func() { results <- client.heartbeatLoop(runCtx, logger) }()
	go func() { results <- supervisor.Run(runCtx) }()
	go func() { results <- transportSupervisor.Run(runCtx) }()
	first := <-results
	cancel()
	<-results
	<-results
	if ctx.Err() != nil {
		logger.Info("worker shutting down")
		return nil
	}
	return first
}

var errStaleWorker = errors.New("worker credential replaced")

type client struct {
	baseURL string
	http    *http.Client
	mu      sync.RWMutex
	token   string
}

func (c *client) bootstrap(ctx context.Context, bootstrapToken string) (worker.BootstrapResponse, error) {
	var response worker.BootstrapResponse
	err := c.do(ctx, "/worker/bootstrap", worker.BootstrapRequest{
		BootstrapToken: bootstrapToken,
		Version:        workerVersion,
		Capabilities:   workerCapabilities,
	}, &response)
	if err != nil {
		return worker.BootstrapResponse{}, err
	}
	if response.WorkerToken == "" {
		return worker.BootstrapResponse{}, errors.New("control plane returned no worker token")
	}
	return response, nil
}

func (c *client) heartbeat(ctx context.Context) (string, error) {
	var response worker.HeartbeatResponse
	err := c.do(ctx, "/worker/heartbeat", worker.HeartbeatRequest{
		Version:      workerVersion,
		Capabilities: workerCapabilities,
	}, &response)
	if err != nil {
		return "", err
	}
	if response.WorkerToken == "" {
		return "", errors.New("control plane returned no renewed worker token")
	}
	return response.WorkerToken, nil
}

func (c *client) heartbeatLoop(ctx context.Context, logger *slog.Logger) error {
	ticker := time.NewTicker(heartbeatInterval)
	defer ticker.Stop()
	failures := 0
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			renewed, err := c.heartbeat(ctx)
			if errors.Is(err, errStaleWorker) {
				return errors.New("worker credential was replaced; a newer worker owns this session")
			}
			if err != nil {
				failures++
				logger.Warn("heartbeat failed", "error", err, "consecutive_failures", failures)
				if failures >= maxHeartbeatFailures {
					return fmt.Errorf("heartbeat failed %d times: %w", failures, err)
				}
				continue
			}
			failures = 0
			c.setToken(renewed)
		}
	}
}

func (c *client) ClaimTurn(ctx context.Context) (*worker.Turn, error) {
	var response worker.ClaimTurnResponse
	if err := c.do(ctx, "/worker/turns/claim", worker.ClaimTurnRequest{}, &response); err != nil {
		return nil, err
	}
	return response.Turn, nil
}

func (c *client) Credential(ctx context.Context) (worker.CredentialResponse, error) {
	var response worker.CredentialResponse
	err := c.doMethod(ctx, http.MethodGet, "/worker/credential", nil, &response)
	if err != nil {
		return worker.CredentialResponse{}, err
	}
	if response.Provider == "" || response.CredentialType == "" || response.Secret == "" {
		return worker.CredentialResponse{}, errors.New("control plane returned an incomplete coding-agent credential")
	}
	return response, nil
}

func (c *client) checkoutGrant(ctx context.Context) (worker.CheckoutGrantResponse, error) {
	var response worker.CheckoutGrantResponse
	if err := c.do(ctx, "/worker/checkout-grant", struct{}{}, &response); err != nil {
		return worker.CheckoutGrantResponse{}, err
	}
	if response.CloneURL == "" ||
		(response.Token != "" && !response.ExpiresAt.After(time.Now())) {
		return worker.CheckoutGrantResponse{}, errors.New("control plane returned an invalid checkout grant")
	}
	return response, nil
}

func anonymousCheckoutEnabled() bool {
	enabled, err := strconv.ParseBool(strings.TrimSpace(
		os.Getenv("AO_CLOUD_ALLOW_ANONYMOUS_GITHUB_CHECKOUT"),
	))
	return err == nil && enabled
}

func verifyHarnessAvailable(harness string) error {
	var binary string
	switch harness {
	case "claude-code":
		binary = "claude"
	case "codex":
		binary = "codex"
	case "cursor":
		binary = "cursor-agent"
	default:
		return fmt.Errorf("unsupported coding-agent harness %q", harness)
	}
	if _, err := exec.LookPath(binary); err != nil {
		return fmt.Errorf("%s harness binary %q is unavailable: %w", harness, binary, err)
	}
	return nil
}

func (c *client) PublishOutput(ctx context.Context, output worker.OutputEvent) error {
	return c.publishEvent(ctx, "chat.assistant_delta", output)
}

func (c *client) ClaimTransport(ctx context.Context) (*worker.TransportRequest, error) {
	var response worker.ClaimTransportResponse
	if err := c.do(ctx, "/worker/transport/claim", struct{}{}, &response); err != nil {
		return nil, err
	}
	return response.Request, nil
}

func (c *client) CompleteTransport(
	ctx context.Context,
	requestID string,
	attempt int,
	result any,
) error {
	return c.do(
		ctx,
		"/worker/transport/"+url.PathEscape(requestID)+"/complete",
		worker.CompleteTransportRequest{Attempt: attempt, Response: result},
		nil,
	)
}

func (c *client) FailTransport(
	ctx context.Context,
	requestID string,
	attempt int,
	code, message string,
) error {
	return c.do(
		ctx,
		"/worker/transport/"+url.PathEscape(requestID)+"/fail",
		worker.FailTransportRequest{Attempt: attempt, Code: code, Message: message},
		nil,
	)
}

func (c *client) PublishTerminalOutput(
	ctx context.Context,
	terminalID string,
	data []byte,
) error {
	return c.do(
		ctx,
		"/worker/terminals/"+url.PathEscape(terminalID)+"/output",
		worker.TerminalOutputRequest{Data: data},
		nil,
	)
}

func (c *client) CancellationRequested(
	ctx context.Context,
	turnID string,
	attempt int,
) (bool, error) {
	var response worker.CancellationResponse
	path := "/worker/turns/" + url.PathEscape(turnID) +
		"/cancellation?attempt=" + url.QueryEscape(fmt.Sprint(attempt))
	if err := c.doMethod(ctx, http.MethodGet, path, nil, &response); err != nil {
		return false, err
	}
	return response.Requested, nil
}

func (c *client) CompleteTurn(
	ctx context.Context,
	turnID string,
	attempt int,
	cancelled bool,
) error {
	return c.do(
		ctx,
		"/worker/turns/"+url.PathEscape(turnID)+"/complete",
		worker.FinishTurnRequest{Attempt: attempt, Cancelled: cancelled},
		nil,
	)
}

func (c *client) FailTurn(
	ctx context.Context,
	turnID string,
	attempt int,
	message string,
) error {
	return c.do(
		ctx,
		"/worker/turns/"+url.PathEscape(turnID)+"/fail",
		worker.FailTurnRequest{Attempt: attempt, Error: message},
		nil,
	)
}

func (c *client) publishEvent(ctx context.Context, eventType string, payload any) error {
	return c.do(ctx, "/worker/events", worker.EventRequest{Type: eventType, Payload: payload}, nil)
}

func (c *client) do(ctx context.Context, path string, body any, out any) error {
	return c.doMethod(ctx, http.MethodPost, path, body, out)
}

func (c *client) doMethod(
	ctx context.Context,
	method, path string,
	body any,
	out any,
) error {
	var encoded []byte
	var err error
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode %s request: %w", path, err)
		}
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(encoded))
	if err != nil {
		return err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if token := c.currentToken(); token != "" {
		request.Header.Set("Authorization", "Worker "+token)
	}
	response, err := c.http.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode > 299 {
		snippet, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		if response.StatusCode == http.StatusUnauthorized &&
			bytes.Contains(snippet, []byte("STALE_WORKER_TOKEN")) {
			return errStaleWorker
		}
		return fmt.Errorf("%s returned %d: %s", path, response.StatusCode, strings.TrimSpace(string(snippet)))
	}
	if out == nil {
		return nil
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, maxResponseBody)).Decode(out); err != nil {
		return fmt.Errorf("decode %s response: %w", path, err)
	}
	return nil
}

func (c *client) setToken(token string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.token = token
}

func (c *client) currentToken() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.token
}
