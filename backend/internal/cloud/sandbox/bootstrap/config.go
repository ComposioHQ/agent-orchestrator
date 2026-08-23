package bootstrap

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	cloudruntime "github.com/aoagents/agent-orchestrator/backend/internal/cloud/runtime"
	"github.com/aoagents/agent-orchestrator/backend/internal/cloud/sandbox/ticket"
)

// Environment the sandbox runtime reads on top of the AO_CLOUD_* launch
// variables the compute plane already defines in cloud/runtime/launch.go.
//
// Every one of these is configuration, not a secret, with the single exception
// of EnvTicketKey. It is here rather than in a file because it is consumed once
// at startup by this process alone; a file would widen its reach to every child
// that can read the filesystem.
const (
	// EnvTicketKey carries the base64 per-sandbox ticket-signing key.
	EnvTicketKey = "AO_SANDBOX_TICKET_KEY"
	// EnvTicketKeyFile names a file holding the same value, for deployments
	// that deliver it through the provider's secret-file channel instead of the
	// environment. It wins over EnvTicketKey when both are set, because a
	// deployment that went to the trouble of using a file meant it.
	EnvTicketKeyFile = "AO_SANDBOX_TICKET_KEY_FILE"
	// EnvListenAddr is where the published listener binds.
	EnvListenAddr = "AO_SANDBOX_LISTEN_ADDR"
	// EnvDaemonAddr is the daemon's loopback address inside the sandbox.
	EnvDaemonAddr = "AO_SANDBOX_DAEMON_ADDR"
	// EnvDaemonArgv is the daemon launch argv, JSON-encoded. It exists so a
	// snapshot can pin a different entrypoint without a new binary; it is not
	// expected to be set in normal operation.
	EnvDaemonArgv = "AO_SANDBOX_DAEMON_ARGV"
	// EnvHarnessArgv is the agent harness argv, JSON-encoded. Empty means the
	// placement declares no harness — a coordinator sandbox, or a worker whose
	// agent the control plane will start later over the API.
	EnvHarnessArgv = "AO_SANDBOX_HARNESS_ARGV"
	// EnvWorkspaceDir is the working directory harness steps start in.
	EnvWorkspaceDir = "AO_SANDBOX_WORKSPACE_DIR"
	// EnvReportPath overrides the control-plane path the sandbox reports state
	// on, relative to AO_CLOUD_URL. It is an override so a control-plane route
	// change does not require a new sandbox snapshot.
	EnvReportPath = "AO_SANDBOX_REPORT_PATH"
	// EnvHeartbeatInterval overrides how often the sandbox checks in. Zero
	// disables check-ins, which is what tests and manual bring-up want.
	EnvHeartbeatInterval = "AO_SANDBOX_HEARTBEAT_INTERVAL"
)

// Defaults. The daemon's own default port is 3001 (internal/config), and it
// binds loopback and unauthenticated — which is precisely why the published
// listener in muxd exists and why nothing else may be exposed from here.
const (
	DefaultListenAddr        = "0.0.0.0:8712"
	DefaultDaemonAddr        = "127.0.0.1:3001"
	DefaultHeartbeatInterval = 30 * time.Second
)

// DefaultReportPath is the control-plane route the sandbox reports state on.
// The path is templated with the runtime id. It is a default rather than a
// constant obligation because the control-plane API surface is owned elsewhere;
// EnvReportPath is the escape hatch if it moves.
const DefaultReportPath = "/api/cloud/v1/sandboxes/{runtimeId}/state"

// Config is the validated sandbox runtime configuration.
type Config struct {
	// ControlPlaneURL, Capability, and the placement identifiers come from the
	// compute plane's launch environment (cloud/runtime/launch.go).
	ControlPlaneURL string
	Capability      string
	OrgID           string
	WorkspaceID     string
	SessionID       string
	RuntimeID       string
	Role            string

	TicketKey  ticket.Key
	ListenAddr string
	DaemonAddr string

	DaemonArgv   []string
	HarnessArgv  []string
	WorkspaceDir string

	ReportPath        string
	HeartbeatInterval time.Duration
}

