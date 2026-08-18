package androidemulator

import (
	"context"
	"sync"
	"time"
)

// FrameSource captures a single frame, typically EmulatorClient.Screenshot.
type FrameSource func(ctx context.Context) ([]byte, error)

// FrameRelay polls a FrameSource at a fixed interval while at least one
// subscriber is attached, fanning each captured frame out to every current
// subscriber. One shared poll loop serves any number of concurrent viewers
// (e.g. the inline panel and a popped-out window both watching the same
// shared device) rather than each viewer re-polling the emulator
// independently -- avoiding redundant gRPC calls per extra viewer.
type FrameRelay struct {
	source   FrameSource
	interval time.Duration

	mu          sync.Mutex
	subscribers map[chan []byte]struct{}
	pollCancel  context.CancelFunc
}

// NewFrameRelay builds a relay around source, polling at interval while
// subscribed.
func NewFrameRelay(source FrameSource, interval time.Duration) *FrameRelay {
	return &FrameRelay{
		source:      source,
		interval:    interval,
		subscribers: make(map[chan []byte]struct{}),
	}
}

// Subscribe registers a new frame channel, starting the shared poll loop if
// this is the first subscriber. The channel is buffered 1: a slow consumer
// simply sees the latest frame rather than a growing backlog, which is the
// right behavior for a live view (an intermediate stale frame is worthless
// once a newer one exists). The returned unsubscribe func must be called
// (typically via defer) when the caller is done watching.
func (r *FrameRelay) Subscribe() (frames <-chan []byte, unsubscribe func()) {
	ch := make(chan []byte, 1)

	r.mu.Lock()
	r.subscribers[ch] = struct{}{}
	if len(r.subscribers) == 1 {
		ctx, cancel := context.WithCancel(context.Background())
		r.pollCancel = cancel
		go r.pollLoop(ctx)
	}
	r.mu.Unlock()

	var once sync.Once
	unsub := func() {
		once.Do(func() {
			r.mu.Lock()
			delete(r.subscribers, ch)
			if len(r.subscribers) == 0 && r.pollCancel != nil {
				r.pollCancel()
				r.pollCancel = nil
			}
			r.mu.Unlock()
		})
	}
	return ch, unsub
}

func (r *FrameRelay) pollLoop(ctx context.Context) {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			frame, err := r.source(ctx)
			if err != nil {
				// Transient capture failures (e.g. the emulator briefly busy)
				// shouldn't tear down the relay -- just skip this tick and
				// let the next one try again.
				continue
			}
			r.broadcast(frame)
		}
	}
}

func (r *FrameRelay) broadcast(frame []byte) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for ch := range r.subscribers {
		select {
		case ch <- frame:
		default:
			// Consumer hasn't drained the previous frame; drop it and
			// deliver the new one instead of blocking the whole relay on one
			// slow subscriber.
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- frame:
			default:
			}
		}
	}
}
