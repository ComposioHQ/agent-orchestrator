package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestVerifyHarnessAvailable(t *testing.T) {
	directory := t.TempDir()
	for _, binary := range []string{"claude", "codex", "cursor-agent"} {
		if err := os.WriteFile(
			filepath.Join(directory, binary),
			[]byte("#!/bin/sh\nexit 0\n"),
			0o700,
		); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", directory)

	for _, harness := range []string{"claude-code", "codex", "cursor"} {
		if err := verifyHarnessAvailable(harness); err != nil {
			t.Fatalf("verify %s: %v", harness, err)
		}
	}
}

func TestVerifyHarnessAvailableFailsClosed(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	if err := verifyHarnessAvailable("claude-code"); err == nil ||
		!strings.Contains(err.Error(), "unavailable") {
		t.Fatalf("missing binary error = %v", err)
	}
	if err := verifyHarnessAvailable("other"); err == nil ||
		!strings.Contains(err.Error(), "unsupported") {
		t.Fatalf("unknown harness error = %v", err)
	}
}

func TestCheckoutRenewalLoopSkipsScratchWorkspaces(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))

	done := make(chan error, 1)
	go func() {
		done <- (&client{}).checkoutRenewalLoop(
			ctx, logger, t.TempDir(), "https://scratch.ao.local/abc",
		)
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("checkoutRenewalLoop() error = %v, want nil", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("checkoutRenewalLoop did not return promptly for a scratch workspace with a cancelled context")
	}
}

func TestCheckoutRenewalLoopRenewsOnTick(t *testing.T) {
	original := checkoutRenewalInterval
	checkoutRenewalInterval = 5 * time.Millisecond
	t.Cleanup(func() { checkoutRenewalInterval = original })

	var grantRequests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/worker/checkout-grant" {
			http.NotFound(w, r)
			return
		}
		grantRequests.Add(1)
		// Deliberately not a real GitHub URL: PrepareCheckout rejects it at
		// validation, before running any real git command, so this test stays
		// fast, local, and network-free while still proving the loop actually
		// asked for a fresh grant.
		_ = json.NewEncoder(w).Encode(map[string]any{"cloneUrl": "not-a-real-github-url"})
	}))
	defer server.Close()

	c := &client{baseURL: server.URL, http: &http.Client{Timeout: time.Second}}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan error, 1)
	go func() {
		done <- c.checkoutRenewalLoop(ctx, logger, t.TempDir(), "https://github.com/acme/repo")
	}()

	deadline := time.After(2 * time.Second)
	for grantRequests.Load() == 0 {
		select {
		case <-deadline:
			cancel()
			<-done
			t.Fatal("checkout renewal loop never requested a fresh grant on tick")
		case <-time.After(10 * time.Millisecond):
		}
	}
	cancel()
	<-done
}