// Load reads the sandbox runtime configuration from the process environment.
func Load(getenv func(string) string) (Config, error) {
	if getenv == nil {
		return Config{}, errors.New("bootstrap: an environment reader is required")
	}
	key, keySource, err := loadTicketKey(getenv)
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", keySource, err)
	}
	daemonArgv, err := argvValue(getenv(EnvDaemonArgv), []string{"ao", "start"})
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", EnvDaemonArgv, err)
	}
	harnessArgv, err := argvValue(getenv(EnvHarnessArgv), nil)
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", EnvHarnessArgv, err)
	}
	heartbeat, err := durationValue(getenv(EnvHeartbeatInterval), DefaultHeartbeatInterval)
	if err != nil {
		return Config{}, fmt.Errorf("%s: %w", EnvHeartbeatInterval, err)
	}
	cfg := Config{
		ControlPlaneURL:   strings.TrimSpace(getenv(cloudruntime.EnvControlPlaneURL)),
		Capability:        strings.TrimSpace(getenv(cloudruntime.EnvCapability)),
		OrgID:             strings.TrimSpace(getenv(cloudruntime.EnvOrgID)),
		WorkspaceID:       strings.TrimSpace(getenv(cloudruntime.EnvWorkspaceID)),
		SessionID:         strings.TrimSpace(getenv(cloudruntime.EnvSessionID)),
		RuntimeID:         strings.TrimSpace(getenv(cloudruntime.EnvRuntimeID)),
		Role:              strings.TrimSpace(getenv(cloudruntime.EnvRole)),
		TicketKey:         key,
		ListenAddr:        valueOrDefault(getenv(EnvListenAddr), DefaultListenAddr),
		DaemonAddr:        valueOrDefault(getenv(EnvDaemonAddr), DefaultDaemonAddr),
		DaemonArgv:        daemonArgv,
		HarnessArgv:       harnessArgv,
		WorkspaceDir:      strings.TrimSpace(getenv(EnvWorkspaceDir)),
		ReportPath:        valueOrDefault(getenv(EnvReportPath), DefaultReportPath),
		HeartbeatInterval: heartbeat,
	}
	if cfg.SessionID == "" {
		return Config{}, fmt.Errorf("%s is required: a sandbox that does not know its session cannot verify a ticket", cloudruntime.EnvSessionID)
	}
	if cfg.RuntimeID == "" {
		return Config{}, fmt.Errorf("%s is required", cloudruntime.EnvRuntimeID)
	}
	if len(cfg.DaemonArgv) == 0 {
		return Config{}, fmt.Errorf("%s must not be empty", EnvDaemonArgv)
	}
	// The control-plane URL and capability are optional together: a sandbox can
	// be brought up by hand for debugging with no control plane to report to.
	// Half of the pair is a misconfiguration, not a mode.
	if (cfg.ControlPlaneURL == "") != (cfg.Capability == "") {
		return Config{}, fmt.Errorf("%s and %s must be set together",
			cloudruntime.EnvControlPlaneURL, cloudruntime.EnvCapability)
	}
	if cfg.ControlPlaneURL != "" {
		parsed, err := url.Parse(cfg.ControlPlaneURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return Config{}, fmt.Errorf("%s must be an http(s) URL, got %q", cloudruntime.EnvControlPlaneURL, cfg.ControlPlaneURL)
		}
	}
	return cfg, nil
}

// UpstreamMuxURL is the daemon's loopback mux, which the published listener
// relays to.
func (c Config) UpstreamMuxURL() string { return "ws://" + c.DaemonAddr + "/mux" }

// DaemonReadyURL is the daemon's own readiness endpoint. The published listener
// must not report ready before this does: it relays to a daemon that would
// otherwise not be there.
func (c Config) DaemonReadyURL() string { return "http://" + c.DaemonAddr + "/readyz" }

