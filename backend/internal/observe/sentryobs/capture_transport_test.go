package sentryobs

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
)

// recordingTransport is an in-memory sentry.Transport that records every event
// the client sends, synchronously and under a mutex so it is safe under -race.
type recordingTransport struct {
	mu     sync.Mutex
	events []*sentry.Event
}

func (t *recordingTransport) Configure(sentry.ClientOptions) {}
func (t *recordingTransport) SendEvent(event *sentry.Event) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.events = append(t.events, event)
}
func (t *recordingTransport) Flush(time.Duration) bool              { return true }
func (t *recordingTransport) FlushWithContext(context.Context) bool { return true }
func (t *recordingTransport) Close()                                {}

func (t *recordingTransport) snapshot() []*sentry.Event {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]*sentry.Event, len(t.events))
	copy(out, t.events)
	return out
}

// bindRecordingClient wires a client with the recording transport onto the
// process hub and marks sentryobs enabled, restoring both on cleanup. It uses
// the same BeforeSend scrub as Init so captures go through the real pipeline.
func bindRecordingClient(t *testing.T) *recordingTransport {
	t.Helper()
	tr := &recordingTransport{}
	client, err := sentry.NewClient(sentry.ClientOptions{
		Transport:  tr,
		SampleRate: 1.0,
		BeforeSend: func(event *sentry.Event, _ *sentry.EventHint) *sentry.Event {
			return scrubEvent(event)
		},
	})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	prev := sentry.CurrentHub().Client()
	sentry.CurrentHub().BindClient(client)
	enabled.Store(true)
	t.Cleanup(func() {
		enabled.Store(false)
		sentry.CurrentHub().BindClient(prev)
	})
	return tr
}

// TestConcurrentCapturesDoNotShareScope is the regression guard for issue #4352,
// problem 1: package-level sentry.WithScope / CaptureException share one scope
// stack on the global hub, so concurrent captures can interleave and stamp one
// request's request id / fingerprint onto another's event. Each capture now runs
// on its own hub, so every recorded event must carry only its own metadata.
// Run under `go test -race`.
func TestConcurrentCapturesDoNotShareScope(t *testing.T) {
	tr := bindRecordingClient(t)

	const n = 64
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := fmt.Sprintf("req-%03d", i)
			CaptureHTTPError(context.Background(), fmt.Errorf("boom %s", id), map[string]string{
				"request_id": id,
				"operation":  "http_request",
			}, id)
		}(i)
	}
	wg.Wait()

	events := tr.snapshot()
	if len(events) != n {
		t.Fatalf("recorded %d events, want %d", len(events), n)
	}
	seen := make(map[string]int, n)
	for _, ev := range events {
		reqID := ev.Tags["request_id"]
		if reqID == "" {
			t.Fatalf("event missing request_id tag: %+v", ev.Tags)
		}
		// The fingerprint was set to the same id as the request_id tag. If two
		// captures' scopes interleaved, an event would carry one request's id
		// with another's fingerprint.
		if len(ev.Fingerprint) != 1 || ev.Fingerprint[0] != reqID {
			t.Fatalf("event request_id=%q has fingerprint %v, want [%q] (scopes crossed)", reqID, ev.Fingerprint, reqID)
		}
		if ev.Tags["platform"] != "daemon" {
			t.Fatalf("event %q missing platform=daemon tag: %+v", reqID, ev.Tags)
		}
		seen[reqID]++
	}
	if len(seen) != n {
		t.Fatalf("distinct request ids = %d, want %d (events lost or duplicated)", len(seen), n)
	}
	for id, count := range seen {
		if count != 1 {
			t.Fatalf("request id %q captured %d times, want 1", id, count)
		}
	}
}

// TestCaptureHTTPErrorScrubsThroughTransport confirms the enabled capture path
// scrubs a local path from the message before it reaches the transport (not just
// in the pure scrub helper).
func TestCaptureHTTPErrorScrubsThroughTransport(t *testing.T) {
	tr := bindRecordingClient(t)
	CaptureHTTPError(context.Background(), fmt.Errorf("open /Users/secret/x.go: denied"),
		map[string]string{"request_id": "r1"}, "fp")
	events := tr.snapshot()
	if len(events) != 1 {
		t.Fatalf("recorded %d events, want 1", len(events))
	}
	for _, ex := range events[0].Exception {
		if strings.Contains(ex.Value, "/Users/secret") {
			t.Fatalf("exception value leaked local path: %q", ex.Value)
		}
	}
}
