package codexappserver

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/chatdriver/codexappserver/codexproto"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	aoprocess "github.com/aoagents/agent-orchestrator/backend/internal/process"
)

const (
	capabilityProbeTimeout         = 10 * time.Second
	maxCodexSchemaFileBytes        = 8 << 20
	maxCodexSchemaTotalBytes int64 = 32 << 20
)

type accountSpawnFunc func(ctx context.Context, bin, workdir string, env []string, args []string) (*process, error)

// AccountFactory reuses the app-server transport for profile-scoped account
// reads and browser login without creating a conversation.
type AccountFactory struct {
	resolve func(context.Context) (string, error)
	log     *slog.Logger
	spawn   accountSpawnFunc

	mu              sync.Mutex
	capability      map[string]domain.CodexProfileCapabilities
	capabilityCalls map[string]*capabilityCall
	probeSchema     func(context.Context, string) domain.CodexProfileCapabilities
}

type capabilityCall struct {
	done   chan struct{}
	result domain.CodexProfileCapabilities
}

// NewAccountFactory builds a structured Codex account client factory.
func NewAccountFactory(plugin codexPlugin, log *slog.Logger) *AccountFactory {
	return NewAccountFactoryWithResolver(plugin.ResolveBinary, log)
}

// NewAccountFactoryWithResolver lets daemon readiness resolve through a fresh
// adapter instance for every native operation, avoiding binary-path caches.
func NewAccountFactoryWithResolver(resolve func(context.Context) (string, error), log *slog.Logger) *AccountFactory {
	if log == nil {
		log = slog.New(slog.DiscardHandler)
	}
	f := &AccountFactory{
		resolve: resolve, log: log, spawn: spawnAccountAppServer,
		capability:      make(map[string]domain.CodexProfileCapabilities),
		capabilityCalls: make(map[string]*capabilityCall),
	}
	f.probeSchema = f.detectCapabilities
	return f
}

var _ ports.CodexAccountClientFactory = (*AccountFactory)(nil)

// Open starts a profile-scoped Codex app-server account client.
func (f *AccountFactory) Open(ctx context.Context, profile ports.CodexAccountProfile) (ports.CodexAccountClient, error) {
	if profile.Home == "" || !filepath.IsAbs(profile.Home) {
		return nil, errors.New("codex profile home must be absolute")
	}
	if profile.Managed {
		info, err := os.Lstat(profile.Home)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o700 {
			return nil, errors.New("managed Codex profile home is unavailable")
		}
	}
	bin, err := f.resolve(ctx)
	if err != nil {
		return nil, fmt.Errorf("resolve Codex binary: %w", err)
	}
	args := []string{"app-server"}
	if profile.Managed {
		args = []string{"-c", `cli_auth_credentials_store="file"`, "app-server"}
	}
	proc, err := f.spawn(ctx, bin, profile.Home, envSlice(map[string]string{"CODEX_HOME": profile.Home}), args)
	if err != nil {
		return nil, fmt.Errorf("launch Codex account client: %w", err)
	}
	client := &accountClient{proc: proc, log: f.log, events: make(chan ports.CodexAccountEvent, 16), done: make(chan struct{})}
	client.conn = newConn(proc.stdin, proc.stdout, f.log, func(context.Context, serverRequest) (any, error) {
		return nil, errors.New("server request is not supported by the account client")
	})
	if err := initializeConnection(ctx, client.conn); err != nil {
		_ = client.Close()
		return nil, err
	}
	go client.pump()
	return client, nil
}

