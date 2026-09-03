package sentryobs

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
)

func TestIsNoiseError(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"plain fault", fmt.Errorf("boom"), false},
		{"canceled", context.Canceled, true},
		{"deadline", context.DeadlineExceeded, true},
		{"wrapped canceled", fmt.Errorf("list prs for x: %w", context.Canceled), true},
		{"wrapped deadline", fmt.Errorf("skills/list: %w", context.DeadlineExceeded), true},
		{"deep wrap", fmt.Errorf("a: %w", fmt.Errorf("b: %w", context.Canceled)), true},
	}
	for _, c := range cases {
		if got := IsNoiseError(c.err); got != c.want {
			t.Errorf("IsNoiseError(%q) = %v, want %v", c.name, got, c.want)
		}
	}
}

type noiseRecordingTransport struct {
	mu     sync.Mutex
	events []*sentry.Event
}

func (t *noiseRecordingTransport) Configure(sentry.ClientOptions) {}
func (t *noiseRecordingTransport) SendEvent(e *sentry.Event) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.events = append(t.events, e)
}
func (t *noiseRecordingTransport) Flush(time.Duration) bool              { return true }
func (t *noiseRecordingTransport) FlushWithContext(context.Context) bool { return true }
func (t *noiseRecordingTransport) Close()                                {}

// TestCaptureHTTPErrorDropsCancellationNoise drives the enabled capture path
// through a recording transport and asserts that context-cancellation errors
// (the dominant, un-actionable churn in the feed) are dropped while a genuine
// fault still reaches the wire.
func TestCaptureHTTPErrorDropsCancellationNoise(t *testing.T) {
	tr := &noiseRecordingTransport{}
	client, err := sentry.NewClient(sentry.ClientOptions{Transport: tr, SampleRate: 1.0})
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

	ctx := context.Background()
	CaptureHTTPError(ctx, fmt.Errorf("list prs for autoads-2: %w", context.Canceled), map[string]string{"path": "/x"}, "fp1")
	CaptureHTTPError(ctx, fmt.Errorf("skills/list: %w", context.DeadlineExceeded), map[string]string{"path": "/y"}, "fp2")
	CaptureHTTPError(ctx, context.DeadlineExceeded, map[string]string{"path": "/z"}, "fp3")

	tr.mu.Lock()
	afterNoise := len(tr.events)
	tr.mu.Unlock()
	if afterNoise != 0 {
		t.Fatalf("cancellation noise produced %d events, want 0", afterNoise)
	}

	CaptureHTTPError(ctx, fmt.Errorf("aggregate usage: no such table: openai_usage_event_details"), map[string]string{"path": "/u"}, "fp4")
	tr.mu.Lock()
	afterReal := len(tr.events)
	tr.mu.Unlock()
	if afterReal != 1 {
		t.Fatalf("genuine fault produced %d events, want 1", afterReal)
	}
}
