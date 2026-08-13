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

// maxReviewBridgeBody bounds a review verdict posted through the local
// bridge. Generous enough for real review findings, small enough that a
// misbehaving agent can't tie up the socket with a huge payload.
const maxReviewBridgeBody = 1 << 16

// reviewBridgeRequest is what the agent's own shell posts to report an
// AO-triggered review's verdict. It carries no GitHub credential — only the
// worker process ever holds one, fetched fresh from the control plane
// immediately before posting the review and never persisted.
type reviewBridgeRequest struct {
	ReviewRunID string `json:"reviewRunId"`
	Verdict     string `json:"verdict"`
	Body        string `json:"body"`
}

// runReviewBridge serves a small local API, reachable only from inside this
// sandbox via a Unix socket, that lets the interactive coding agent report
// an AO-triggered review's verdict — without the agent's own shell ever
// touching a GitHub credential. Mirrors runPullRequestBridge.
func runReviewBridge(
	ctx context.Context,
	socketPath string,
	apiClient *client,
	logger *slog.Logger,
) error {
	_ = os.Remove(socketPath)
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		return fmt.Errorf("listen on review bridge socket: %w", err)
	}
	if err := os.Chmod(socketPath, 0o600); err != nil {
		_ = listener.Close()
		return fmt.Errorf("secure review bridge socket: %w", err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /review", func(w http.ResponseWriter, r *http.Request) {
		handleReviewBridgeRequest(w, r, apiClient, logger)
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

func handleReviewBridgeRequest(
	w http.ResponseWriter,
	r *http.Request,
	apiClient *client,
	logger *slog.Logger,
) {
	var input reviewBridgeRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxReviewBridgeBody)).Decode(&input); err != nil {
		writeBridgeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	input.ReviewRunID = strings.TrimSpace(input.ReviewRunID)
	input.Verdict = strings.TrimSpace(input.Verdict)
	if input.ReviewRunID == "" || input.Verdict == "" || strings.TrimSpace(input.Body) == "" {
		writeBridgeError(w, http.StatusBadRequest, "reviewRunId, verdict, and body are required")
		return
	}
	response, err := apiClient.submitReview(r.Context(), input.ReviewRunID, worker.SubmitReviewRequest{
		Verdict: input.Verdict,
		Body:    input.Body,
	})
	if err != nil {
		logger.Error("review bridge: submit review failed", "error", err)
		writeBridgeError(w, http.StatusBadGateway, "review could not be submitted: "+err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(response)
}
