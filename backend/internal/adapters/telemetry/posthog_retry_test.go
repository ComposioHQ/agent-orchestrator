package telemetry

import (
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// newRetryTestSink builds a sink whose HTTP client is driven by respond, which
// receives the 1-based attempt number and returns the response (or error) for
// that attempt. It also returns a pointer to the live attempt counter.
func newRetryTestSink(t *testing.T, respond func(attempt int) (*http.Response, error)) (*PostHogSink, *int) {
	t.Helper()
	attempts := 0
	sink, err := NewPostHogSink(t.TempDir(), "phc_test", "https://example.test", "", "", roundTripClient(func(_ *http.Request) (*http.Response, error) {
		attempts++
		return respond(attempts)
	}), nil)
	if err != nil {
		t.Fatalf("NewPostHogSink: %v", err)
	}
	return sink, &attempts
}

func okResponse() *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody}
}

func statusResponse(code int) *http.Response {
	return &http.Response{StatusCode: code, Body: http.NoBody}
}

func activeEvent() ports.TelemetryEvent {
	return ports.TelemetryEvent{
		Name:       "ao.app.active",
		Source:     "cli",
		OccurredAt: time.Unix(0, 0).UTC(),
		Payload:    map[string]any{"channel": "cli", "actor_type": "user"},
	}
}

func TestPostHogSinkRetriesTransientServerErrorThenSucceeds(t *testing.T) {
	sink, attempts := newRetryTestSink(t, func(attempt int) (*http.Response, error) {
		if attempt == 1 {
			return statusResponse(http.StatusInternalServerError), nil
		}
		return okResponse(), nil
	})
	sink.send(activeEvent())
	if *attempts != 2 {
		t.Fatalf("attempts = %d, want 2 (one 5xx then a successful retry)", *attempts)
	}
}

func TestPostHogSinkRetriesNetworkErrorThenSucceeds(t *testing.T) {
	sink, attempts := newRetryTestSink(t, func(attempt int) (*http.Response, error) {
		if attempt == 1 {
			return nil, fmt.Errorf("connection reset")
		}
		return okResponse(), nil
	})
	sink.send(activeEvent())
	if *attempts != 2 {
		t.Fatalf("attempts = %d, want 2 (one network error then a successful retry)", *attempts)
	}
}

func TestPostHogSinkDoesNotRetryPermanentRejection(t *testing.T) {
	// A 4xx (other than 429) will fail identically on retry, so retrying only
	// wastes a call; it must send exactly once.
	sink, attempts := newRetryTestSink(t, func(_ int) (*http.Response, error) {
		return statusResponse(http.StatusBadRequest), nil
	})
	sink.send(activeEvent())
	if *attempts != 1 {
		t.Fatalf("attempts = %d, want 1 (permanent 4xx must not retry)", *attempts)
	}
}

func TestPostHogSinkStopsAfterMaxAttemptsOnSustainedFailure(t *testing.T) {
	// A sustained outage must give up rather than loop forever or block the
	// drain goroutine indefinitely.
	sink, attempts := newRetryTestSink(t, func(_ int) (*http.Response, error) {
		return statusResponse(http.StatusInternalServerError), nil
	})
	sink.send(activeEvent())
	if *attempts != postHogSendMaxAttempts {
		t.Fatalf("attempts = %d, want %d (bounded by postHogSendMaxAttempts)", *attempts, postHogSendMaxAttempts)
	}
}

func TestPostHogSinkSucceedsFirstTryMakesOneRequest(t *testing.T) {
	// The healthy path must add no extra billable request.
	sink, attempts := newRetryTestSink(t, func(_ int) (*http.Response, error) {
		return okResponse(), nil
	})
	sink.send(activeEvent())
	if *attempts != 1 {
		t.Fatalf("attempts = %d, want 1 (a successful send must not retry)", *attempts)
	}
}
