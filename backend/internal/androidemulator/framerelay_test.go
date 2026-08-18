package androidemulator

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func drainFrame(t *testing.T, ch <-chan []byte, timeout time.Duration) []byte {
	t.Helper()
	select {
	case f := <-ch:
		return f
	case <-time.After(timeout):
		t.Fatal("timed out waiting for a frame")
		return nil
	}
}

func TestFrameRelaySingleSubscriberReceivesFrames(t *testing.T) {
	relay := NewFrameRelay(func(ctx context.Context) ([]byte, error) {
		return []byte("frame"), nil
	}, 10*time.Millisecond)

	frames, unsub := relay.Subscribe()
	defer unsub()

	got := drainFrame(t, frames, time.Second)
	if string(got) != "frame" {
		t.Errorf("frame = %q, want %q", got, "frame")
	}
}

func TestFrameRelaySharesOnePollLoopAcrossSubscribers(t *testing.T) {
	var calls int64
	relay := NewFrameRelay(func(ctx context.Context) ([]byte, error) {
		atomic.AddInt64(&calls, 1)
		return []byte("frame"), nil
	}, 20*time.Millisecond)

	frames1, unsub1 := relay.Subscribe()
	frames2, unsub2 := relay.Subscribe()
	defer unsub1()
	defer unsub2()

	drainFrame(t, frames1, time.Second)
	drainFrame(t, frames2, time.Second)
	time.Sleep(60 * time.Millisecond) // let a couple more ticks pass

	n := atomic.LoadInt64(&calls)
	// With one shared poll loop, ~3-5 ticks in 60-80ms at a 20ms interval
	// should mean single-digit calls, not one-per-subscriber-per-tick (which
	// would be roughly double). This is a coarse bound, not an exact one, to
	// avoid timing flakiness.
	if n > 10 {
		t.Errorf("source called %d times for 2 subscribers over ~80ms at a 20ms interval, want a shared poll loop (expected roughly 3-5 calls, not one per subscriber per tick)", n)
	}
}

func TestFrameRelayStopsPollingAfterLastUnsubscribe(t *testing.T) {
	var calls int64
	relay := NewFrameRelay(func(ctx context.Context) ([]byte, error) {
		atomic.AddInt64(&calls, 1)
		return []byte("frame"), nil
	}, 10*time.Millisecond)

	frames, unsub := relay.Subscribe()
	drainFrame(t, frames, time.Second)
	unsub()

	afterUnsub := atomic.LoadInt64(&calls)
	time.Sleep(50 * time.Millisecond)
	if got := atomic.LoadInt64(&calls); got != afterUnsub {
		t.Errorf("source called %d more time(s) after the last subscriber unsubscribed, want 0 (poll loop should have stopped)", got-afterUnsub)
	}
}

func TestFrameRelaySourceErrorsDoNotCrashTheRelay(t *testing.T) {
	var calls int64
	relay := NewFrameRelay(func(ctx context.Context) ([]byte, error) {
		n := atomic.AddInt64(&calls, 1)
		if n == 1 {
			return nil, context.DeadlineExceeded // transient failure on the first tick
		}
		return []byte("frame"), nil
	}, 10*time.Millisecond)

	frames, unsub := relay.Subscribe()
	defer unsub()

	got := drainFrame(t, frames, time.Second)
	if string(got) != "frame" {
		t.Errorf("frame = %q, want %q (relay should keep polling past a transient error)", got, "frame")
	}
}
