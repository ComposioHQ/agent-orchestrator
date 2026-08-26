//go:build !windows

package cli

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type failingTerminalWriter struct{ written bool }

func (w *failingTerminalWriter) Write(p []byte) (int, error) {
	if !w.written {
		w.written = true
		return min(3, len(p)), nil
	}
	return 0, errors.New("terminal closed")
}

func TestAgentProcessSuperviseReportsExitAndPreservesOutput(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, capture := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	out, errOut, err := executeCLI(t, Deps{
		In:           strings.NewReader(""),
		ProcessAlive: func(int) bool { return true },
	}, "agent-process", "supervise", "--session", "ao-7", "--launch", "launch-3", "--", "sh", "-c", "printf supervised; exit 23")
	if err != nil {
		t.Fatalf("supervise returned child exit as command failure: %v\nstderr=%s", err, errOut)
	}
	if out != "supervised" {
		t.Fatalf("stdout = %q, want supervised", out)
	}
	var req setActivityAPIRequest
	if err := json.Unmarshal([]byte(capture.body), &req); err != nil {
		t.Fatal(err)
	}
	want := setActivityAPIRequest{State: "exited", Event: "process-exited", LaunchID: "launch-3"}
	if req != want {
		t.Fatalf("exit report = %+v, want %+v", req, want)
	}
}

func TestAgentProcessSupervisePrintsAndRemovesTerminalHistory(t *testing.T) {
	cfg := setConfigEnv(t)
	srv, _ := activityServer(t, http.StatusOK, `{"ok":true}`)
	writeRunFileFor(t, cfg, srv)

	historyPath := filepath.Join(t.TempDir(), "history.txt")
	if err := os.WriteFile(historyPath, []byte("Previous conversation\n\nYou\nhello\n\nCursor\nhi\n\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	out, errOut, err := executeCLI(t, Deps{
		In:           strings.NewReader(""),
		ProcessAlive: func(int) bool { return true },
	}, "agent-process", "supervise", "--session", "ao-7", "--launch", "launch-3",
		"--terminal-history", historyPath, "--", "sh", "-c", "printf cursor-started")
	if err != nil {
		t.Fatalf("supervise returned error: %v\nstderr=%s", err, errOut)
	}
	if want := "Previous conversation\n\nYou\nhello\n\nCursor\nhi\n\ncursor-started"; out != want {
		t.Fatalf("stdout = %q, want %q", out, want)
	}
	if _, err := os.Stat(historyPath); !os.IsNotExist(err) {
		t.Fatalf("terminal history file still exists after rendering: %v", err)
	}
}

func TestRenderTerminalHistoryRetainsArtifactWhenTerminalWriteFails(t *testing.T) {
	historyPath := filepath.Join(t.TempDir(), "history.txt")
	if err := os.WriteFile(historyPath, []byte("previous conversation"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := renderTerminalHistory(&failingTerminalWriter{}, historyPath); err == nil {
		t.Fatal("terminal write failure was ignored")
	}
	if _, err := os.Stat(historyPath); err != nil {
		t.Fatalf("history artifact was removed before a complete terminal write: %v", err)
	}
}

func TestAgentProcessSuperviseRejectsInvalidGeneration(t *testing.T) {
	_, _, err := executeCLI(t, Deps{}, "agent-process", "supervise", "--session", "ao-7", "--launch", "../stale", "--", "true")
	if err == nil {
		t.Fatal("invalid launch id should be rejected before starting the child")
	}
}
