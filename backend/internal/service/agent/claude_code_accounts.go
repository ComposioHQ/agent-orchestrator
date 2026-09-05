package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/claudecode"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/shellterm"
)

const (
	claudeCodeAccountLoginLifetime = 15 * time.Minute
	claudeCodeAuthTimeout          = 15 * time.Second
	claudeCodeUsageCacheLifetime   = 5 * time.Minute
)

var claudeCodeAuthOverrideVariables = []string{
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
	"CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
}

var errClaudeCodeAuthenticationSignedOut = errors.New("authentication is signed out for Claude Code")

// ClaudeCodeAccounts is the service-level account-management snapshot.
type ClaudeCodeAccounts struct {
	ActiveAccountID        string                                   `json:"activeAccountId,omitempty"`
	AccountRevision        int64                                    `json:"accountRevision"`
	Accounts               []domain.ClaudeCodeAccountSnapshot       `json:"accounts"`
	Capabilities           domain.ClaudeCodeAccountCapabilities     `json:"capabilities"`
	UnmanagedGlobalAccount *domain.ClaudeCodeUnmanagedGlobalAccount `json:"unmanagedGlobalAccount,omitempty"`
	ActiveLogin            *ClaudeCodeActiveLogin                   `json:"activeLogin,omitempty"`
	CurrentSwitch          *domain.ClaudeCodeAccountSwitch          `json:"currentSwitch,omitempty"`
}

// ClaudeCodeActiveLogin describes a running isolated native login.
type ClaudeCodeActiveLogin struct {
	OperationID   string                              `json:"operationId"`
	AccountID     string                              `json:"accountId,omitempty"`
	Status        domain.ClaudeCodeAccountLoginStatus `json:"status"`
	ReasonCode    string                              `json:"reasonCode"`
	Reason        string                              `json:"reason"`
	ExpiresAt     time.Time                           `json:"expiresAt"`
	ShellTerminal ClaudeCodeLoginTerminalDisplay      `json:"shellTerminal"`
}

// ClaudeCodeLoginTerminalDisplay is the safe terminal projection exposed to clients.
type ClaudeCodeLoginTerminalDisplay struct {
	HandleID  string    `json:"handleId"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"createdAt"`
}

// ClaudeCodeAccountLoginTerminalStart pairs a login operation with its terminal.
type ClaudeCodeAccountLoginTerminalStart struct {
	Operation     domain.ClaudeCodeAccountLoginOperation `json:"operation"`
	ShellTerminal shellterm.ShellTerminal                `json:"shellTerminal"`
}

type claudeCodeAccountLoginTerminalService interface {
	OpenCommandTerminal(context.Context, shellterm.OpenCommandTerminalInput) (shellterm.ShellTerminal, error)
	CloseShellTerminal(context.Context, string) error
}

type claudeCodeCommandRunner func(context.Context, string, []string, map[string]string) ([]byte, error)

type claudeCodeAccountManagerDeps struct {
	Context           context.Context
	AccountRoot       string
	PendingRoot       string
	SwitchStagingRoot string
	Home              string
	Keychain          claudecode.Keychain
	KeychainAccount   string
	UsageReader       ports.ClaudeCodeUsageReader
	StateStore        ports.ClaudeCodeAccountStateStore
	OperationGate     ports.ClaudeCodeOperationGate
	ResolveExecutable func(context.Context) (string, error)
	LoginExecutable   func() (string, error)
	Run               claudeCodeCommandRunner
	Environment       map[string]string
}

type claudeCodeLoginOperation struct {
	snapshot        domain.ClaudeCodeAccountLoginOperation
	targetAccountID string
	pendingDir      string
	configDir       string
	authDir         string
	terminalHandle  string
	terminalTitle   string
	terminalCreated time.Time
}

