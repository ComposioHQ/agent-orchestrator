package cli

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"unicode"

	"github.com/spf13/cobra"
)

const (
	sandboxControlPlaneEnv  = "AO_SANDBOX_CONTROL_PLANE_URL"
	sandboxCapabilityEnv    = "AO_SANDBOX_CAPABILITY_FILE"
	sandboxRoleEnv          = "AO_SANDBOX_ROLE"
	defaultCapabilityPath   = "/run/ao/capability"
	maxSandboxCapabilityLen = 4 << 10
)

type sandboxOperation string

const (
	sandboxSend         sandboxOperation = "send"
	sandboxReadList     sandboxOperation = "read.list"
	sandboxReadOne      sandboxOperation = "read.one"
	sandboxKill         sandboxOperation = "session.kill"
	sandboxStatus       sandboxOperation = "status"
	sandboxSpawn        sandboxOperation = "spawn"
	sandboxMessageRead  sandboxOperation = "message.read"
	sandboxClaimPR      sandboxOperation = "pr.claim"
	sandboxReadPR       sandboxOperation = "pr.read"
	sandboxReviewList   sandboxOperation = "review.list"
	sandboxReviewSubmit sandboxOperation = "review.submit"
)

type sandboxRoute struct {
	commandPath     string
	operation       sandboxOperation
	method          string
	pathTemplate    string
	coordinatorOnly bool
	idempotent      bool
	handlerReady    bool
}

var errSandboxContractPending = errors.New("sandbox command is mapped but its worker API schema is not available in the current contract")

// sandboxRoutes is the single command-to-worker-contract mapping. Commands
// absent from this table fail closed instead of touching the local daemon.
var sandboxRoutes = map[sandboxOperation]sandboxRoute{
	sandboxStatus:       {commandPath: "ao status", operation: sandboxStatus, method: http.MethodGet, pathTemplate: "/api/cloud/v1/worker/status"},
	sandboxReadList:     {commandPath: "ao session ls", operation: sandboxReadList, method: http.MethodGet, pathTemplate: "/api/cloud/v1/worker/sessions"},
	sandboxReadOne:      {commandPath: "ao session get", operation: sandboxReadOne, method: http.MethodGet, pathTemplate: "/api/cloud/v1/worker/sessions/{sessionId}"},
	sandboxKill:         {commandPath: "ao session kill", operation: sandboxKill, method: http.MethodDelete, pathTemplate: "/api/cloud/v1/worker/sessions/{sessionId}", idempotent: true},
	sandboxSpawn:        {commandPath: "ao spawn", operation: sandboxSpawn, method: http.MethodPost, pathTemplate: "/api/cloud/v1/worker/sessions", coordinatorOnly: true, idempotent: true},
	sandboxMessageRead:  {operation: sandboxMessageRead, method: http.MethodGet, pathTemplate: "/api/cloud/v1/worker/sessions/{sessionId}/messages"},
	sandboxSend:         {commandPath: "ao send", operation: sandboxSend, method: http.MethodPost, pathTemplate: "/api/cloud/v1/worker/sessions/{sessionId}/messages", idempotent: true},
	sandboxClaimPR:      {commandPath: "ao session claim-pr", operation: sandboxClaimPR, method: http.MethodPost, pathTemplate: "/api/cloud/v1/worker/sessions/{sessionId}/pr/claim"},
	sandboxReadPR:       {operation: sandboxReadPR, method: http.MethodGet, pathTemplate: "/api/cloud/v1/worker/sessions/{sessionId}/pr"},
	sandboxReviewList:   {commandPath: "ao review ls", operation: sandboxReviewList, method: http.MethodGet, pathTemplate: "/api/cloud/v1/worker/sessions/{sessionId}/reviews"},
	sandboxReviewSubmit: {commandPath: "ao review submit", operation: sandboxReviewSubmit, method: http.MethodPost, pathTemplate: "/api/cloud/v1/worker/sessions/{sessionId}/reviews/submit"},
}

