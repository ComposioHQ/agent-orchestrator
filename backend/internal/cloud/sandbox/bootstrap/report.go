package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	cloudruntime "github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
)

// redactingWriter is the only path a child process's output takes to the log.
//
// It scans for secret VALUES rather than trusting the child to keep them out of
// its own output. An agent CLI that echoes its environment on a startup error,
// or a Go program that prints a URL with an embedded token, is not a
// hypothetical; the sandbox's logs are shipped off the box, and a credential in
// a log line is a credential in a log store.
type redactingWriter struct {
	log     *slog.Logger
	step    string
	stream  string
	secrets []string

	mu      sync.Mutex
	partial []byte
}

// maxLoggedLine bounds one buffered line so a child emitting a stream with no
// newline cannot grow this buffer without limit.
const maxLoggedLine = 8 << 10

func (w *redactingWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.partial = append(w.partial, p...)
	for {
		index := bytes.IndexByte(w.partial, '\n')
		if index < 0 {
			if len(w.partial) > maxLoggedLine {
				w.emit(string(w.partial))
				w.partial = w.partial[:0]
			}
			break
		}
		w.emit(string(bytes.TrimRight(w.partial[:index], "\r")))
		w.partial = w.partial[index+1:]
	}
	return len(p), nil
}

func (w *redactingWriter) emit(line string) {
	if strings.TrimSpace(line) == "" {
		return
	}
	w.log.Info("Sandbox step output",
		"step", w.step, "stream", w.stream, "line", Redact(line, w.secrets...))
}

// stateReport is the body the sandbox posts to the control plane.
//
// It is deliberately tiny and carries no credential: the capability is in the
// Authorization header, and the control plane authorizes from the capability's
// scope rather than from anything in this body. Runtime and session are here
// for correlation only, and the control plane must treat them as claims to
// check against the scope, not as facts.
type stateReport struct {
	RuntimeID string `json:"runtimeId"`
	SessionID string `json:"sessionId"`
	Phase     string `json:"phase"`
	Reason    string `json:"reason,omitempty"`
	Ready     bool   `json:"ready"`
}

// HTTPReporter publishes sandbox state to the control plane.
type HTTPReporter struct {
	client     *http.Client
	url        string
	capability string
	runtimeID  string
	sessionID  string
	secrets    []string
}

// NewHTTPReporter builds a reporter from configuration. It returns nil, nil
// when no control plane is configured: a sandbox brought up by hand for
// debugging has nothing to report to, and that is a mode rather than an error.
func NewHTTPReporter(cfg Config, client *http.Client) (*HTTPReporter, error) {
	target := cfg.ReportURL()
	if target == "" {
		return nil, nil
	}
	if strings.TrimSpace(cfg.Capability) == "" {
		return nil, fmt.Errorf("%s is required to report sandbox state", cloudruntime.EnvCapability)
	}
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	return &HTTPReporter{
		client:     client,
		url:        target,
		capability: cfg.Capability,
		runtimeID:  cfg.RuntimeID,
		sessionID:  cfg.SessionID,
		secrets:    cfg.Secrets(),
	}, nil
}

// Report posts one state transition. Errors are returned redacted: a transport
// error can quote the request URL, and a URL is one place a credential
// accidentally ends up.
func (r *HTTPReporter) Report(ctx context.Context, phase Phase, reason string) error {
	body, err := json.Marshal(stateReport{
		RuntimeID: r.runtimeID,
		SessionID: r.sessionID,
		Phase:     string(phase),
		Reason:    reason,
		Ready:     phase == PhaseReady,
	})
	if err != nil {
		return fmt.Errorf("encode sandbox state report: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, r.url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("build sandbox state report: %s", Redact(err.Error(), r.secrets...))
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+r.capability)
	response, err := r.client.Do(request)
	if err != nil {
		return fmt.Errorf("post sandbox state report: %s", Redact(err.Error(), r.secrets...))
	}
	defer func() { _ = response.Body.Close() }()
	// The response body is drained but never surfaced: it comes from a service
	// this process authenticates to, and echoing it into a sandbox log is a way
	// for a control-plane error message to carry something back out.
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("sandbox state report rejected with %s", response.Status)
	}
	return nil
}

// httpReady is the default readiness probe: a GET that must answer 2xx.
func httpReady(ctx context.Context, target string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	response, err := readyClient.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4<<10))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("readiness endpoint answered %s", response.Status)
	}
	return nil
}

// readyClient polls loopback endpoints, so its timeout is short: a probe that
// hangs is a probe that has already told us the answer.
var readyClient = &http.Client{Timeout: 3 * time.Second}