type claudeCodeAccountManager struct {
	ctx               context.Context
	accountRoot       string
	pendingRoot       string
	switchStagingRoot string
	home              string
	claudeDir         string
	configPath        string
	keychain          claudecode.Keychain
	keychainAccount   string
	usageReader       ports.ClaudeCodeUsageReader
	stateStore        ports.ClaudeCodeAccountStateStore
	operationGate     ports.ClaudeCodeOperationGate
	resolveExecutable func(context.Context) (string, error)
	loginExecutable   func() (string, error)
	run               claudeCodeCommandRunner
	environment       map[string]string
	catalog           *claudeCodeAccountCatalog
	terminal          claudeCodeAccountLoginTerminalService
	now               func() time.Time
	newID             func() string

	mutation      chan struct{}
	mu            sync.Mutex
	bootstrapOnce sync.Once
	bootstrapDone chan struct{}
	bootstrapErr  error
	active        domain.ClaudeCodeActiveAccount
	caps          domain.ClaudeCodeAccountCapabilities
	unmanaged     *domain.ClaudeCodeUnmanagedGlobalAccount
	login         *claudeCodeLoginOperation
	planUsage     map[string]domain.ClaudeCodePlanUsageSnapshot
	subscribers   map[chan ClaudeCodeAccounts]struct{}
}

func newClaudeCodeAccountManager(deps claudeCodeAccountManagerDeps) *claudeCodeAccountManager {
	ctx := deps.Context
	if ctx == nil {
		ctx = context.Background()
	}
	keychain := deps.Keychain
	if keychain == nil {
		keychain = claudecode.NewKeychain()
	}
	keychainAccount := strings.TrimSpace(deps.KeychainAccount)
	if keychainAccount == "" {
		keychainAccount = claudecode.KeychainAccount()
	}
	run := deps.Run
	if run == nil {
		run = runClaudeCodeCommand
	}
	loginExecutable := deps.LoginExecutable
	if loginExecutable == nil {
		loginExecutable = os.Executable
	}
	m := &claudeCodeAccountManager{
		ctx: ctx, accountRoot: canonicalPath(deps.AccountRoot), pendingRoot: canonicalPath(deps.PendingRoot),
		switchStagingRoot: canonicalPath(deps.SwitchStagingRoot), home: canonicalPath(deps.Home),
		claudeDir: filepath.Join(canonicalPath(deps.Home), ".claude"), configPath: filepath.Join(canonicalPath(deps.Home), ".claude.json"),
		keychain: keychain, keychainAccount: keychainAccount, stateStore: deps.StateStore,
		usageReader:   deps.UsageReader,
		operationGate: deps.OperationGate, resolveExecutable: deps.ResolveExecutable, loginExecutable: loginExecutable, run: run,
		environment: cloneStringMap(deps.Environment), now: func() time.Time { return time.Now().UTC() }, newID: uuid.NewString,
		mutation: make(chan struct{}, 1), subscribers: map[chan ClaudeCodeAccounts]struct{}{}, bootstrapDone: make(chan struct{}),
		planUsage: map[string]domain.ClaudeCodePlanUsageSnapshot{},
	}
	if m.usageReader == nil {
		m.usageReader = claudecode.NewUsageReader(keychain, m.home)
	}
	m.mutation <- struct{}{}
	m.catalog = newClaudeCodeAccountCatalog(m.accountRoot, keychain, keychainAccount)
	m.caps = unknownClaudeCodeCapabilities()
	return m
}

func (m *claudeCodeAccountManager) bootstrap() {
	m.bootstrapOnce.Do(func() {
		m.bootstrapErr = m.bootstrapInner()
		close(m.bootstrapDone)
	})
}

func cloneStringMap(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func runClaudeCodeCommand(ctx context.Context, binary string, args []string, env map[string]string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, binary, args...)
	cmd.Env = mergeCommandEnvironment(os.Environ(), env)
	return cmd.Output()
}

func mergeCommandEnvironment(base []string, override map[string]string) []string {
	values := make(map[string]string, len(base)+len(override))
	for _, item := range base {
		if index := strings.IndexByte(item, '='); index > 0 {
			values[item[:index]] = item[index+1:]
		}
	}
	for key, value := range override {
		values[key] = value
	}
	out := make([]string, 0, len(values))
	for key, value := range values {
		out = append(out, key+"="+value)
	}
	return out
}

func unknownClaudeCodeCapabilities() domain.ClaudeCodeAccountCapabilities {
	unknown := claudeCodeCapability(domain.ClaudeCodeCapabilityUnknown, "capability_unknown", "Claude Code account capabilities have not been checked.")
	return domain.ClaudeCodeAccountCapabilities{
		AccountRead: unknown, NativeLogin: unknown, AccountManagement: unknown,
		GlobalSwitch: unknown, HotReload: unknown, SessionExitResume: unknown,
	}
}

