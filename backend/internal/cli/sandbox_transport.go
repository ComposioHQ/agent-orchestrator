package cli

import (
	"bytes"
	"context"
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
	sandboxCoordinatorRole  = "coordinator"
	defaultCapabilityPath   = "/run/ao/capability"
	maxSandboxCapabilityLen = 4 << 10
)

type sandboxOperation string

const (
	sandboxSend          sandboxOperation = "send"
	sandboxReadList      sandboxOperation = "read.list"
	sandboxReadOne       sandboxOperation = "read.one"
	sandboxStatus        sandboxOperation = "status"
	sandboxSpawn         sandboxOperation = "spawn"
	sandboxClaimPR       sandboxOperation = "pr.claim"
	sandboxMergePR       sandboxOperation = "pr.merge"
	sandboxResolvePR     sandboxOperation = "pr.resolve-comments"
	sandboxReviewList    sandboxOperation = "review.list"
	sandboxReviewSubmit  sandboxOperation = "review.submit"
	sandboxReviewCancel  sandboxOperation = "review.cancel"
	sandboxReviewTrigger sandboxOperation = "review.trigger"
)

type sandboxRoute struct {
	operation       sandboxOperation
	method          string
	pathTemplate    string
	coordinatorOnly bool
}

// sandboxRoutes is the single command-to-worker-contract mapping. Empty HTTP
// fields are intentional until the corrected worker contract publishes the
// canonical paths and DTOs; sandbox commands fail closed rather than falling
// through to the local daemon or guessing a cloud endpoint.
var sandboxRoutes = map[string]sandboxRoute{
	"ao send":                {operation: sandboxSend},
	"ao session ls":          {operation: sandboxReadList},
	"ao session get":         {operation: sandboxReadOne},
	"ao status":              {operation: sandboxStatus},
	"ao spawn":               {operation: sandboxSpawn, coordinatorOnly: true},
	"ao session claim-pr":    {operation: sandboxClaimPR},
	"ao pr merge":            {operation: sandboxMergePR},
	"ao pr resolve-comments": {operation: sandboxResolvePR},
	"ao review ls":           {operation: sandboxReviewList},
	"ao review submit":       {operation: sandboxReviewSubmit},
	"ao review cancel":       {operation: sandboxReviewCancel},
	"ao review trigger":      {operation: sandboxReviewTrigger},
}

var errSandboxContractPending = errors.New("sandbox command is supported but its worker API mapping is not available in the current contract")

func sandboxRequested() bool {
	return strings.TrimSpace(os.Getenv(sandboxControlPlaneEnv)) != ""
}

func (c *commandContext) guardSandboxCommand(cmd *cobra.Command) error {
	if !sandboxRequested() {
		return nil
	}
	route, ok := sandboxRoutes[cmd.CommandPath()]
	if !ok {
		return fmt.Errorf("%s is unavailable in sandbox mode because it requires the local AO daemon", cmd.CommandPath())
	}
	if route.coordinatorOnly {
		role := strings.ToLower(strings.TrimSpace(os.Getenv(sandboxRoleEnv)))
		if role != "" && role != sandboxCoordinatorRole {
			return fmt.Errorf("%s is available only to a sandbox coordinator", cmd.CommandPath())
		}
	}
	if route.method == "" || route.pathTemplate == "" {
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

func (c *commandContext) doSandboxJSON(ctx context.Context, method, path string, body, out any) error {
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
	requestURL.Path = strings.TrimRight(requestURL.Path, "/") + "/" + strings.TrimLeft(path, "/")
	req, err := http.NewRequestWithContext(ctx, method, requestURL.String(), reader)
	if err != nil {
		return errors.New(redactSandboxSecret(err.Error(), capability))
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+string(capability))

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