func sandboxRequested() bool {
	return strings.TrimSpace(os.Getenv(sandboxControlPlaneEnv)) != ""
}

func (c *commandContext) guardSandboxCommand(cmd *cobra.Command) error {
	if !sandboxRequested() {
		return nil
	}
	var route sandboxRoute
	found := false
	for _, candidate := range sandboxRoutes {
		if candidate.commandPath == cmd.CommandPath() {
			route = candidate
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("%s is unavailable in sandbox mode because it requires the local AO daemon", cmd.CommandPath())
	}
	// AO_SANDBOX_ROLE is only a non-secret UX hint. In particular, do not use
	// it to authorize coordinator-only spawn: the capability scope and the
	// control plane's 403 response are authoritative.
	_ = route.coordinatorOnly
	if !route.handlerReady {
		return fmt.Errorf("%s: %w", cmd.CommandPath(), errSandboxContractPending)
	}
	return nil
}

type sandboxTransport struct {
	baseURL        *url.URL
	capabilityFile string
}

func loadSandboxTransport() (sandboxTransport, error) {
	rawURL := strings.TrimSpace(os.Getenv(sandboxControlPlaneEnv))
	if rawURL == "" {
		return sandboxTransport{}, errors.New("sandbox control-plane URL is not configured")
	}
	baseURL, err := url.Parse(rawURL)
	if err != nil || baseURL.Scheme != "https" || baseURL.Host == "" || baseURL.User != nil || baseURL.RawQuery != "" || baseURL.Fragment != "" {
		return sandboxTransport{}, fmt.Errorf("%s must be an absolute HTTPS URL without credentials, query, or fragment", sandboxControlPlaneEnv)
	}
	baseURL.Path = strings.TrimRight(baseURL.Path, "/")

	capabilityFile := strings.TrimSpace(os.Getenv(sandboxCapabilityEnv))
	if capabilityFile == "" {
		return sandboxTransport{}, fmt.Errorf("%s is required in sandbox mode (the launch default is %s)", sandboxCapabilityEnv, defaultCapabilityPath)
	}
	if !filepath.IsAbs(capabilityFile) {
		return sandboxTransport{}, fmt.Errorf("%s must name an absolute path", sandboxCapabilityEnv)
	}
	return sandboxTransport{baseURL: baseURL, capabilityFile: capabilityFile}, nil
}

func (t sandboxTransport) readCapability() ([]byte, error) {
	info, err := os.Lstat(t.capabilityFile)
	if err != nil {
		return nil, errors.New("read sandbox capability file")
	}
	if err := validateCapabilityFileInfo(info); err != nil {
		return nil, err
	}
	f, err := os.Open(t.capabilityFile) // #nosec G304 -- the trusted sandbox launcher supplies this absolute path.
	if err != nil {
		return nil, errors.New("read sandbox capability file")
	}
	defer func() { _ = f.Close() }()
	openedInfo, err := f.Stat()
	if err != nil || !os.SameFile(info, openedInfo) {
		return nil, errors.New("sandbox capability file changed while opening")
	}
	if err := validateCapabilityFileInfo(openedInfo); err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(io.LimitReader(f, maxSandboxCapabilityLen+1))
	if err != nil {
		return nil, errors.New("read sandbox capability file")
	}
	token := bytes.TrimSpace(raw)
	if len(token) < 1 || len(raw) > maxSandboxCapabilityLen {
		return nil, errors.New("sandbox capability must contain 1 to 4096 bytes")
	}
	for _, r := range string(token) {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return nil, errors.New("sandbox capability contains invalid bearer bytes")
		}
	}
	return token, nil
}