// Capabilities detects and caches the structured account protocol supported by
// the resolved Codex binary and version.
func (f *AccountFactory) Capabilities(ctx context.Context) domain.CodexProfileCapabilities {
	probeCtx, probeCancel := context.WithTimeout(ctx, capabilityProbeTimeout)
	defer probeCancel()
	bin, err := f.resolve(probeCtx)
	if err != nil {
		return unknownCodexCapabilities("Codex capability detection is unavailable.")
	}
	versionCtx, cancel := context.WithTimeout(probeCtx, 5*time.Second)
	version, versionErr := installedCodexVersion(versionCtx, bin)
	cancel()
	key := bin + "\x00" + strings.TrimSpace(version)
	cacheable := versionErr == nil
	if versionErr != nil {
		key = bin + "\x00unknown"
	}
	f.mu.Lock()
	if cached, ok := f.capability[key]; ok {
		f.mu.Unlock()
		f.log.Debug("Codex capability cache hit", "operation", "capability_check", "cache", "hit")
		return cached
	}
	if call := f.capabilityCalls[key]; call != nil {
		f.mu.Unlock()
		f.log.Debug("joined Codex capability check", "operation", "capability_check", "cache", "join")
		select {
		case <-call.done:
			return call.result
		case <-probeCtx.Done():
			return unknownCodexCapabilities("Codex capability detection did not complete.")
		}
	}
	call := &capabilityCall{done: make(chan struct{})}
	f.capabilityCalls[key] = call
	f.mu.Unlock()
	started := time.Now()
	result := f.probeSchema(probeCtx, bin)
	f.mu.Lock()
	call.result = result
	if cacheable && result.AccountRead.State != domain.CodexCapabilityUnknown && result.BrowserLogin.State != domain.CodexCapabilityUnknown && result.CapacityRead.State != domain.CodexCapabilityUnknown {
		f.capability[key] = result
	}
	delete(f.capabilityCalls, key)
	close(call.done)
	f.mu.Unlock()
	f.log.Info("Codex capability check completed", "operation", "capability_check", "cache", "new", "duration_ms", time.Since(started).Milliseconds(), "account_read", result.AccountRead.State, "browser_login", result.BrowserLogin.State, "capacity_read", result.CapacityRead.State)
	return result
}

func (f *AccountFactory) detectCapabilities(ctx context.Context, bin string) domain.CodexProfileCapabilities {
	probeCtx, cancel := context.WithTimeout(ctx, capabilityProbeTimeout)
	defer cancel()
	dir, err := os.MkdirTemp("", "ao-codex-schema-")
	if err != nil {
		return unknownCodexCapabilities("Codex capability detection is unavailable.")
	}
	defer func() { _ = os.RemoveAll(dir) }()
	cmd := aoprocess.CommandContext(probeCtx, bin, "app-server", "generate-json-schema", "--experimental", "--out", dir)
	if err := cmd.Run(); err != nil {
		return unknownCodexCapabilities("Codex capability detection did not complete.")
	}
	return inspectCodexSchemaDirectory(dir)
}

func inspectCodexSchemaDirectory(dir string) domain.CodexProfileCapabilities {
	declared := make(map[string]bool)
	methods := []string{
		codexproto.MethodAccountRead,
		codexproto.MethodAccountRateLimitsRead,
		codexproto.MethodAccountLoginStart,
		codexproto.MethodAccountLoginCancel,
		codexproto.MethodAccountLoginCompleted,
		codexproto.MethodAccountUpdated,
	}
	var total int64
	var schemaFiles int
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() || filepath.Ext(path) != ".json" {
			return walkErr
		}
		file, openErr := os.Open(path) //nolint:gosec // temporary directory created and owned by this process.
		if openErr != nil {
			return openErr
		}
		data, readErr := io.ReadAll(io.LimitReader(file, maxCodexSchemaFileBytes+1))
		_ = file.Close()
		if readErr != nil {
			return readErr
		}
		if len(data) > maxCodexSchemaFileBytes {
			return errors.New("codex schema output is too large")
		}
		if !json.Valid(data) {
			return errors.New("codex schema output is not valid JSON")
		}
		schemaFiles++
		total += int64(len(data))
		if total > maxCodexSchemaTotalBytes {
			return errors.New("codex schema output is too large")
		}
		text := string(data)
		for _, method := range methods {
			if strings.Contains(text, `"`+method+`"`) {
				declared[method] = true
			}
		}
		return nil
	})
	if err != nil || schemaFiles == 0 {
		return unknownCodexCapabilities("Codex capability detection did not complete.")
	}
	accountRead := declared[codexproto.MethodAccountRead]
	browserLogin := accountRead && declared[codexproto.MethodAccountLoginStart] && declared[codexproto.MethodAccountLoginCancel] && declared[codexproto.MethodAccountLoginCompleted] && declared[codexproto.MethodAccountUpdated]
	return domain.CodexProfileCapabilities{
		AccountRead:  codexCapability(accountRead, "Structured Codex account discovery is available.", "Structured Codex account discovery is not supported by this Codex version."),
		BrowserLogin: codexCapability(browserLogin, "Codex browser login is available.", "Codex browser login is not supported by this Codex version."),
		CapacityRead: codexCapability(declared[codexproto.MethodAccountRateLimitsRead], "Codex subscription capacity is available.", "Codex subscription capacity is not supported by this Codex version."),
	}
}