func claudeCodeCapability(state domain.ClaudeCodeCapabilityState, code, reason string) domain.ClaudeCodeCapabilityObservation {
	return domain.ClaudeCodeCapabilityObservation{State: state, ReasonCode: code, Reason: reason}
}

func (m *claudeCodeAccountManager) detectCapabilities(ctx context.Context) domain.ClaudeCodeAccountCapabilities {
	unsupported := func(code, reason string) domain.ClaudeCodeAccountCapabilities {
		value := claudeCodeCapability(domain.ClaudeCodeCapabilityUnsupported, code, reason)
		return domain.ClaudeCodeAccountCapabilities{
			AccountRead: value, NativeLogin: value, AccountManagement: value,
			GlobalSwitch: value, HotReload: value,
			SessionExitResume: claudeCodeCapability(domain.ClaudeCodeCapabilityUnsupported, "session_exit_resume_unsupported", "Session exit and resume is not used by hot switching."),
		}
	}
	if m.keychain == nil || !m.keychain.Supported() {
		return unsupported(domain.ClaudeCodeAccountReasonUnsupportedPlatform, "Claude Code account management is available on macOS only.")
	}
	if m.resolveExecutable == nil {
		return unsupported(domain.ClaudeCodeAccountReasonUnsupportedVersion, "Claude Code 2.1.220 or newer is required.")
	}
	binary, err := m.resolveExecutable(ctx)
	if err != nil || strings.TrimSpace(binary) == "" {
		return unsupported(domain.ClaudeCodeAccountReasonUnsupportedVersion, "Claude Code 2.1.220 or newer is required.")
	}
	checkCtx, cancel := context.WithTimeout(ctx, claudeCodeAuthTimeout)
	versionOutput, err := m.run(checkCtx, binary, []string{"--version"}, nil)
	cancel()
	if err != nil || !claudeCodeVersionAtLeast(string(versionOutput), 2, 1, 220) {
		return unsupported(domain.ClaudeCodeAccountReasonUnsupportedVersion, "Claude Code 2.1.220 or newer is required.")
	}
	supported := claudeCodeCapability(domain.ClaudeCodeCapabilitySupported, domain.ClaudeCodeAccountReasonSupported, "Supported.")
	caps := domain.ClaudeCodeAccountCapabilities{
		AccountRead: supported, NativeLogin: supported, AccountManagement: supported,
		GlobalSwitch: supported, HotReload: supported,
		SessionExitResume: claudeCodeCapability(domain.ClaudeCodeCapabilityUnsupported, "session_exit_resume_unsupported", "Session exit and resume is not used by hot switching."),
	}
	if name := m.activeAuthOverride(); name != "" {
		reason := "A daemon-level Claude authentication override disables device-global subscription switching."
		blocked := claudeCodeCapability(domain.ClaudeCodeCapabilityUnsupported, domain.ClaudeCodeAccountReasonEnvironmentAuthOverride, reason)
		caps.AccountManagement, caps.GlobalSwitch, caps.HotReload = blocked, blocked, blocked
	}
	return caps
}

var claudeCodeVersionPattern = regexp.MustCompile(`(?m)(\d+)\.(\d+)\.(\d+)`)

func claudeCodeVersionAtLeast(value string, major, minor, patch int) bool {
	match := claudeCodeVersionPattern.FindStringSubmatch(value)
	if len(match) != 4 {
		return false
	}
	got := [3]int{}
	for i := range got {
		got[i], _ = strconv.Atoi(match[i+1])
	}
	want := [3]int{major, minor, patch}
	for i := range got {
		if got[i] != want[i] {
			return got[i] > want[i]
		}
	}
	return true
}

func (m *claudeCodeAccountManager) activeAuthOverride() string {
	for _, key := range claudeCodeAuthOverrideVariables {
		value, ok := m.environment[key]
		if !ok {
			value = os.Getenv(key)
		}
		if strings.TrimSpace(value) != "" {
			return key
		}
	}
	return ""
}

