package sentryobs

import (
	"context"
	"testing"

	"github.com/getsentry/sentry-go"
)

func TestScrubRedactsLocalPaths(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		// A trailing ':' is part of the matched path run (it must be, for C:\...),
		// so it is redacted along with the path.
		"open /Users/alice/secret/notes.md: no such file": "open [redacted-path] no such file",
		"read /home/bob/ao/worktree/x.go failed":          "read [redacted-path] failed",
		`stat C:\Users\carol\AppData\ao\db failed`:        "stat [redacted-path] failed",
		"no paths here": "no paths here",
	}
	for in, want := range cases {
		if got := scrub(in); got != want {
			t.Fatalf("scrub(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestShouldCapture(t *testing.T) {
	t.Parallel()
	cases := []struct {
		status int
		code   string
		want   bool
	}{
		{status: 200, want: false},
		{status: 404, want: false},
		{status: 500, want: true},
		{status: 502, want: true},
		{status: 504, want: true},
		// 503 is captured or suppressed based on the typed code, not status alone.
		{status: 503, code: "SERVICE_UNAVAILABLE", want: false}, // deliberate backpressure
		{status: 503, code: "SCM_UNAVAILABLE", want: true},      // real outage
		{status: 503, code: "BROWSER_RUNTIME_UNAVAILABLE", want: true},
		{status: 503, code: "DEVICE_REGISTRY_UNAVAILABLE", want: true},
		{status: 503, code: "", want: true},                    // untyped 503 is treated as a fault
		{status: 500, code: "SERVICE_UNAVAILABLE", want: true}, // code only suppresses on 503
	}
	for _, c := range cases {
		if got := ShouldCapture(c.status, c.code); got != c.want {
			t.Fatalf("ShouldCapture(%d, %q) = %v, want %v", c.status, c.code, got, c.want)
		}
	}
}

func TestInitNoDSNIsNoOp(t *testing.T) {
	if err := Init(Config{}); err != nil {
		t.Fatalf("Init with empty DSN: %v", err)
	}
	if Enabled() {
		t.Fatal("Sentry should be disabled without a DSN")
	}
	// Capture calls must be safe no-ops when disabled.
	CaptureHTTPError(context.TODO(), errString("boom"), map[string]string{"path": "/x"}, "fp")
	CapturePanic(context.TODO(), "kaboom", "stack", nil, "fp")
	Flush(0)
}

func TestScrubEventStripsPathsAndContext(t *testing.T) {
	t.Parallel()
	event := &sentry.Event{
		Message:    "failed at /Users/dave/ao/main.go",
		ServerName: "daves-macbook.local",
		Request:    &sentry.Request{URL: "http://127.0.0.1:3001/api/v1/x"},
		Exception: []sentry.Exception{{
			Value: "open /home/eve/ws/file: denied",
			Stacktrace: &sentry.Stacktrace{Frames: []sentry.Frame{
				{AbsPath: "/Users/dave/ao/backend/internal/x.go", Filename: "/Users/dave/ao/backend/internal/x.go"},
			}},
		}},
	}
	out := scrubEvent(event)
	if out.Message != "failed at [redacted-path]" {
		t.Fatalf("message not scrubbed: %q", out.Message)
	}
	if out.ServerName != "" {
		t.Fatalf("server name not cleared: %q", out.ServerName)
	}
	if out.Request != nil {
		t.Fatal("request context not dropped")
	}
	if out.Exception[0].Value != "open [redacted-path] denied" {
		t.Fatalf("exception value not scrubbed: %q", out.Exception[0].Value)
	}
	f := out.Exception[0].Stacktrace.Frames[0]
	if f.AbsPath != "[redacted-path]" || f.Filename != "[redacted-path]" {
		t.Fatalf("frame paths not scrubbed: %+v", f)
	}
}

type errString string

func (e errString) Error() string { return string(e) }