func codexCapability(supported bool, yes, no string) domain.CodexCapabilityObservation {
	if supported {
		return domain.CodexCapabilityObservation{State: domain.CodexCapabilitySupported, ReasonCode: domain.CodexCapabilityReasonSupported, Reason: yes}
	}
	return domain.CodexCapabilityObservation{State: domain.CodexCapabilityUnsupported, ReasonCode: domain.CodexCapabilityReasonUnsupported, Reason: no}
}

func unknownCodexCapabilities(reason string) domain.CodexProfileCapabilities {
	unknown := domain.CodexCapabilityObservation{State: domain.CodexCapabilityUnknown, ReasonCode: domain.CodexCapabilityReasonUnknown, Reason: reason}
	return domain.CodexProfileCapabilities{AccountRead: unknown, BrowserLogin: unknown, CapacityRead: unknown}
}

type accountClient struct {
	conn   *conn
	proc   *process
	log    *slog.Logger
	events chan ports.CodexAccountEvent
	done   chan struct{}
	close  sync.Once
}

var _ ports.CodexAccountClient = (*accountClient)(nil)

func (c *accountClient) Read(ctx context.Context, refreshToken bool) (ports.CodexAccountObservation, error) {
	refresh := refreshToken
	params := codexproto.GetAccountParams{RefreshToken: &refresh}
	var response codexproto.GetAccountResponse
	if err := c.conn.request(ctx, codexproto.MethodAccountRead, params, &response); err != nil {
		return ports.CodexAccountObservation{}, err
	}
	if response.Account == nil {
		state := domain.AgentAuthenticationNotApplicable
		if response.RequiresOpenaiAuth {
			state = domain.AgentAuthenticationUnauthorized
		}
		return ports.CodexAccountObservation{Authentication: state, Method: domain.CodexAuthMethodUnknown}, nil
	}
	method := domain.CodexAuthMethodOther
	switch response.Account.Type {
	case codexproto.AccountTypeChatgpt:
		method = domain.CodexAuthMethodChatGPT
	case codexproto.AccountTypeApiKey:
		method = domain.CodexAuthMethodAPIKey
	}
	return ports.CodexAccountObservation{Authentication: domain.AgentAuthenticationAuthorized, Method: method, Email: safeCodexAccountEmail(response.Account.Email)}, nil
}

func safeCodexAccountEmail(value *string) *string {
	if value == nil {
		return nil
	}
	email := strings.TrimSpace(*value)
	if email == "" || !utf8.ValidString(email) || utf8.RuneCountInString(email) > 320 {
		return nil
	}
	for _, r := range email {
		if unicode.IsControl(r) || r == unicode.ReplacementChar {
			return nil
		}
	}
	return &email
}