func (m *claudeCodeAccountManager) bootstrapInner() error {
	for _, root := range []string{m.accountRoot, m.pendingRoot, m.switchStagingRoot} {
		if err := ensurePrivateDirectory(root); err != nil {
			return err
		}
	}
	if err := m.cleanupPendingRoot(m.pendingRoot); err != nil {
		return err
	}
	if err := m.cleanupPendingRoot(m.switchStagingRoot); err != nil {
		return err
	}
	if err := m.catalog.refresh(m.ctx, m.now()); err != nil {
		return err
	}
	if m.stateStore != nil {
		active, ok, err := m.stateStore.GetClaudeCodeActiveAccount(m.ctx)
		if err != nil {
			return err
		}
		if ok {
			m.mu.Lock()
			m.active = active
			m.mu.Unlock()
		}
	}
	caps := m.detectCapabilities(m.ctx)
	m.mu.Lock()
	m.caps = caps
	m.mu.Unlock()
	if caps.AccountRead.State != domain.ClaudeCodeCapabilitySupported {
		m.publish()
		return nil
	}
	if err := m.reconcileGlobal(m.ctx); err != nil {
		return err
	}
	m.publish()
	return nil
}

func (m *claudeCodeAccountManager) cleanupPendingRoot(root string) error {
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		path := filepath.Join(root, entry.Name())
		if entry.Type()&os.ModeSymlink != 0 || !entry.IsDir() || !pathWithin(root, path) {
			continue
		}
		if validateCodexDirectory(path, true) != nil {
			continue
		}
		authDir := filepath.Join(path, "auth")
		_ = m.keychain.Delete(context.Background(), claudecode.IsolatedCredentialService(authDir), m.keychainAccount)
		_ = os.RemoveAll(path)
	}
	return nil
}

func (m *claudeCodeAccountManager) reconcileGlobal(ctx context.Context) error {
	release, err := m.acquireMutation(ctx)
	if err != nil {
		return err
	}
	defer release()
	credential, found, err := m.keychain.Get(ctx, claudecode.ClaudeCanonicalCredentialService, m.keychainAccount)
	if err != nil {
		m.setUnmanaged("Device Claude Code account", nil, domain.ClaudeCodeAccountReasonKeychainUnavailable, "The macOS Keychain is unavailable.")
		m.disableSwitching(domain.ClaudeCodeAccountReasonKeychainUnavailable, "The macOS Keychain is unavailable.")
		return nil
	}
	if !found {
		return m.reconcileGlobalSignOut(ctx)
	}
	hasAccountCredential, credentialErr := claudecode.HasAccountCredential(credential)
	if credentialErr != nil {
		m.setUnmanaged("Device Claude Code account", nil, "global_account_unverified", "The device Claude Code credential is invalid.")
		m.disableSwitching("global_account_unverified", "The device Claude Code credential is invalid.")
		return nil
	}
	if !hasAccountCredential {
		return m.reconcileGlobalSignOut(ctx)
	}
	if err := m.verifyAuth(ctx, nil); err != nil {
		if errors.Is(err, errClaudeCodeAuthenticationSignedOut) {
			return m.reconcileGlobalSignOut(ctx)
		}
		m.setUnmanaged("Device Claude Code account", nil, "global_account_unverified", "AO could not verify the device Claude Code account.")
		m.disableSwitching("global_account_unverified", "AO could not verify the device Claude Code account.")
		return nil
	}
	identity, rawIdentity, err := readClaudeCodeOAuthIdentity(m.configPath)
	if err != nil {
		m.setUnmanaged("Device Claude Code account", nil, "global_account_identity_unverified", "AO could not safely identify the device Claude Code account.")
		m.disableSwitching("global_account_identity_unverified", "AO could not safely identify the device Claude Code account.")
		return nil
	}
	fields, err := claudecode.AccountCredentialFields(credential)
	if err != nil {
		m.setUnmanaged(claudeCodeAccountLabel(identity), optionalString(identity.EmailAddress), "global_account_unverified", "The device Claude Code credential is not a supported subscription credential.")
		m.disableSwitching("global_account_unverified", "The device Claude Code credential is not a supported subscription credential.")
		return nil
	}
	accountCredential, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	if _, err := m.catalog.upsert(ctx, identity, accountCredential, m.now()); err != nil {
		return err
	}
	latestCredential, latestFound, latestErr := m.keychain.Get(ctx, claudecode.ClaudeCanonicalCredentialService, m.keychainAccount)
	if latestErr != nil || !latestFound || !bytes.Equal(latestCredential, credential) {
		m.setUnmanaged(claudeCodeAccountLabel(identity), optionalString(identity.EmailAddress), "global_account_changed", "The device Claude Code account changed while AO was reconciling it.")
		return ports.ErrClaudeCodeGlobalAccountChanged
	}
	latestIdentity, _, latestIdentityErr := readClaudeCodeOAuthIdentity(m.configPath)
	if latestIdentityErr != nil || latestIdentity.AccountUUID != identity.AccountUUID || len(rawIdentity) == 0 {
		m.setUnmanaged(claudeCodeAccountLabel(identity), optionalString(identity.EmailAddress), "global_account_changed", "The device Claude Code account changed while AO was reconciling it.")
		return ports.ErrClaudeCodeGlobalAccountChanged
	}
	if err := m.setActivePointer(ctx, identity.AccountUUID); err != nil {
		return err
	}
	m.mu.Lock()
	m.unmanaged = nil
	m.mu.Unlock()
	return nil
}

