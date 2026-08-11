package androidemulator

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestHelperProcess isn't a real test -- it's the subprocess entry point the
// other tests in this file spawn (via SpawnConfig.Command = os.Args[0]),
// following the standard Go os/exec testing pattern (see os/exec's own
// TestHelperProcess) so process supervision is exercised for real without
// depending on a real emulator binary being present.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("AO_WANT_HELPER_PROCESS") != "1" {
		return
	}
	defer os.Exit(0)
	switch os.Getenv("AO_HELPER_MODE") {
	case "print-lines-and-exit":
		os.Stdout.WriteString("line one\n")
		os.Stdout.WriteString("line two\n")
		os.Exit(0)
	case "print-env-and-exit":
		os.Stdout.WriteString("AO_TEST_VAR=" + os.Getenv("AO_TEST_VAR") + "\n")
		os.Exit(0)
	case "exit-nonzero":
		os.Exit(3)
	case "sleep":
		time.Sleep(10 * time.Second)
		os.Exit(0)
	case "crash-once-then-sleep":
		marker := os.Getenv("AO_CRASH_MARKER")
		if _, err := os.Stat(marker); err != nil {
			_ = os.WriteFile(marker, []byte("crashed"), 0o644)
			os.Exit(1)
		}
		time.Sleep(10 * time.Second)
		os.Exit(0)
	}
}

func helperSpawnConfig(mode string, extraEnv ...string) SpawnConfig {
	return SpawnConfig{
		Command: os.Args[0],
		Args:    []string{"-test.run=TestHelperProcess"},
		Env: append([]string{
			"AO_WANT_HELPER_PROCESS=1",
			"AO_HELPER_MODE=" + mode,
		}, extraEnv...),
	}
}

func TestSpawnCapturesStdoutIntoLogBuffer(t *testing.T) {
	p, err := Spawn(helperSpawnConfig("print-lines-and-exit"))
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	_ = p.Wait()

	logs := strings.Join(p.Logs(10), "\n")
	if !strings.Contains(logs, "line one") || !strings.Contains(logs, "line two") {
		t.Errorf("Logs() = %q, want it to contain both lines", logs)
	}
}

func TestSpawnPassesEnvironmentToChild(t *testing.T) {
	p, err := Spawn(helperSpawnConfig("print-env-and-exit", "AO_TEST_VAR=hello-from-parent"))
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	_ = p.Wait()

	logs := strings.Join(p.Logs(10), "\n")
	if !strings.Contains(logs, "AO_TEST_VAR=hello-from-parent") {
		t.Errorf("Logs() = %q, want the child to have seen AO_TEST_VAR", logs)
	}
}

func TestWaitReturnsErrorOnNonzeroExit(t *testing.T) {
	p, err := Spawn(helperSpawnConfig("exit-nonzero"))
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if err := p.Wait(); err == nil {
		t.Error("Wait() = nil, want an error for a nonzero exit")
	}
}

func TestKillStopsARunningProcess(t *testing.T) {
	p, err := Spawn(helperSpawnConfig("sleep"))
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	if err := p.Kill(); err != nil {
		t.Fatalf("Kill: %v", err)
	}

	done := make(chan struct{})
	go func() {
		_ = p.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("process did not exit within 5s of Kill")
	}
}

func TestWaitIsSafeForConcurrentCallers(t *testing.T) {
	// Both Manager.Stop and the crash-watcher goroutine may call Wait on the
	// same Process concurrently; exec.Cmd.Wait itself isn't documented as
	// safe for that, so Process must memoize the result.
	p, err := Spawn(helperSpawnConfig("print-lines-and-exit"))
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}

	const n = 10
	errs := make([]error, n)
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			errs[i] = p.Wait()
		}(i)
	}
	wg.Wait()

	for i := 1; i < n; i++ {
		if (errs[i] == nil) != (errs[0] == nil) {
			t.Errorf("Wait() call %d returned %v, want consistent with call 0's %v", i, errs[i], errs[0])
		}
	}
}

func TestSpawnUsesProvidedContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cfg := helperSpawnConfig("sleep")
	cfg.Ctx = ctx
	p, err := Spawn(cfg)
	if err != nil {
		t.Fatalf("Spawn: %v", err)
	}
	cancel()

	done := make(chan struct{})
	go func() {
		_ = p.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("process did not exit within 5s of context cancellation")
	}
}
