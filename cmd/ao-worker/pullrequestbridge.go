package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/worker"
)

// maxPullRequestBridgeBody bounds a PR title/body posted through the local
// bridge. Generous enough for a real PR description, small enough that a
// misbehaving agent can't tie up the socket with a huge payload.
const maxPullRequestBridgeBody = 1 << 16

// pullRequestBridgeRequest is what the agent's own shell posts to ask the
// worker to push its current branch and open a pull request. It carries no
// GitHub credential — only the worker process ever holds one, fetched fresh
// from the control plane immediately before use and never persisted.
type pullRequestBridgeRequest struct {
	Branch string `json:"branch"`
	Title  string `json:"title"`
	Body   string `json:"body"`
	Base   string `json:"base"`
}

// runPullRequestBridge serves a small local API, reachable only from inside
// this sandbox via a Unix socket, that lets the interactive coding agent ask
// the worker process to push its current branch and open a pull request —
// without the agent's own shell ever touching a GitHub credential. The
// worker fetches a fresh, write-scoped token immediately before the push and
// discards it once used, the same pattern PrepareCheckout already uses for
// cloning (see internal/worker/checkout.go).
func runPullRequestBridge(
	ctx context.Context,
	socketPath string,
	apiClient *client,
	workspace string,
	logger *slog.Logger,
) error {
	_ = os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("listen on pull request bridge socket: %w", err)
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = listener.Close()
		return fmt.Errorf("secure pull request bridge socket: %w", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /pull-request", func(w http.ResponseWriter, r *http.Request) {
		handlePullRequestBridgeRequest(w, r, apiClient, workspace, logger)
	})
	server := &http.Server{Handler: mux}
	errCh := make(chan error, 1)
	go func() { errCh <- server.Serve(listener) }()
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
		<-errCh
		return nil
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func handlePullRequestBridgeRequest(
	w http.ResponseWriter,
	r *http.Request,
	apiClient *client,
	workspace string,
	logger *slog.Logger,
) {
	var input pullRequestBridgeRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxPullRequestBridgeBody)).Decode(&input); err != nil {
		writeBridgeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	input.Branch = strings.TrimSpace(input.Branch)
	input.Title = strings.TrimSpace(input.Title)
	if input.Branch == "" || input.Title == "" {
		writeBridgeError(w, http.StatusBadRequest, "branch and title are required")
		return
	}
	ctx := r.Context()
	grant, err := apiClient.pushGrant(ctx)
	if err != nil {
		logger.Error("pull request bridge: push grant failed", "error", err)
		writeBridgeError(w, http.StatusBadGateway, "could not obtain a push grant")
		return
	}
	if err := worker.PushBranch(ctx, worker.ExecGitRunner{}, workspace, input.Branch, grant); err != nil {
		logger.Error("pull request bridge: push failed", "error", err)
		writeBridgeError(w, http.StatusBadGateway, "push failed: "+err.Error())
		return
	}
	response, err := apiClient.raisePullRequest(ctx, worker.RaisePullRequestRequest{
		Title:      input.Title,
		Body:       input.Body,
		HeadBranch: input.Branch,
		BaseBranch: input.Base,
	})
	if err != nil {
		logger.Error("pull request bridge: raise pull request failed", "error", err)
		writeBridgeError(w, http.StatusBadGateway, "pull request could not be opened")
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(response)
}

func writeBridgeError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