func (m *claudeCodeAccountManager) reconcileGlobalSignOut(ctx context.Context) error {
	m.mu.Lock()
	m.unmanaged = nil
	activeID := m.active.AccountID
	m.mu.Unlock()
	if activeID == "" {
		return m.repairOrphanedValidAccounts(ctx)
	}
	if _, ok := m.catalog.record(activeID); !ok {
		return m.setActivePointer(ctx, "")
	}
	previous, previousFound, err := m.keychain.Get(ctx, claudecode.ClaudeAccountVaultService, activeID)
	if err != nil {
		return err
	}
	if err := m.catalog.markSignedOut(ctx, activeID, m.now()); err != nil {
		return err
	}
	m.resetPlanUsage(activeID)
	if err := m.setActivePointer(ctx, ""); err != nil {
		if previousFound {
			_ = m.keychain.Set(context.WithoutCancel(ctx), claudecode.ClaudeAccountVaultService, activeID, previous)
		}
		_ = m.catalog.refresh(context.WithoutCancel(ctx), m.now())
		m.resetPlanUsage(activeID)
		return err
	}
	return nil
}

// repairOrphanedValidAccounts repairs the state produced by older builds that
// saved isolated logins without ever activating the first account. Requiring
// every saved card to still be valid distinguishes that state from an explicit
// logout, which always leaves at least one signed-out card behind.
func (m *claudeCodeAccountManager) repairOrphanedValidAccounts(ctx context.Context) error {
	m.mu.Lock()
	globalSwitchSupported := m.caps.GlobalSwitch.State == domain.ClaudeCodeCapabilitySupported
	m.mu.Unlock()
	if !globalSwitchSupported {
		return nil
	}
	accounts := m.catalog.snapshots("")
	if len(accounts) == 0 {
		return nil
	}
	for _, account := range accounts {
		if account.Status != domain.ClaudeCodeAccountStatusValid {
			return nil
		}
	}
	target := accounts[0]
	credential, found, err := m.keychain.Get(ctx, claudecode.ClaudeAccountVaultService, target.ID)
	if err != nil {
		return err
	}
	if !found {
		return nil
	}
	return m.activateCredentialWithoutSource(ctx, credential, target.Identity)
}

func (m *claudeCodeAccountManager) setActivePointer(ctx context.Context, id string) error {
	m.mu.Lock()
	active := m.active
	m.mu.Unlock()
	if active.AccountID == id {
		return nil
	}
	if m.stateStore == nil {
		m.mu.Lock()
		m.active = domain.ClaudeCodeActiveAccount{AccountID: id, Revision: active.Revision + 1, ActivatedAt: m.now(), UpdatedAt: m.now()}
		m.mu.Unlock()
		m.invalidatePlanUsageAfterActiveChange(id)
		return nil
	}
	next, err := m.stateStore.SetClaudeCodeActiveAccount(ctx, id, active.Revision, m.now())
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.active = next
	m.mu.Unlock()
	m.invalidatePlanUsageAfterActiveChange(id)
	return nil
}

func (m *claudeCodeAccountManager) advanceActivePointer(ctx context.Context, id string) error {
	m.mu.Lock()
	active := m.active
	m.mu.Unlock()
	if active.AccountID != id {
		return ports.ErrClaudeCodeGlobalAccountChanged
	}
	if m.stateStore == nil {
		now := m.now()
		m.mu.Lock()
		m.active = domain.ClaudeCodeActiveAccount{AccountID: id, Revision: active.Revision + 1, ActivatedAt: now, UpdatedAt: now}
		m.mu.Unlock()
		m.invalidatePlanUsageAfterActiveChange(id)
		return nil
	}
	next, err := m.stateStore.SetClaudeCodeActiveAccount(ctx, id, active.Revision, m.now())
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.active = next
	m.mu.Unlock()
	m.invalidatePlanUsageAfterActiveChange(id)
	return nil
}

