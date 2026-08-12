package workerexec

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOSRunnerStreamsBoundedFakeBinaryOutput(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "fake-agent")
	if err := os.WriteFile(
		binary,
		[]byte("#!/bin/sh\nprintf 'hello stdout'\nprintf 'hello stderr' >&2\n"),
		0o700,
	); err != nil {
		t.Fatal(err)
	}
	var output []Output
	err := (OSRunner{}).Run(
		context.Background(),
		Command{Path: binary, Dir: t.TempDir()},
		func(chunk Output) error {
			if len(chunk.Text) > outputChunkSize {
				t.Fatalf("chunk length = %d", len(chunk.Text))
			}
			output = append(output, chunk)
			return nil
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	var stdout, stderr string
	for _, chunk := range output {
		if chunk.Stream == "stdout" {
			stdout += chunk.Text
		} else if chunk.Stream == "stderr" {
			stderr += chunk.Text
		}
	}
	if stdout != "hello stdout" || stderr != "hello stderr" {
		t.Fatalf("output = stdout %q, stderr %q", stdout, stderr)
	}
}

func TestOSRunnerCancelsFakeBinary(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "fake-agent")
	if err := os.WriteFile(binary, []byte("#!/bin/sh\nwhile :; do :; done\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	err := (OSRunner{}).Run(ctx, Command{Path: binary, Dir: t.TempDir()}, func(Output) error {
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "coding agent exited") {
		t.Fatalf("cancellation error = %v", err)
	}
	if time.Since(started) > 2*time.Second {
		t.Fatal("fake binary did not stop promptly")
	}
}