func (c *accountClient) StartBrowserLogin(ctx context.Context) (ports.CodexLoginStart, error) {
	streamlined := true
	hostedPage := true
	params := codexproto.LoginAccountParams{Type: codexproto.LoginAccountParamsTypeChatgpt, CodexStreamlinedLogin: &streamlined, UseHostedLoginSuccessPage: &hostedPage}
	var response codexproto.LoginAccountResponse
	if err := c.conn.request(ctx, codexproto.MethodAccountLoginStart, params, &response); err != nil {
		return ports.CodexLoginStart{}, err
	}
	if response.Type != codexproto.LoginAccountResponseTypeChatgpt || response.AuthURL == nil || response.LoginID == nil || *response.AuthURL == "" || *response.LoginID == "" {
		return ports.CodexLoginStart{}, errors.New("codex returned an incomplete browser login")
	}
	parsed, err := url.Parse(*response.AuthURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return ports.CodexLoginStart{}, errors.New("codex returned an invalid browser login URL")
	}
	return ports.CodexLoginStart{AuthURL: *response.AuthURL, LoginID: *response.LoginID}, nil
}

func (c *accountClient) CancelLogin(ctx context.Context, loginID string) error {
	var response codexproto.CancelLoginAccountResponse
	if err := c.conn.request(ctx, codexproto.MethodAccountLoginCancel, codexproto.CancelLoginAccountParams{LoginID: loginID}, &response); err != nil {
		return err
	}
	if response.Status == codexproto.CancelLoginAccountStatusNotFound {
		return errors.New("codex login was not found")
	}
	return nil
}

func (c *accountClient) Events() <-chan ports.CodexAccountEvent { return c.events }

func (c *accountClient) pump() {
	defer close(c.done)
	defer close(c.events)
	for notification := range c.conn.notifs() {
		var event ports.CodexAccountEvent
		switch notification.Method {
		case codexproto.MethodAccountLoginCompleted:
			var completed codexproto.AccountLoginCompletedNotification
			if err := jsonUnmarshal(notification.Params, &completed); err != nil {
				continue
			}
			event = ports.CodexAccountEvent{Kind: ports.CodexAccountEventLoginCompleted, Success: completed.Success, Failed: completed.Error != nil}
			if completed.LoginID != nil {
				event.LoginID = *completed.LoginID
			}
		case codexproto.MethodAccountUpdated:
			event = ports.CodexAccountEvent{Kind: ports.CodexAccountEventUpdated, Success: true}
		case codexproto.MethodAccountRateLimitsUpdated:
			var updated capacityReadEnvelope
			if err := jsonUnmarshal(notification.Params, &updated); err != nil {
				continue
			}
			capacity := capacityObservationFromEnvelope(updated, time.Now().UTC(), true)
			event = ports.CodexAccountEvent{Kind: ports.CodexAccountEventCapacityUpdated, Success: true, Capacity: &capacity}
		default:
			continue
		}
		select {
		case c.events <- event:
		default:
			c.log.Warn("dropped Codex account event", "event_kind", event.Kind)
		}
	}
}

func jsonUnmarshal(data []byte, target any) error {
	return json.Unmarshal(data, target)
}

func (c *accountClient) Close() error {
	var err error
	c.close.Do(func() {
		if c.proc != nil && c.proc.stop != nil {
			err = c.proc.stop()
		}
	})
	return err
}

func spawnAccountAppServer(_ context.Context, bin, workdir string, env, args []string) (*process, error) {
	cmd := aoprocess.Command(bin, args...)
	cmd.Dir = workdir
	cmd.Env = env
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go func() { _, _ = io.Copy(io.Discard, stderr) }()
	var once sync.Once
	return &process{stdin: stdin, stdout: stdout, stop: func() error {
		once.Do(func() {
			_ = stdin.Close()
			done := make(chan struct{})
			go func() { _, _ = cmd.Process.Wait(); close(done) }()
			select {
			case <-done:
			case <-time.After(3 * time.Second):
				_ = cmd.Process.Kill()
			}
		})
		return nil
	}}, nil
}