func (m *claudeCodeAccountManager) invalidatePlanUsageAfterActiveChange(activeID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, snapshot := range m.planUsage {
		snapshot.Promotion = nil
		if id == activeID {
			snapshot.AttemptedAt = nil
		}
		m.planUsage[id] = snapshot
	}
}

func (m *claudeCodeAccountManager) setUnmanaged(label string, email *string, code, reason string) {
	m.mu.Lock()
	m.unmanaged = &domain.ClaudeCodeUnmanagedGlobalAccount{Label: label, AccountEmail: email, ReasonCode: code, Reason: reason}
	m.mu.Unlock()
}

func (m *claudeCodeAccountManager) disableSwitching(code, reason string) {
	m.mu.Lock()
	blocked := claudeCodeCapability(domain.ClaudeCodeCapabilityUnsupported, code, reason)
	m.caps.GlobalSwitch, m.caps.HotReload = blocked, blocked
	m.mu.Unlock()
}

func (m *claudeCodeAccountManager) acquireMutation(ctx context.Context) (func(), error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-m.mutation:
		var once sync.Once
		return func() { once.Do(func() { m.mutation <- struct{}{} }) }, nil
	}
}

func (m *claudeCodeAccountManager) cached() ClaudeCodeAccounts {
	m.mu.Lock()
	active, caps, unmanaged := m.active, m.caps, m.unmanaged
	usage := make(map[string]domain.ClaudeCodePlanUsageSnapshot, len(m.planUsage))
	for id, snapshot := range m.planUsage {
		snapshot.Windows = append([]domain.ClaudeCodePlanUsageWindow(nil), snapshot.Windows...)
		if snapshot.Promotion != nil {
			promotion := *snapshot.Promotion
			snapshot.Promotion = &promotion
		}
		usage[id] = snapshot
	}
	var login *ClaudeCodeActiveLogin
	if m.login != nil && !terminalClaudeCodeLoginStatus(m.login.snapshot.Status) && m.login.terminalHandle != "" {
		login = &ClaudeCodeActiveLogin{
			OperationID: m.login.snapshot.OperationID, AccountID: m.login.snapshot.AccountID,
			Status: m.login.snapshot.Status, ReasonCode: m.login.snapshot.ReasonCode, Reason: m.login.snapshot.Reason,
			ExpiresAt:     m.login.snapshot.ExpiresAt,
			ShellTerminal: ClaudeCodeLoginTerminalDisplay{HandleID: m.login.terminalHandle, Title: m.login.terminalTitle, CreatedAt: m.login.terminalCreated},
		}
	}
	m.mu.Unlock()
	accounts := m.catalog.snapshots(active.AccountID)
	for index := range accounts {
		if snapshot, ok := usage[accounts[index].ID]; ok {
			if !accounts[index].Active {
				snapshot.Promotion = nil
			}
			accounts[index].PlanUsage = snapshot
		} else {
			accounts[index].PlanUsage = initialClaudeCodePlanUsage(accounts[index])
		}
	}
	return ClaudeCodeAccounts{
		ActiveAccountID: active.AccountID, AccountRevision: active.Revision,
		Accounts: accounts, Capabilities: caps,
		UnmanagedGlobalAccount: unmanaged, ActiveLogin: login,
	}
}

func (m *claudeCodeAccountManager) subscribe(ctx context.Context) <-chan ClaudeCodeAccounts {
	ch := make(chan ClaudeCodeAccounts, 1)
	m.mu.Lock()
	m.subscribers[ch] = struct{}{}
	m.mu.Unlock()
	ch <- m.cached()
	go func() {
		<-ctx.Done()
		m.mu.Lock()
		delete(m.subscribers, ch)
		close(ch)
		m.mu.Unlock()
	}()
	return ch
}

func (m *claudeCodeAccountManager) publish() {
	view := m.cached()
	m.mu.Lock()
	defer m.mu.Unlock()
	for ch := range m.subscribers {
		select {
		case ch <- view:
		default:
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- view:
			default:
			}
		}
	}
}

