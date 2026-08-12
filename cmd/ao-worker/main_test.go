package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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
