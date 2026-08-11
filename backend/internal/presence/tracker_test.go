package presence

import (
	"fmt"
	"testing"
	"time"
)

func TestLiveWithinTTLAndExpires(t *testing.T) {
	now := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)
	tr := NewTracker()
	tr.Now = func() time.Time { return now }

	tr.Touch("inst-1")
	if !tr.Live()["inst-1"] {
		t.Fatal("device should be live immediately after Touch")
	}

	now = now.Add(TTL - time.Second)
	if !tr.Live()["inst-1"] {
		t.Fatal("device should still be live just inside the TTL")
	}

	now = now.Add(2 * time.Second) // now just past the TTL
	if tr.Live()["inst-1"] {
		t.Fatal("device should have expired past the TTL")
	}
}

func TestTouchExtendsLiveness(t *testing.T) {
	now := time.Date(2026, 8, 6, 12, 0, 0, 0, time.UTC)
	tr := NewTracker()
	tr.Now = func() time.Time { return now }

	tr.Touch("inst-1")
	now = now.Add(TTL - time.Second)
	tr.Touch("inst-1") // the next poll lands before expiry
	now = now.Add(TTL - time.Second)
	if !tr.Live()["inst-1"] {
		t.Fatal("a second Touch should have extended liveness")
	}
}

func TestEmptyInstallIDIgnored(t *testing.T) {
	tr := NewTracker()
	tr.Touch("")
	if len(tr.Live()) != 0 {
		t.Fatalf("empty install id must not create an entry: %+v", tr.Live())
	}
}

// The install id arrives in a client-supplied header, so a caller cycling ids
// must not grow the tracker without bound on a daemon whose Devices section is
// never opened — i.e. where Live() is never called to sweep.
func TestTouchPrunesWithoutLiveEverBeingCalled(t *testing.T) {
	now := time.Date(2026, 8, 7, 12, 0, 0, 0, time.UTC)
	tr := NewTracker()
	tr.Now = func() time.Time { return now }

	const ids = maxTracked * 2
	for i := 0; i < ids; i++ {
		tr.Touch(fmt.Sprintf("install-%d", i))
		now = now.Add(time.Second)
	}

	if got := tr.Size(); got > maxTracked {
		t.Fatalf("tracker holds %d entries after %d distinct ids, want at most %d", got, ids, maxTracked)
	}
	// The newest id must survive — eviction is oldest-first, not arbitrary.
	newest := fmt.Sprintf("install-%d", ids-1)
	if _, ok := tr.LastSeen(newest); !ok {
		t.Fatalf("eviction dropped the most recent entry %s", newest)
	}
	// The oldest must be the one that went.
	if _, ok := tr.LastSeen("install-0"); ok {
		t.Fatal("eviction kept the oldest entry; it is not oldest-first")
	}
}