func (m *claudeCodeAccountManager) verifyAuth(ctx context.Context, isolatedEnv map[string]string) error {
	binary, err := m.resolveExecutable(ctx)
	if err != nil {
		return err
	}
	env := cloneStringMap(isolatedEnv)
	for _, key := range claudeCodeAuthOverrideVariables {
		env[key] = ""
	}
	checkCtx, cancel := context.WithTimeout(ctx, claudeCodeAuthTimeout)
	defer cancel()
	out, runErr := m.run(checkCtx, binary, []string{"auth", "status", "--json"}, env)
	var status struct {
		LoggedIn bool `json:"loggedIn"`
	}
	if err := json.Unmarshal(out, &status); err != nil {
		return errors.New("authentication could not be verified for Claude Code")
	}
	if !status.LoggedIn {
		return errClaudeCodeAuthenticationSignedOut
	}
	if runErr != nil {
		return errors.New("authentication could not be verified for Claude Code")
	}
	return nil
}

func readClaudeCodeOAuthIdentity(configPath string) (domain.ClaudeCodeAccountIdentity, map[string]any, error) {
	data, err := os.ReadFile(configPath)
	if err != nil {
		return domain.ClaudeCodeAccountIdentity{}, nil, err
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(data, &root); err != nil {
		return domain.ClaudeCodeAccountIdentity{}, nil, err
	}
	var raw map[string]any
	if len(root["oauthAccount"]) == 0 || json.Unmarshal(root["oauthAccount"], &raw) != nil {
		return domain.ClaudeCodeAccountIdentity{}, nil, errors.New("OAuth identity is missing for Claude Code")
	}
	stringField := func(key string) string {
		value, _ := raw[key].(string)
		return strings.TrimSpace(value)
	}
	identity := domain.ClaudeCodeAccountIdentity{
		AccountUUID: stringField("accountUuid"), EmailAddress: stringField("emailAddress"), DisplayName: stringField("displayName"),
		OrganizationUUID: stringField("organizationUuid"), OrganizationName: stringField("organizationName"),
		BillingType: stringField("billingType"), SeatTier: stringField("seatTier"),
	}
	if value := stringField("accountCreatedAt"); value != "" {
		identity.AccountCreatedAt = &value
	}
	if value := stringField("subscriptionCreatedAt"); value != "" {
		identity.SubscriptionCreatedAt = &value
	}
	if !validClaudeCodeAccountIdentity(identity) {
		return domain.ClaudeCodeAccountIdentity{}, nil, errors.New("OAuth identity is invalid for Claude Code")
	}
	allowed := map[string]struct{}{
		"accountUuid": {}, "emailAddress": {}, "displayName": {}, "organizationUuid": {}, "organizationName": {},
		"billingType": {}, "seatTier": {}, "accountCreatedAt": {}, "subscriptionCreatedAt": {},
	}
	sanitized := make(map[string]any)
	for key := range allowed {
		if value, ok := raw[key]; ok {
			sanitized[key] = value
		}
	}
	return identity, sanitized, nil
}

func readOptionalClaudeCodeOAuthIdentity(configPath string) (map[string]any, error) {
	data, err := os.ReadFile(configPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(data, &root); err != nil {
		return nil, err
	}
	raw, ok := root["oauthAccount"]
	if !ok || len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, nil
	}
	_, identity, err := readClaudeCodeOAuthIdentity(configPath)
	return identity, err
}

func validClaudeCodeAccountIdentity(identity domain.ClaudeCodeAccountIdentity) bool {
	return validClaudeCodeAccountID(identity.AccountUUID)
}

func terminalClaudeCodeLoginStatus(status domain.ClaudeCodeAccountLoginStatus) bool {
	return status == domain.ClaudeCodeAccountLoginCompleted || status == domain.ClaudeCodeAccountLoginCancelled ||
		status == domain.ClaudeCodeAccountLoginExpired || status == domain.ClaudeCodeAccountLoginFailed
}

func (m *claudeCodeAccountManager) acquireExclusive(ctx context.Context) (ports.ClaudeCodeOperationLease, error) {
	if m.operationGate == nil {
		return nil, nil
	}
	return m.operationGate.AcquireExclusive(ctx)
}

func (m *claudeCodeAccountManager) ensureExpectedActive(id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.active.AccountID != id {
		return fmt.Errorf("active Claude Code account changed: %w", ports.ErrClaudeCodeGlobalAccountChanged)
	}
	return nil
}
