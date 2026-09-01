//go:build linux

package conpty

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/creack/pty"
)

// TestMain lets the detached-spawn integration test re-exec this test binary
// through the same hidden pty-host entrypoint used by the production AO binary.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "pty-host" {
		os.Exit(RunHost(os.Args[2:], os.Stdout))
	}
	os.Exit(m.Run())
}

func TestLinuxPTYConnStreamsResizesAndReportsExit(t *testing.T) {
	conn, err := newConPTY(t.TempDir(), "/bin/sh", []string{
		"-c", `printf 'ready\n'; IFS= read -r line; printf 'received:%s\n' "$line"; exit 7`,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	linuxConn, ok := conn.(*linuxPTYConn)
	if !ok {
		t.Fatalf("connection type = %T", conn)
	}
	if err := conn.Resize(101, 43); err != nil {
		t.Fatalf("Resize: %v", err)
	}
	size, err := pty.GetsizeFull(linuxConn.pty)
	if err != nil {
		t.Fatalf("GetsizeFull: %v", err)
	}
	if size.Cols != 101 || size.Rows != 43 {
		t.Fatalf("PTY size = %dx%d, want 101x43", size.Cols, size.Rows)
	}
	if err := conn.Resize(70_000, 43); err == nil {
		t.Fatal("Resize accepted a column count that overflows the Linux winsize")
	}

	outputC := make(chan []byte, 1)
	go func() {
		var output bytes.Buffer
		_, _ = io.Copy(&output, conn)
		outputC <- output.Bytes()
	}()
	if _, err := conn.Write([]byte("hello\n")); err != nil {
		t.Fatalf("Write: %v", err)
	}

	select {
	case <-conn.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("PTY child did not exit")
	}
	code, exited := conn.ExitCode()
	if !exited || code != 7 {
		t.Fatalf("ExitCode = (%d, %v), want (7, true)", code, exited)
	}

	select {
	case output := <-outputC:
		text := strings.ReplaceAll(string(output), "\r", "")
		if !strings.Contains(text, "ready\n") || !strings.Contains(text, "received:hello\n") {
			t.Fatalf("PTY output = %q", text)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("PTY output reader did not finish")
	}
}

func TestLinuxDefaultSpawnHostEndToEnd(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	addr, hostPID, err := defaultSpawnHost(ctx, "spawn-e2e", t.TempDir(), []string{
		"env", "AO_PREFIX_VALUE=prefix", "/bin/sh", "-c",
		`printf '\033[c'; sleep 0.05; printf 'ready:%s:%s\n' "$AO_DIRECT_PTY_TEST" "$AO_PREFIX_VALUE"; IFS= read -r line; printf 'received:%s\n' "$line"; sleep 30`,
	}, map[string]string{"AO_DIRECT_PTY_TEST": "works"})
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	// The request context owns startup only. A host that reported READY must
	// stay alive after that request ends so daemon restarts cannot kill agents.
	cancel()
	t.Cleanup(func() {
		_ = clientKill(addr)
		if pidAlive(hostPID) {
			if process, findErr := os.FindProcess(hostPID); findErr == nil {
				_ = process.Kill()
			}
		}
	})

	if err := clientSendInput(addr, "hello\n"); err != nil {
		t.Fatalf("send input: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		output, outputErr := clientGetOutput(context.Background(), addr, 20)
		if outputErr != nil {
			t.Fatalf("get output: %v", outputErr)
		}
		text := strings.ReplaceAll(output, "\r", "")
		if strings.Contains(text, "ready:works:prefix") && strings.Contains(text, "received:hello") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for host output: %q", text)
		}
		time.Sleep(10 * time.Millisecond)
	}

	if err := clientKill(addr); err != nil {
		t.Fatalf("kill host: %v", err)
	}
	deadline = time.Now().Add(3 * time.Second)
	for pidAlive(hostPID) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if pidAlive(hostPID) {
		t.Fatalf("detached pty-host pid %d survived kill", hostPID)
	}
}

func TestLinuxPTYCloseReapsTermIgnoringProcessGroup(t *testing.T) {
	conn, err := newConPTY(t.TempDir(), "/bin/sh", []string{
		"-c", `trap '' TERM; (trap '' TERM; printf 'child-ready\n'; sleep 30) & wait`,
	})
	if err != nil {
		t.Fatal(err)
	}
	linuxConn, ok := conn.(*linuxPTYConn)
	if !ok {
		t.Fatalf("connection type = %T", conn)
	}
	leaderPID := linuxConn.leaderPID
	leaderStartTime := linuxConn.leaderStartTime
	if !linuxSessionAlive(leaderPID, leaderStartTime) {
		t.Fatalf("session %d was not alive after launch", leaderPID)
	}
	ready := make([]byte, 128)
	n, err := conn.Read(ready)
	if err != nil || !strings.Contains(string(ready[:n]), "child-ready") {
		t.Fatalf("waiting for process-group fixture readiness: output=%q err=%v", ready[:n], err)
	}

	if err := conn.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for linuxSessionAlive(leaderPID, leaderStartTime) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if linuxSessionAlive(leaderPID, leaderStartTime) {
		t.Fatalf("session %d survived PTY close", leaderPID)
	}
}

func TestLinuxPTYCloseReapsOrphanedBackgroundJobWhenLeaderExitsEarly(t *testing.T) {
	conn, err := newConPTY(t.TempDir(), "/bin/sh", []string{
		"-c", `printf 'bg-ready\n'; (trap '' HUP; sleep 30) & sleep 0.05; exit 0`,
	})
	if err != nil {
		t.Fatal(err)
	}
	linuxConn, ok := conn.(*linuxPTYConn)
	if !ok {
		t.Fatalf("connection type = %T", conn)
	}
	leaderPID := linuxConn.leaderPID
	leaderStartTime := linuxConn.leaderStartTime

	ready := make([]byte, 128)
	n, err := conn.Read(ready)
	if err != nil || !strings.Contains(string(ready[:n]), "bg-ready") {
		t.Fatalf("waiting for background job readiness: output=%q err=%v", ready[:n], err)
	}

	select {
	case <-conn.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("leader process did not exit early as expected")
	}

	if !linuxSessionAlive(leaderPID, leaderStartTime) {
		t.Fatalf("session %d had no live background processes after leader exit", leaderPID)
	}

	if err := conn.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for linuxSessionAlive(leaderPID, leaderStartTime) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if linuxSessionAlive(leaderPID, leaderStartTime) {
		t.Fatalf("orphaned background process in session %d survived PTY close", leaderPID)
	}
}

func TestLinuxPTYCloseReapsDescendantWithOwnProcessGroup(t *testing.T) {
	conn, err := newConPTY(t.TempDir(), "/bin/bash", []string{
		"-c", `set -m; (trap '' TERM HUP; printf 'pg-child-ready\n'; sleep 30) & wait`,
	})
	if err != nil {
		t.Fatal(err)
	}
	linuxConn, ok := conn.(*linuxPTYConn)
	if !ok {
		t.Fatalf("connection type = %T", conn)
	}
	leaderPID := linuxConn.leaderPID
	leaderStartTime := linuxConn.leaderStartTime

	ready := make([]byte, 128)
	n, err := conn.Read(ready)
	if err != nil || !strings.Contains(string(ready[:n]), "pg-child-ready") {
		t.Fatalf("waiting for job-control descendant readiness: output=%q err=%v", ready[:n], err)
	}

	procs := linuxFindSessionProcesses(leaderPID, leaderStartTime)
	foundSeparatePGID := false
	for _, p := range procs {
		if p.pgrp != leaderPID {
			foundSeparatePGID = true
			break
		}
	}
	if !foundSeparatePGID {
		t.Fatalf("expected at least one process with distinct pgid in session %d, found: %+v", leaderPID, procs)
	}

	if err := conn.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for linuxSessionAlive(leaderPID, leaderStartTime) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if linuxSessionAlive(leaderPID, leaderStartTime) {
		t.Fatalf("descendant with separate process group in session %d survived PTY close", leaderPID)
	}
}

func TestLinuxPTYCloseDoesNotKillUnrelatedProcessAfterPIDReuse(t *testing.T) {
	// Start an independent dummy process representing an unrelated process running on the host.
	dummy := exec.Command("/bin/sh", "-c", "sleep 30")
	if err := dummy.Start(); err != nil {
		t.Fatal(err)
	}
	dummyPID := dummy.Process.Pid
	t.Cleanup(func() {
		if dummy.Process != nil {
			_ = dummy.Process.Kill()
			_ = dummy.Wait()
		}
	})

	dummyInfo, err := readLinuxProcInfo(dummyPID)
	if err != nil {
		t.Fatalf("reading dummy proc info: %v", err)
	}

	// Create a simulated linuxPTYConn whose leaderPID matches dummyPID,
	// but whose recorded leaderStartTime is from an earlier epoch (simulating a recycled PID).
	conn := &linuxPTYConn{
		leaderPID:       dummyPID,
		leaderStartTime: dummyInfo.startTime - 1000, // mismatch: earlier time
		doneC:           make(chan struct{}),
	}
	close(conn.doneC)

	// Close() must detect the start-time mismatch and send NO signals to dummyPID.
	if err := conn.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Verify the dummy process is still running and unharmed.
	if !pidAlive(dummyPID) {
		t.Fatalf("unrelated process %d was killed by Close() despite PID identity mismatch", dummyPID)
	}
}

func TestLinuxPTYCloseDelayedAfterFullSessionExit(t *testing.T) {
	conn, err := newConPTY(t.TempDir(), "/bin/sh", []string{
		"-c", `printf 'done\n'; exit 0`,
	})
	if err != nil {
		t.Fatal(err)
	}
	linuxConn, ok := conn.(*linuxPTYConn)
	if !ok {
		t.Fatalf("connection type = %T", conn)
	}
	leaderPID := linuxConn.leaderPID

	ready := make([]byte, 128)
	n, err := conn.Read(ready)
	if err != nil || !strings.Contains(string(ready[:n]), "done") {
		t.Fatalf("waiting for exit: output=%q err=%v", ready[:n], err)
	}

	select {
	case <-conn.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("process did not exit")
	}

	// Ensure the leader process has exited
	deadline := time.Now().Add(2 * time.Second)
	for pidAlive(leaderPID) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}

	// Delayed close on an already fully-dead session must succeed cleanly without error.
	if err := conn.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestLinuxPTYCloseFailsClosedWhenLeaderStartTimeIsZero(t *testing.T) {
	// Start an independent dummy process representing an innocent process on the host.
	dummy := exec.Command("/bin/sh", "-c", "sleep 30")
	if err := dummy.Start(); err != nil {
		t.Fatal(err)
	}
	dummyPID := dummy.Process.Pid
	t.Cleanup(func() {
		if dummy.Process != nil {
			_ = dummy.Process.Kill()
			_ = dummy.Wait()
		}
	})

	// Create a simulated linuxPTYConn whose leaderPID matches dummyPID,
	// but whose recorded leaderStartTime is 0 (simulating failed identity capture).
	conn := &linuxPTYConn{
		leaderPID:       dummyPID,
		leaderStartTime: 0, // identity unavailable: must fail closed
		doneC:           make(chan struct{}),
	}
	close(conn.doneC)

	// Close() must fail closed: send NO signals to dummyPID or its process group.
	if err := conn.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Verify the dummy process is still running and unharmed.
	if !pidAlive(dummyPID) {
		t.Fatalf("unrelated process %d was killed by Close() when leaderStartTime was zero", dummyPID)
	}
}
