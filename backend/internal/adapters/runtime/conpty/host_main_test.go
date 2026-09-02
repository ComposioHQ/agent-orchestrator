package conpty

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestPTYHostIdentityRequiresTokenOutsideRestartE2E(t *testing.T) {
	t.Setenv(runtimeHostTokenEnv, "")
	t.Setenv(restartContinuityE2EEnv, "1")
	t.Setenv(legacyPTYV2E2EEnv, "")
	if _, _, err := ptyHostIdentityFromEnvironment(); err == nil {
		t.Fatal("one restart-E2E selector allowed a tokenless pty-host")
	}
}

func TestPTYHostIdentityAllowsTokenlessProtocolV2OnlyForRestartE2E(t *testing.T) {
	t.Setenv(runtimeHostTokenEnv, "")
	t.Setenv(restartContinuityE2EEnv, "1")
	t.Setenv(legacyPTYV2E2EEnv, "1")
	token, legacyV2, err := ptyHostIdentityFromEnvironment()
	if err != nil || token != "" || !legacyV2 {
		t.Fatalf("ptyHostIdentityFromEnvironment = token %q legacy=%v err=%v", token, legacyV2, err)
	}

	scrubPTYHostIdentityEnvironment()
	if got := os.Getenv(legacyPTYV2E2EEnv); got != "" {
		t.Fatalf("legacy selector leaked to child environment: %q", got)
	}
	if got := os.Getenv(restartContinuityE2EEnv); got != "" {
		t.Fatalf("outer restart-E2E selector leaked to child environment: %q", got)
	}
}

func TestPTYHostIdentityTokenAlwaysSelectsAuthenticatedProtocol(t *testing.T) {
	t.Setenv(runtimeHostTokenEnv, "token-1")
	t.Setenv(restartContinuityE2EEnv, "1")
	t.Setenv(legacyPTYV2E2EEnv, "1")
	token, legacyV2, err := ptyHostIdentityFromEnvironment()
	if err != nil || token != "token-1" || legacyV2 {
		t.Fatalf("ptyHostIdentityFromEnvironment = token %q legacy=%v err=%v", token, legacyV2, err)
	}
}

func TestRunHostRejectsMissingWorkingDirectory(t *testing.T) {
	t.Setenv(runtimeHostTokenEnv, "host-main-test-token")
	missing := filepath.Join(t.TempDir(), "missing")
	code := RunHost([]string{"sess-1", missing, "agent.exe"}, io.Discard)
	if code != 1 {
		t.Fatalf("RunHost code = %d, want 1", code)
	}
}