func validateCapabilityFileInfo(info os.FileInfo) error {
	if !info.Mode().IsRegular() {
		return errors.New("sandbox capability must be a regular file")
	}
	if info.Mode().Perm() != 0o600 {
		return errors.New("sandbox capability file mode must be 0600")
	}
	if err := capabilityOwnedByProcess(info); err != nil {
		return err
	}
	if info.Size() < 1 || info.Size() > maxSandboxCapabilityLen {
		return errors.New("sandbox capability must contain 1 to 4096 bytes")
	}
	return nil
}

func sandboxRouteFor(operation sandboxOperation) (sandboxRoute, error) {
	if route, ok := sandboxRoutes[operation]; ok {
		return route, nil
	}
	return sandboxRoute{}, fmt.Errorf("sandbox operation %q is not mapped", operation)
}

func (c *commandContext) doSandboxRoute(ctx context.Context, operation sandboxOperation, sessionID string, body, out any) error {
	route, err := sandboxRouteFor(operation)
	if err != nil {
		return err
	}
	path := route.pathTemplate
	if strings.Contains(path, "{sessionId}") {
		if strings.TrimSpace(sessionID) == "" {
			return errors.New("sandbox route requires a session id")
		}
		path = strings.ReplaceAll(path, "{sessionId}", url.PathEscape(sessionID))
	}
	headers := make(map[string]string)
	if route.idempotent {
		key, err := newSandboxIdempotencyKey()
		if err != nil {
			return err
		}
		headers["Idempotency-Key"] = key
	}
	return c.doSandboxJSONWithHeaders(ctx, route.method, path, body, out, headers)
}

func newSandboxIdempotencyKey() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", errors.New("generate sandbox idempotency key")
	}
	return hex.EncodeToString(raw[:]), nil
}

func (c *commandContext) doSandboxJSON(ctx context.Context, method, path string, body, out any) error {
	return c.doSandboxJSONWithHeaders(ctx, method, path, body, out, nil)
}

func (c *commandContext) doSandboxJSONWithHeaders(ctx context.Context, method, path string, body, out any, headers map[string]string) error {
	transport, err := loadSandboxTransport()
	if err != nil {
		return err
	}
	capability, err := transport.readCapability()
	if err != nil {
		return err
	}

	var reader io.Reader = http.NoBody
	if body != nil {
		payload, marshalErr := json.Marshal(body)
		if marshalErr != nil {
			return marshalErr
		}
		reader = bytes.NewReader(payload)
	}
	requestURL := *transport.baseURL
	escapedPath := strings.TrimRight(requestURL.EscapedPath(), "/") + "/" + strings.TrimLeft(path, "/")
	requestURL.Path, err = url.PathUnescape(escapedPath)
	if err != nil {
		return errors.New("build sandbox control-plane request path")
	}
	requestURL.RawPath = escapedPath
	req, err := http.NewRequestWithContext(ctx, method, requestURL.String(), reader)
	if err != nil {
		return errors.New(redactSandboxSecret(err.Error(), capability))
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+string(capability))
	for name, value := range headers {
		req.Header.Set(name, value)
	}

	client := *c.deps.HTTPClient
	client.Timeout = commandTimeout
	resp, err := client.Do(req) // #nosec G704 -- sandbox mode accepts only a validated HTTPS control-plane base URL.
	if err != nil {
		return fmt.Errorf("call sandbox control plane: %s", redactSandboxSecret(err.Error(), capability))
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var envelope apiError
		_ = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&envelope)
		envelope.Message = redactSandboxSecret(envelope.Message, capability)
		envelope.Code = redactSandboxSecret(envelope.Code, capability)
		envelope.RequestID = redactSandboxSecret(envelope.RequestID, capability)
		return apiResponseError{StatusCode: resp.StatusCode, ErrorBody: envelope, Source: "control plane"}
	}
	if out != nil {
		if err := json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("decode response: %w", err)
		}
	}
	return nil
}

func redactSandboxSecret(value string, capability []byte) string {
	if len(capability) == 0 {
		return value
	}
	return strings.ReplaceAll(value, string(capability), "[REDACTED]")
}
