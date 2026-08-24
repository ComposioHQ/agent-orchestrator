package httpd

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/getsentry/sentry-go"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/aoagents/agent-orchestrator/backend/internal/observe/sentryobs"
)

// recordingTransport is a synchronous in-memory sentry.Transport used to count
// and inspect the events the SDK actually processes for a request.
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

// enableRecordingSentry enables sentryobs and routes captures to an in-memory
// recording transport, restoring prior state on cleanup.
func enableRecordingSentry(t *testing.T) *recordingTransport {
	t.Helper()
	// A non-empty DSN flips sentryobs on; the client is then replaced so events
	// land in the recording transport instead of going over the network.
	if err := sentryobs.Init(sentryobs.Config{DSN: "http://publickey@127.0.0.1:1/1"}); err != nil {
		t.Fatalf("init sentry: %v", err)
	}
	tr := &recordingTransport{}
	client, err := sentry.NewClient(sentry.ClientOptions{Transport: tr, SampleRate: 1.0})
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	prev := sentry.CurrentHub().Client()
	sentry.CurrentHub().BindClient(client)
	t.Cleanup(func() {
		sentry.CurrentHub().BindClient(prev)
		sentryobs.Disable()
	})
	return tr
}

// TestPanicCapturedExactlyOnce is the regression guard for issue #4352,
// problem 2: the recover middleware captures a panic (fatal, with the Go stack
// and request id), then the outer 5xx logger observes the resulting 500 and
// would manufacture a second generic "HTTP 500" event with a different
// fingerprint. Recovery now marks the request captured so the logger skips it.
// Exactly one event must be captured, and it must be the panic event.
func TestPanicCapturedExactlyOnce(t *testing.T) {
	tr := enableRecordingSentry(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	// Same order as router.go: RequestID (so a request id exists) → requestLogger
	// (outer) → recoverTelemetry (inner) → handler.
	handler := middleware.RequestID(requestLogger(log, nil)(recoverTelemetry(log, nil)(
		http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
			panic("kaboom from handler")
		}),
	)))

	resp := httptest.NewRecorder()
	handler.ServeHTTP(resp, httptest.NewRequest(http.MethodPost, "/api/v1/sessions/x/kill", nil))
	if resp.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", resp.Code)
	}

	events := tr.snapshot()
	if len(events) != 1 {
		t.Fatalf("captured %d Sentry events, want exactly 1", len(events))
	}
	ev := events[0]
	if ev.Level != sentry.LevelFatal {
		t.Fatalf("event level = %q, want fatal (the panic event, not the generic 500)", ev.Level)
	}
	if len(ev.Exception) == 0 || !strings.Contains(ev.Exception[0].Value, "panic: kaboom from handler") {
		t.Fatalf("event does not carry the panic value: %+v", ev.Exception)
	}
	if _, ok := ev.Contexts["runtime"]; !ok {
		t.Fatalf("event missing the Go stack (runtime context): %+v", ev.Contexts)
	}
	if ev.Tags["request_id"] == "" {
		t.Fatalf("event missing request_id tag: %+v", ev.Tags)
	}
	if ev.Tags["operation"] != "http_request_panic" {
		t.Fatalf("event operation tag = %q, want http_request_panic", ev.Tags["operation"])
	}
}

// TestNonPanic5xxStillCaptured confirms the dedup marker does not suppress the
// ordinary path: a handler that writes a 500 via envelope.WriteError (no panic,
// so recovery never runs) is still captured once by the 5xx logger seam.
func TestNonPanic5xxStillCaptured(t *testing.T) {
	tr := enableRecordingSentry(t)
	log := slog.New(slog.NewTextHandler(io.Discard, nil))

	handler := middleware.RequestID(requestLogger(log, nil)(recoverTelemetry(log, nil)(
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusInternalServerError)
		}),
	)))
	resp := httptest.NewRecorder()
	handler.ServeHTTP(resp, httptest.NewRequest(http.MethodGet, "/api/v1/x", nil))

	events := tr.snapshot()
	if len(events) != 1 {
		t.Fatalf("captured %d events for a plain 500, want exactly 1", len(events))
	}
	if events[0].Level != sentry.LevelError {
		t.Fatalf("plain 500 event level = %q, want error", events[0].Level)
	}
}

// TestTyped503CapturePolicy is the regression guard for issue #4352, problem 3:
// only the deliberate SERVICE_UNAVAILABLE backpressure 503 is suppressed; other
// typed 503 outages are captured.
func TestTyped503CapturePolicy(t *testing.T) {
	cases := []struct {
		code     string
		captured bool
	}{
		{code: "SERVICE_UNAVAILABLE", captured: false},
		{code: "SCM_UNAVAILABLE", captured: true},
		{code: "BROWSER_RUNTIME_UNAVAILABLE", captured: true},
		{code: "DEVICE_REGISTRY_UNAVAILABLE", captured: true},
	}
	for _, tc := range cases {
		t.Run(tc.code, func(t *testing.T) {
			if got := sentryobs.ShouldCapture(http.StatusServiceUnavailable, tc.code); got != tc.captured {
				t.Fatalf("ShouldCapture(503, %q) = %v, want %v", tc.code, got, tc.captured)
			}
		})
	}
}
