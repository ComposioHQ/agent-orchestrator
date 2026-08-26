//go:build linux

package portscan

import (
	"net"
	"os"
	"testing"
)

// The Linux scanner reads live kernel state, so this exercises it against a
// socket the test actually opened rather than a recorded /proc table.
func TestOwnedListenersFindsThisProcessListeningSocket(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	port := listener.Addr().(*net.TCPAddr).Port
	self := os.Getpid()

	found := ownedListeners(t.Context(), []int{self})
	if !containsListener(found, boundPort{PID: self, Port: port}) {
		t.Fatalf("ownedListeners(self) = %#v, want it to contain port %d", found, port)
	}

	// pid 1 is not ours: its descriptors are unreadable for an ordinary user,
	// which must yield nothing rather than leaking this process's port or
	// failing the scan.
	if other := ownedListeners(t.Context(), []int{1}); containsListener(other, boundPort{PID: 1, Port: port}) {
		t.Fatalf("ownedListeners(1) = %#v, want no claim on port %d", other, port)
	}
}

// Detect end to end against live kernel state: a socket this process opened is
// found when scanning from this process, and is invisible when scanning from an
// unrelated root.
func TestDetectFindsAPortUnderTheScannedRoot(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	port := listener.Addr().(*net.TCPAddr).Port

	found := Detect(t.Context(), os.Getpid(), "")
	if !containsPort(found, port) {
		t.Fatalf("Detect(self) = %#v, want it to contain port %d", found, port)
	}

	// Scoping: the test binary spawns nothing, so every port Detect reports for
	// it must be one this process holds. Anything else means the tree walk
	// escaped its root and picked up unrelated software on the machine.
	for _, detected := range found {
		if detected.PID != os.Getpid() {
			t.Fatalf("Detect(self) reported pid %d, which is not this process or a child of it", detected.PID)
		}
	}

	// A root that does not exist owns nothing, so rooting is not a no-op that
	// happens to return everything.
	if orphan := Detect(t.Context(), deadPID, ""); len(orphan) != 0 {
		t.Fatalf("Detect(dead root) = %#v, want none", orphan)
	}
}

// deadPID is above the default pid_max, so no live process can hold it.
const deadPID = 2147483647

func containsPort(found []Detected, port int) bool {
	for _, detected := range found {
		if detected.Port == port {
			return true
		}
	}
	return false
}

func containsListener(found []boundPort, want boundPort) bool {
	for _, entry := range found {
		if entry == want {
			return true
		}
	}
	return false
}
