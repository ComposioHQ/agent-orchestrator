//go:build darwin

package conpty

import (
	"context"
	"os"
	"strconv"
	"testing"
)

// TestDarwinLegacyIdentityExternal is an opt-in upgrade probe for an actual
// protocol-v2 host left alive by a released desktop build. It is read-only:
// the test sends STATUS_REQ and verifies OS identity without terminal input or
// teardown.
func TestDarwinLegacyIdentityExternal(t *testing.T) {
	pidText := os.Getenv("AO_TEST_LEGACY_PTY_PID")
	if pidText == "" {
		t.Skip("set AO_TEST_LEGACY_PTY_* to probe a released protocol-v2 host")
	}
	pid, err := strconv.Atoi(pidText)
	if err != nil {
		t.Fatal(err)
	}
	sess := &hostSession{
		sessionID:    os.Getenv("AO_TEST_LEGACY_PTY_SESSION"),
		addr:         os.Getenv("AO_TEST_LEGACY_PTY_ADDR"),
		pid:          pid,
		launchID:     os.Getenv("AO_TEST_LEGACY_PTY_LAUNCH"),
		registeredAt: os.Getenv("AO_TEST_LEGACY_PTY_REGISTERED_AT"),
	}
	runtime := New(Options{})
	runtime.pidIsAlive = func(candidate int) bool { return candidate == pid }
	host, alive, err := runtime.connectVerifiedHost(context.Background(), sess, isAliveTimeout)
	if host != nil {
		_ = host.conn.Close()
	}
	if err != nil || !alive {
		t.Fatalf("released protocol-v2 host = (%v, %v), want authenticated alive", alive, err)
	}
}