// loadTicketKey reads the ticket key from a file when one is named, else from
// the environment. It returns the source name so a failure says which one the
// deployment actually used.
func loadTicketKey(getenv func(string) string) (ticket.Key, string, error) {
	if path := strings.TrimSpace(getenv(EnvTicketKeyFile)); path != "" {
		raw, err := os.ReadFile(path) //nolint:gosec // the path is deployment configuration
		if err != nil {
			return ticket.Key{}, EnvTicketKeyFile, errors.New("could not be read")
		}
		key, err := ticket.ParseKey(string(raw))
		return key, EnvTicketKeyFile, err
	}
	key, err := ticket.ParseKey(getenv(EnvTicketKey))
	return key, EnvTicketKey, err
}

// ChildEnvDenyList names the variables children must not inherit.
//
// The ticket key is this process's own secret. The agent harness runs as the
// same user in the same sandbox; handing it the signing key would let it mint
// connection tickets for the sandbox it is running in, which is authority it
// has no reason to hold.
func ChildEnvDenyList() []string { return []string{EnvTicketKey, EnvTicketKeyFile} }

// Binding is the placement a presented ticket must name.
func (c Config) Binding() ticket.Binding {
	return ticket.Binding{SessionID: c.SessionID, RuntimeID: c.RuntimeID}
}

// ReportURL is the absolute control-plane URL this sandbox reports state on, or
// empty when no control plane is configured.
func (c Config) ReportURL() string {
	if c.ControlPlaneURL == "" {
		return ""
	}
	path := strings.ReplaceAll(c.ReportPath, "{runtimeId}", url.PathEscape(c.RuntimeID))
	return strings.TrimRight(c.ControlPlaneURL, "/") + "/" + strings.TrimLeft(path, "/")
}

// Redact replaces every secret VALUE the environment carries with a placeholder.
//
// It works on values rather than names on purpose. Name-based redaction only
// protects the variables somebody remembered to list, and the failure mode is
// silent: a capability copied into a differently-named variable, or embedded in
// a URL, sails straight through. Scanning for the values catches those, and it
// is the same shape as the argv guard the compute plane already applies on the
// way in (runtime.guardArgv).
func Redact(text string, secrets ...string) string {
	ordered := append([]string(nil), secrets...)
	// Longest first, so a secret that contains another as a substring is
	// replaced whole rather than leaving a tail behind.
	sort.Slice(ordered, func(i, j int) bool { return len(ordered[i]) > len(ordered[j]) })
	for _, secret := range ordered {
		if len(strings.TrimSpace(secret)) < minimumRedactedLength {
			continue
		}
		text = strings.ReplaceAll(text, secret, redacted)
	}
	return text
}

// Secrets lists the secret values this configuration carries, for Redact. It
// deliberately returns values and not names; see Redact.
func (c Config) Secrets() []string {
	values := []string{c.Capability}
	if c.TicketKey.Valid() {
		values = append(values, c.TicketKey.Encode())
	}
	return values
}

// minimumRedactedLength keeps redaction from blanking out ordinary words when a
// configuration carries a trivially short value. It matches the compute plane's
// argv guard so the two agree on what counts as secret-shaped.
const minimumRedactedLength = 8

const redacted = "[redacted]"

// argvValue decodes a JSON-encoded argv. JSON rather than a shell string
// because splitting a shell string here would mean implementing quoting rules,
// and a wrong split of an agent's prompt argument is exactly the kind of bug
// that only shows up with an apostrophe in a task description.
func argvValue(raw string, fallback []string) ([]string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback, nil
	}
	var argv []string
	if err := json.Unmarshal([]byte(raw), &argv); err != nil {
		return nil, errors.New("must be a JSON array of strings")
	}
	for _, arg := range argv {
		if strings.TrimSpace(arg) == "" {
			return nil, errors.New("must not contain empty arguments")
		}
	}
	return argv, nil
}

func valueOrDefault(raw, fallback string) string {
	if trimmed := strings.TrimSpace(raw); trimmed != "" {
		return trimmed
	}
	return fallback
}

func durationValue(raw string, fallback time.Duration) (time.Duration, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return fallback, nil
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value < 0 {
		return 0, errors.New("must be a non-negative duration")
	}
	return value, nil
}
