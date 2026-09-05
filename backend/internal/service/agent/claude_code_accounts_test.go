package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/claudecode"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/shellterm"
)

const (
	testClaudeAccountA = "11111111-1111-4111-8111-111111111111"
	testClaudeAccountB = "22222222-2222-4222-8222-222222222222"
)

type fakeClaudeCodeKeychain struct {
	mu        sync.Mutex
	supported bool
	items     map[string][]byte
	err       error
}

func (f *fakeClaudeCodeKeychain) Supported() bool { return f.supported }
func (f *fakeClaudeCodeKeychain) Get(_ context.Context, service, account string) ([]byte, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return nil, false, f.err
	}
	value, ok := f.items[service+"\x00"+account]
	return append([]byte(nil), value...), ok, nil
}
func (f *fakeClaudeCodeKeychain) Set(_ context.Context, service, account string, value []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	f.items[service+"\x00"+account] = append([]byte(nil), value...)
	return nil
}
func (f *fakeClaudeCodeKeychain) Delete(_ context.Context, service, account string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.err != nil {
		return f.err
	}
	delete(f.items, service+"\x00"+account)
	return nil
}

type fakeClaudeCodeStateStore struct {
	mu     sync.Mutex
	active domain.ClaudeCodeActiveAccount
	found  bool
	setErr error
}

type fakeClaudeCodeUsageReader struct {
	mu        sync.Mutex
	observed  map[string]ports.ClaudeCodePlanUsageObservation
	errors    map[string]error
	planCalls map[string]int
}

func (f *fakeClaudeCodeUsageReader) ReadPlanUsage(_ context.Context, accountID string) (ports.ClaudeCodePlanUsageObservation, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.planCalls[accountID]++
	return f.observed[accountID], f.errors[accountID]
}

func (s *fakeClaudeCodeStateStore) GetClaudeCodeActiveAccount(context.Context) (domain.ClaudeCodeActiveAccount, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.active, s.found, nil
}
func (s *fakeClaudeCodeStateStore) SetClaudeCodeActiveAccount(_ context.Context, id string, expected int64, at time.Time) (domain.ClaudeCodeActiveAccount, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.setErr != nil {
		return domain.ClaudeCodeActiveAccount{}, s.setErr
	}
	if (!s.found && expected != 0) || (s.found && s.active.Revision != expected) {
		return domain.ClaudeCodeActiveAccount{}, ports.ErrClaudeCodeAccountRevisionConflict
	}
	s.active = domain.ClaudeCodeActiveAccount{AccountID: id, Revision: expected + 1, ActivatedAt: at, UpdatedAt: at}
	s.found = true
	return s.active, nil
}

type fakeClaudeCodeTerminal struct {
	opened []shellterm.OpenCommandTerminalInput
	closed []string
	result shellterm.ShellTerminal
	onOpen func(shellterm.OpenCommandTerminalInput) error
}

func (f *fakeClaudeCodeTerminal) OpenCommandTerminal(_ context.Context, in shellterm.OpenCommandTerminalInput) (shellterm.ShellTerminal, error) {
	f.opened = append(f.opened, in)
	if f.onOpen != nil {
		if err := f.onOpen(in); err != nil {
			return shellterm.ShellTerminal{}, err
		}
	}
	return f.result, nil
}
func (f *fakeClaudeCodeTerminal) CloseShellTerminal(_ context.Context, id string) error {
	f.closed = append(f.closed, id)
	return nil
}

func claudeIdentityJSON(id, email string) []byte {
	return []byte(`{"oauthAccount":{"accountUuid":"` + id + `","emailAddress":"` + email + `","displayName":"Test User","organizationUuid":"33333333-3333-4333-8333-333333333333","organizationName":"Example","billingType":"stripe_subscription","seatTier":"pro"},"theme":"dark"}`)
}

func claudeCredentialJSON(token string) []byte {
	return []byte(`{"claudeAiOauth":{"accessToken":"` + token + `","refreshToken":"refresh-` + token + `"},"trustedDeviceToken":"device-` + token + `","futureAccountField":{"owner":"` + token + `"},"mcpOAuth":{"shared":"keep"}}`)
}

func newTestClaudeCodeManager(t *testing.T) (*claudeCodeAccountManager, *fakeClaudeCodeKeychain, *fakeClaudeCodeStateStore, string) {
	t.Helper()
	root := t.TempDir()
	home := filepath.Join(root, "home")
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o700); err != nil {
		t.Fatal(err)
	}
	keychain := &fakeClaudeCodeKeychain{supported: true, items: map[string][]byte{}}
	state := &fakeClaudeCodeStateStore{}
	m := newClaudeCodeAccountManager(claudeCodeAccountManagerDeps{
		Context: context.Background(), AccountRoot: filepath.Join(root, "accounts"),
		PendingRoot: filepath.Join(root, "pending"), SwitchStagingRoot: filepath.Join(root, "staging"),
		Home: home, Keychain: keychain, KeychainAccount: "test-user", StateStore: state,
		ResolveExecutable: func(context.Context) (string, error) { return "/fake/claude", nil },
		LoginExecutable:   func() (string, error) { return "/fake/ao", nil },
		Run: func(_ context.Context, _ string, args []string, _ map[string]string) ([]byte, error) {
			if reflect.DeepEqual(args, []string{"--version"}) {
				return []byte("2.1.220 (Claude Code)"), nil
			}
			if reflect.DeepEqual(args, []string{"auth", "status", "--json"}) {
				return []byte(`{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}`), nil
			}
			return nil, errors.New("unexpected Claude command")
		},
	})
	return m, keychain, state, home
}

func TestClaudeCodeUsageRefreshReadsEverySavedAccountWithoutSwitching(t *testing.T) {
	m, keychain, state, home := newTestClaudeCodeManager(t)
	credentialA := claudeCredentialJSON("secret-a")
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = credentialA
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	if _, err := m.catalog.upsert(context.Background(), domain.ClaudeCodeAccountIdentity{AccountUUID: testClaudeAccountB, EmailAddress: "b@example.com", SeatTier: "max"}, claudeCredentialJSON("secret-b"), m.now()); err != nil {
		t.Fatal(err)
	}
	now := m.now()
	planA := "pro"
	planB := "max"
	reader := &fakeClaudeCodeUsageReader{
		observed: map[string]ports.ClaudeCodePlanUsageObservation{
			testClaudeAccountA: {
				Plan: &planA, Promotion: &domain.ClaudeCodePlanPromotion{PercentIncrease: 50, EndsOn: "2026-09-13"},
				Windows: []domain.ClaudeCodePlanUsageWindow{{ID: "five_hour", DisplayName: "5-hour limit", UsedPercent: 12}}, ObservedAt: now,
			},
			testClaudeAccountB: {
				Plan: &planB, Windows: []domain.ClaudeCodePlanUsageWindow{{ID: "seven_day", DisplayName: "Weekly — all models", UsedPercent: 34}}, ObservedAt: now,
			},
		},
		errors: map[string]error{}, planCalls: map[string]int{},
	}
	m.usageReader = reader
	revisionBefore := state.active.Revision
	canonicalBefore := append([]byte(nil), keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"]...)
	m.refreshUsage(context.Background())

	view := m.cached()
	if state.active.Revision != revisionBefore || !reflect.DeepEqual(canonicalBefore, keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"]) {
		t.Fatal("usage refresh changed the global Claude account")
	}
	if len(view.Accounts) != 2 || view.Accounts[0].PlanUsage.State != domain.ClaudeCodePlanUsageAvailable || view.Accounts[1].PlanUsage.State != domain.ClaudeCodePlanUsageAvailable {
		t.Fatalf("per-account usage = %+v", view.Accounts)
	}
	if view.Accounts[0].PlanUsage.Plan == nil || *view.Accounts[0].PlanUsage.Plan != "pro" || view.Accounts[0].PlanUsage.Promotion == nil || view.Accounts[0].PlanUsage.Promotion.PercentIncrease != 50 {
		t.Fatalf("active account plan = %+v", view.Accounts[0].PlanUsage)
	}
	if view.Accounts[1].PlanUsage.Plan == nil || *view.Accounts[1].PlanUsage.Plan != "max" || view.Accounts[1].PlanUsage.Promotion != nil {
		t.Fatalf("inactive account plan = %+v", view.Accounts[1].PlanUsage)
	}
	m.refreshUsage(context.Background())
	if reader.planCalls[testClaudeAccountA] != 1 || reader.planCalls[testClaudeAccountB] != 1 {
		t.Fatalf("usage cache was bypassed: calls=%v", reader.planCalls)
	}
}

func TestClaudeCodeUsageKeepsProAndBoostMetadataWhenLimitsAreUnavailable(t *testing.T) {
	m, keychain, _, home := newTestClaudeCodeManager(t)
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = claudeCredentialJSON("secret-a")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	plan := "pro"
	m.usageReader = &fakeClaudeCodeUsageReader{
		observed: map[string]ports.ClaudeCodePlanUsageObservation{
			testClaudeAccountA: {Plan: &plan, Promotion: &domain.ClaudeCodePlanPromotion{PercentIncrease: 50, EndsOn: "2026-09-13"}},
		},
		errors: map[string]error{testClaudeAccountA: ports.ErrClaudeCodePlanUsageUnavailable}, planCalls: map[string]int{},
	}
	m.refreshUsage(context.Background())

	usage := m.cached().Accounts[0].PlanUsage
	if usage.Plan == nil || *usage.Plan != "pro" || usage.Promotion == nil || usage.Promotion.PercentIncrease != 50 {
		t.Fatalf("plan metadata = %+v", usage)
	}
	if usage.State != domain.ClaudeCodePlanUsageUnknown || usage.Freshness != domain.AgentReadinessStale {
		t.Fatalf("unavailable limit state = %+v", usage)
	}
}

func TestClaudeCodePlanDoesNotTreatStripeBillingAsThePlanName(t *testing.T) {
	if plan := claudeCodeAccountPlan(domain.ClaudeCodeAccountIdentity{BillingType: "stripe_subscription"}); plan != nil {
		t.Fatalf("billing mechanism was exposed as plan: %q", *plan)
	}
	if plan := claudeCodeAccountPlan(domain.ClaudeCodeAccountIdentity{SeatTier: "claude_pro"}); plan == nil || *plan != "pro" {
		t.Fatalf("native Claude plan = %v, want pro", plan)
	}
}

func TestClaudeCodeBootstrapImportsCanonicalAccountWithoutPersistingSecrets(t *testing.T) {
	m, keychain, state, home := newTestClaudeCodeManager(t)
	credential := claudeCredentialJSON("secret-a")
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = credential
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	if !state.found || state.active.AccountID != testClaudeAccountA || state.active.Revision != 1 {
		t.Fatalf("active pointer = %+v found=%v", state.active, state.found)
	}
	stored, ok, err := keychain.Get(context.Background(), claudecode.ClaudeAccountVaultService, testClaudeAccountA)
	if err != nil || !ok || len(stored) == 0 {
		t.Fatalf("vault credential: ok=%v err=%v", ok, err)
	}
	if string(stored) == string(credential) {
		t.Fatal("vault retained live shared fields instead of account-owned projection")
	}
	descriptor, err := os.ReadFile(filepath.Join(m.accountRoot, testClaudeAccountA, claudeCodeAccountDescriptorFilename))
	if err != nil {
		t.Fatal(err)
	}
	if json.Valid(descriptor) == false || containsAny(string(descriptor), "secret-a", "refresh-secret-a", "Claude Code-credentials") {
		t.Fatalf("descriptor contains invalid or secret data: %s", descriptor)
	}
}

func TestClaudeCodeAddFirstAccountActivatesCanonicalCredential(t *testing.T) {
	m, keychain, state, home := newTestClaudeCodeManager(t)
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	terminal := &fakeClaudeCodeTerminal{result: shellterm.ShellTerminal{HandleID: "terminal-1", Title: "Add Claude Code account", CreatedAt: time.Now().UTC()}}
	terminal.onOpen = func(in shellterm.OpenCommandTerminalInput) error {
		if err := os.WriteFile(filepath.Join(in.Env["CLAUDE_CONFIG_DIR"], ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
			return err
		}
		return keychain.Set(context.Background(), claudecode.IsolatedCredentialService(in.Env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]), "test-user", claudeCredentialJSON("secret-a"))
	}
	m.terminal = terminal
	started, err := m.openLoginTerminal(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	result, err := m.verifyLogin(context.Background(), started.Operation.OperationID)
	if err != nil || result.Status != domain.ClaudeCodeAccountLoginCompleted || result.Account == nil || !result.Account.Active {
		t.Fatalf("first Add: result=%+v err=%v", result, err)
	}
	if !state.found || state.active.AccountID != testClaudeAccountA || state.active.Revision != 1 {
		t.Fatalf("active pointer = %+v found=%v", state.active, state.found)
	}
	canonical, found, err := keychain.Get(context.Background(), claudecode.ClaudeCanonicalCredentialService, "test-user")
	if err != nil || !found {
		t.Fatalf("canonical credential: found=%v err=%v", found, err)
	}
	if has, err := claudecode.HasAccountCredential(canonical); err != nil || !has || strings.Contains(string(canonical), `"mcpOAuth"`) {
		t.Fatalf("canonical credential was not activated safely: has=%v err=%v", has, err)
	}
	identity, _, err := readClaudeCodeOAuthIdentity(filepath.Join(home, ".claude.json"))
	if err != nil || identity.AccountUUID != testClaudeAccountA {
		t.Fatalf("canonical identity = %+v err=%v", identity, err)
	}
}

func TestClaudeCodeAddAccountLeavesCanonicalAccountUnchanged(t *testing.T) {
	m, keychain, state, home := newTestClaudeCodeManager(t)
	canonicalCredential := claudeCredentialJSON("secret-a")
	canonicalConfig := claudeIdentityJSON(testClaudeAccountA, "a@example.com")
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = canonicalCredential
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), canonicalConfig, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}

	terminal := &fakeClaudeCodeTerminal{result: shellterm.ShellTerminal{HandleID: "terminal-1", Title: "Add Claude Code account", CreatedAt: time.Now().UTC()}}
	terminal.onOpen = func(in shellterm.OpenCommandTerminalInput) error {
		configDir, authDir := in.Env["CLAUDE_CONFIG_DIR"], in.Env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]
		if err := os.WriteFile(filepath.Join(configDir, ".claude.json"), claudeIdentityJSON(testClaudeAccountB, "b@example.com"), 0o600); err != nil {
			return err
		}
		return keychain.Set(context.Background(), claudecode.IsolatedCredentialService(authDir), "test-user", claudeCredentialJSON("secret-b"))
	}
	m.terminal = terminal
	started, err := m.openLoginTerminal(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	result, err := m.verifyLogin(context.Background(), started.Operation.OperationID)
	if err != nil || result.Status != domain.ClaudeCodeAccountLoginCompleted || result.Account == nil || result.Account.ID != testClaudeAccountB {
		t.Fatalf("verify Add: result=%+v err=%v", result, err)
	}
	if state.active.AccountID != testClaudeAccountA || state.active.Revision != 1 {
		t.Fatalf("Add changed active pointer: %+v", state.active)
	}
	gotCanonical, _, _ := keychain.Get(context.Background(), claudecode.ClaudeCanonicalCredentialService, "test-user")
	if !reflect.DeepEqual(gotCanonical, canonicalCredential) {
		t.Fatal("Add changed canonical Keychain credential")
	}
	gotConfig, err := os.ReadFile(filepath.Join(home, ".claude.json"))
	if err != nil || !reflect.DeepEqual(gotConfig, canonicalConfig) {
		t.Fatalf("Add changed canonical config: err=%v", err)
	}
	if len(terminal.opened) != 1 || !reflect.DeepEqual(terminal.opened[0].Argv, []string{"/fake/ao", "claude-code-login", "--claude-binary", "/fake/claude"}) {
		t.Fatalf("login argv = %#v", terminal.opened)
	}
	for _, key := range claudeCodeAuthOverrideVariables {
		if value, ok := terminal.opened[0].Env[key]; !ok || value != "" {
			t.Fatalf("override %s was not explicitly cleared", key)
		}
	}
}

func TestClaudeCodeReconcileRepairsAllValidAccountsWithoutActivePointer(t *testing.T) {
	m, keychain, state, home := newTestClaudeCodeManager(t)
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	createdAt := time.Date(2026, 9, 2, 9, 0, 0, 0, time.UTC)
	if _, err := m.catalog.upsert(context.Background(), domain.ClaudeCodeAccountIdentity{
		AccountUUID: testClaudeAccountA, EmailAddress: "a@example.com", DisplayName: "Account A",
	}, claudeCredentialJSON("secret-a"), createdAt); err != nil {
		t.Fatal(err)
	}
	if _, err := m.catalog.upsert(context.Background(), domain.ClaudeCodeAccountIdentity{
		AccountUUID: testClaudeAccountB, EmailAddress: "b@example.com", DisplayName: "Account B",
	}, claudeCredentialJSON("secret-b"), createdAt.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}

	if err := m.reconcileGlobal(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !state.found || state.active.AccountID != testClaudeAccountA || state.active.Revision != 1 {
		t.Fatalf("repaired active pointer = %+v found=%v", state.active, state.found)
	}
	canonical, found, err := keychain.Get(context.Background(), claudecode.ClaudeCanonicalCredentialService, "test-user")
	if err != nil || !found || !strings.Contains(string(canonical), "secret-a") || strings.Contains(string(canonical), "secret-b") {
		t.Fatalf("repaired canonical credential: found=%v err=%v value=%s", found, err, canonical)
	}
	identity, _, err := readClaudeCodeOAuthIdentity(filepath.Join(home, ".claude.json"))
	if err != nil || identity.AccountUUID != testClaudeAccountA {
		t.Fatalf("repaired canonical identity = %+v err=%v", identity, err)
	}
}

func TestClaudeCodeActivateSavedAccountWhenNoAccountIsActive(t *testing.T) {
	m, keychain, state, home := newTestClaudeCodeManager(t)
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	if _, err := m.catalog.upsert(context.Background(), domain.ClaudeCodeAccountIdentity{
		AccountUUID: testClaudeAccountB, EmailAddress: "b@example.com", DisplayName: "Account B",
	}, claudeCredentialJSON("secret-b"), m.now()); err != nil {
		t.Fatal(err)
	}

	if err := m.activateAccount(context.Background(), testClaudeAccountB); err != nil {
		t.Fatal(err)
	}
	if !state.found || state.active.AccountID != testClaudeAccountB || state.active.Revision != 1 {
		t.Fatalf("active pointer = %+v found=%v", state.active, state.found)
	}
	canonical, found, err := keychain.Get(context.Background(), claudecode.ClaudeCanonicalCredentialService, "test-user")
	if err != nil || !found || !strings.Contains(string(canonical), "secret-b") {
		t.Fatalf("canonical credential: found=%v err=%v value=%s", found, err, canonical)
	}
	identity, _, err := readClaudeCodeOAuthIdentity(filepath.Join(home, ".claude.json"))
	if err != nil || identity.AccountUUID != testClaudeAccountB {
		t.Fatalf("canonical identity = %+v err=%v", identity, err)
	}
}

func TestClaudeCodeReconcileImportsExternalAccountChangeAndAdvancesRevision(t *testing.T) {
	m, keychain, state, home := newTestClaudeCodeManager(t)
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = claudeCredentialJSON("secret-a")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	if err := keychain.Set(context.Background(), claudecode.ClaudeCanonicalCredentialService, "test-user", claudeCredentialJSON("secret-b")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountB, "b@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.reconcileGlobal(context.Background()); err != nil {
		t.Fatal(err)
	}
	if state.active.AccountID != testClaudeAccountB || state.active.Revision != 2 {
		t.Fatalf("external account pointer = %+v", state.active)
	}
	if got := m.cached(); len(got.Accounts) != 2 || got.UnmanagedGlobalAccount != nil {
		t.Fatalf("reconciled accounts = %+v", got)
	}
}

func TestClaudeCodeReconcileSignedOutCanonicalClearsActivePointer(t *testing.T) {
	m, keychain, state, home := newTestClaudeCodeManager(t)
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = claudeCredentialJSON("secret-a")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	if err := keychain.Delete(context.Background(), claudecode.ClaudeCanonicalCredentialService, "test-user"); err != nil {
		t.Fatal(err)
	}
	if err := m.reconcileGlobal(context.Background()); err != nil {
		t.Fatal(err)
	}
	if state.active.AccountID != "" || state.active.Revision != 2 {
		t.Fatalf("signed-out pointer = %+v", state.active)
	}
	view := m.cached()
	if len(view.Accounts) != 1 || view.Accounts[0].Status != domain.ClaudeCodeAccountStatusSignedOut || view.Accounts[0].Authentication.State != domain.AgentAuthenticationUnauthorized {
		t.Fatalf("signed-out account = %+v", view.Accounts)
	}
	if _, found, err := keychain.Get(context.Background(), claudecode.ClaudeAccountVaultService, testClaudeAccountA); err != nil || found {
		t.Fatalf("signed-out vault credential: found=%v err=%v", found, err)
	}
}

func TestClaudeCodeReconcileSharedOnlyCanonicalMarksActiveAccountSignedOut(t *testing.T) {
	m, keychain, state, home := newTestClaudeCodeManager(t)
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = claudeCredentialJSON("secret-a")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = []byte(`{"pluginSecrets":{"shared":"keep"}}`)
	if err := m.reconcileGlobal(context.Background()); err != nil {
		t.Fatal(err)
	}
	view := m.cached()
	if state.active.AccountID != "" || len(view.Accounts) != 1 || view.Accounts[0].Status != domain.ClaudeCodeAccountStatusSignedOut {
		t.Fatalf("shared-only logout state: active=%+v accounts=%+v", state.active, view.Accounts)
	}
	canonical, found, err := keychain.Get(context.Background(), claudecode.ClaudeCanonicalCredentialService, "test-user")
	if err != nil || !found || string(canonical) != `{"pluginSecrets":{"shared":"keep"}}` {
		t.Fatalf("shared canonical fields changed: found=%v err=%v", found, err)
	}
}

func TestClaudeCodeReconcileLoggedOutStatusWithExitOneMarksActiveAccountSignedOut(t *testing.T) {
	m, keychain, state, home := newTestClaudeCodeManager(t)
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = claudeCredentialJSON("secret-a")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	m.run = func(_ context.Context, _ string, args []string, _ map[string]string) ([]byte, error) {
		if reflect.DeepEqual(args, []string{"auth", "status", "--json"}) {
			return []byte(`{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty"}`), errors.New("exit status 1")
		}
		return nil, errors.New("unexpected command")
	}
	if err := m.reconcileGlobal(context.Background()); err != nil {
		t.Fatal(err)
	}
	view := m.cached()
	if state.active.AccountID != "" || len(view.Accounts) != 1 || view.Accounts[0].Status != domain.ClaudeCodeAccountStatusSignedOut || view.Accounts[0].Authentication.State != domain.AgentAuthenticationUnauthorized {
		t.Fatalf("exit-one logout state: active=%+v accounts=%+v", state.active, view.Accounts)
	}
}

func TestClaudeCodeKeychainFailureAndAuthOverrideSuppressSwitchCapability(t *testing.T) {
	m, keychain, _, home := newTestClaudeCodeManager(t)
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = claudeCredentialJSON("secret-a")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	keychain.err = errors.New("interaction denied")
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	view := m.cached()
	if view.UnmanagedGlobalAccount == nil || view.Capabilities.GlobalSwitch.State != domain.ClaudeCodeCapabilityUnsupported {
		t.Fatalf("Keychain failure view = %+v", view)
	}

	m2, _, _, _ := newTestClaudeCodeManager(t)
	m2.environment = map[string]string{"ANTHROPIC_AUTH_TOKEN": "daemon-token"}
	caps := m2.detectCapabilities(context.Background())
	if caps.AccountRead.State != domain.ClaudeCodeCapabilitySupported || caps.GlobalSwitch.ReasonCode != domain.ClaudeCodeAccountReasonEnvironmentAuthOverride {
		t.Fatalf("override capabilities = %+v", caps)
	}
}

func TestClaudeCodeActiveLogoutPreservesSharedCredentialAndDeletesLocally(t *testing.T) {
	m, keychain, state, home := newTestClaudeCodeManager(t)
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = claudeCredentialJSON("secret-a")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	if err := m.logout(context.Background(), testClaudeAccountA); err != nil {
		t.Fatal(err)
	}
	canonical, found, err := keychain.Get(context.Background(), claudecode.ClaudeCanonicalCredentialService, "test-user")
	if err != nil || !found {
		t.Fatalf("shared canonical credential missing: found=%v err=%v", found, err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(canonical, &fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 1 || len(fields["mcpOAuth"]) == 0 {
		t.Fatalf("logout canonical fields = %v", fields)
	}
	if _, ok, _ := keychain.Get(context.Background(), claudecode.ClaudeAccountVaultService, testClaudeAccountA); ok {
		t.Fatal("logout retained AO vault credential")
	}
	_, rawIdentity, err := readClaudeCodeOAuthIdentity(filepath.Join(home, ".claude.json"))
	if err == nil || rawIdentity != nil {
		t.Fatal("logout retained oauthAccount")
	}
	view := m.cached()
	if view.ActiveAccountID != "" || state.active.Revision != 2 || len(view.Accounts) != 1 || view.Accounts[0].Status != domain.ClaudeCodeAccountStatusSignedOut {
		t.Fatalf("logout view = %+v pointer=%+v", view, state.active)
	}
	if err := m.reconcileGlobal(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := m.cached(); got.ActiveAccountID != "" || got.Accounts[0].Status != domain.ClaudeCodeAccountStatusSignedOut {
		t.Fatalf("explicit logout was repaired unexpectedly: %+v", got)
	}
	if err := m.deleteAccount(context.Background(), testClaudeAccountA); err != nil {
		t.Fatal(err)
	}
	if len(m.cached().Accounts) != 0 {
		t.Fatal("delete retained signed-out account")
	}
}

func TestClaudeCodeDeleteRequiresInactiveSignedOutAccount(t *testing.T) {
	m, keychain, _, home := newTestClaudeCodeManager(t)
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = claudeCredentialJSON("secret-a")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	if _, err := m.catalog.upsert(context.Background(), domain.ClaudeCodeAccountIdentity{
		AccountUUID: testClaudeAccountB, EmailAddress: "b@example.com", DisplayName: "Account B",
	}, claudeCredentialJSON("secret-b"), m.now()); err != nil {
		t.Fatal(err)
	}

	if err := m.deleteAccount(context.Background(), testClaudeAccountB); !errors.Is(err, ports.ErrClaudeCodeAccountDeleteRequiresLogout) {
		t.Fatalf("delete signed-in account error = %v", err)
	}
	if _, found, err := keychain.Get(context.Background(), claudecode.ClaudeAccountVaultService, testClaudeAccountB); err != nil || !found {
		t.Fatalf("rejected delete changed credential: found=%v err=%v", found, err)
	}
	if err := m.logout(context.Background(), testClaudeAccountB); err != nil {
		t.Fatal(err)
	}
	if err := m.deleteAccount(context.Background(), testClaudeAccountB); err != nil {
		t.Fatal(err)
	}
	if _, found, err := keychain.Get(context.Background(), claudecode.ClaudeAccountVaultService, testClaudeAccountB); err != nil || found {
		t.Fatalf("deleted account credential: found=%v err=%v", found, err)
	}
	if _, err := os.Stat(filepath.Join(m.accountRoot, testClaudeAccountB)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("deleted account profile still exists: %v", err)
	}
	view := m.cached()
	if len(view.Accounts) != 1 || view.Accounts[0].ID != testClaudeAccountA {
		t.Fatalf("accounts after delete = %+v", view.Accounts)
	}
}

func TestClaudeCodeDeleteRechecksActiveAccountAfterWaitingForMutation(t *testing.T) {
	m, keychain, _, home := newTestClaudeCodeManager(t)
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = claudeCredentialJSON("secret-a")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	if _, err := m.catalog.upsert(context.Background(), domain.ClaudeCodeAccountIdentity{
		AccountUUID: testClaudeAccountB, EmailAddress: "b@example.com", DisplayName: "Account B",
	}, claudeCredentialJSON("secret-b"), m.now()); err != nil {
		t.Fatal(err)
	}

	release, err := m.acquireMutation(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- m.deleteAccount(context.Background(), testClaudeAccountB) }()
	m.mu.Lock()
	m.active = domain.ClaudeCodeActiveAccount{AccountID: testClaudeAccountB, Revision: 2}
	m.mu.Unlock()
	release()

	if err := <-done; !errors.Is(err, ports.ErrClaudeCodeAccountAlreadyActive) {
		t.Fatalf("delete error = %v", err)
	}
	if _, ok := m.catalog.record(testClaudeAccountB); !ok {
		t.Fatal("delete removed the account that became active while waiting")
	}
}

func TestClaudeCodeActiveReauthenticationUpdatesCanonicalAndAdvancesRevision(t *testing.T) {
	m, keychain, state, home := newTestClaudeCodeManager(t)
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = claudeCredentialJSON("secret-a")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	terminal := &fakeClaudeCodeTerminal{result: shellterm.ShellTerminal{HandleID: "terminal-reauth", Title: "Sign in", CreatedAt: time.Now().UTC()}}
	terminal.onOpen = func(in shellterm.OpenCommandTerminalInput) error {
		if err := os.WriteFile(filepath.Join(in.Env["CLAUDE_CONFIG_DIR"], ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
			return err
		}
		return keychain.Set(context.Background(), claudecode.IsolatedCredentialService(in.Env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]), "test-user", claudeCredentialJSON("renewed-a"))
	}
	m.terminal = terminal
	started, err := m.openLoginTerminal(context.Background(), testClaudeAccountA)
	if err != nil {
		t.Fatal(err)
	}
	result, err := m.verifyLogin(context.Background(), started.Operation.OperationID)
	if err != nil || result.Status != domain.ClaudeCodeAccountLoginCompleted {
		t.Fatalf("reauth result=%+v err=%v", result, err)
	}
	if state.active.Revision != 2 || state.active.AccountID != testClaudeAccountA {
		t.Fatalf("reauth pointer = %+v", state.active)
	}
	canonical, _, _ := keychain.Get(context.Background(), claudecode.ClaudeCanonicalCredentialService, "test-user")
	if !containsAny(string(canonical), "renewed-a", `"shared":"keep"`) || containsAny(string(canonical), "secret-a") {
		t.Fatal("reauth did not replace account-owned fields while retaining shared fields")
	}
}

func TestClaudeCodeActiveReauthenticationRollsBackCanonicalWhenPointerAdvanceFails(t *testing.T) {
	m, keychain, state, home := newTestClaudeCodeManager(t)
	originalCredential := claudeCredentialJSON("secret-a")
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = originalCredential
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	state.setErr = errors.New("injected pointer failure")
	terminal := &fakeClaudeCodeTerminal{result: shellterm.ShellTerminal{HandleID: "terminal-reauth-failure", Title: "Sign in", CreatedAt: time.Now().UTC()}}
	terminal.onOpen = func(in shellterm.OpenCommandTerminalInput) error {
		if err := os.WriteFile(filepath.Join(in.Env["CLAUDE_CONFIG_DIR"], ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
			return err
		}
		return keychain.Set(context.Background(), claudecode.IsolatedCredentialService(in.Env["CLAUDE_SECURESTORAGE_CONFIG_DIR"]), "test-user", claudeCredentialJSON("renewed-a"))
	}
	m.terminal = terminal
	started, err := m.openLoginTerminal(context.Background(), testClaudeAccountA)
	if err != nil {
		t.Fatal(err)
	}
	result, err := m.verifyLogin(context.Background(), started.Operation.OperationID)
	if err != nil || result.Status != domain.ClaudeCodeAccountLoginFailed || result.ReasonCode != "credential_activation_failed" {
		t.Fatalf("reauth result=%+v err=%v", result, err)
	}
	canonical, found, err := keychain.Get(context.Background(), claudecode.ClaudeCanonicalCredentialService, "test-user")
	if err != nil || !found || !reflect.DeepEqual(canonical, originalCredential) {
		t.Fatalf("canonical credential was not rolled back: found=%v err=%v value=%s", found, err, canonical)
	}
	identity, _, err := readClaudeCodeOAuthIdentity(filepath.Join(home, ".claude.json"))
	if err != nil || identity.AccountUUID != testClaudeAccountA || state.active.Revision != 1 {
		t.Fatalf("reauth rollback identity=%+v pointer=%+v err=%v", identity, state.active, err)
	}
}

func TestClaudeCodeCredentialSwitchPreservesSharedFieldsAndRollsBack(t *testing.T) {
	m, keychain, _, home := newTestClaudeCodeManager(t)
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = claudeCredentialJSON("secret-a")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	identityB, _, err := readClaudeCodeOAuthIdentityFromBytes(claudeIdentityJSON(testClaudeAccountB, "b@example.com"))
	if err != nil {
		t.Fatal(err)
	}
	fieldsB, err := claudecode.AccountCredentialFields(claudeCredentialJSON("secret-b"))
	if err != nil {
		t.Fatal(err)
	}
	credentialB, _ := json.Marshal(fieldsB)
	if _, err := m.catalog.upsert(context.Background(), identityB, credentialB, m.now()); err != nil {
		t.Fatal(err)
	}
	svc := &Service{claudeCodeAccounts: m}
	sw := domain.ClaudeCodeAccountSwitch{
		ID: "switch-test", SourceAccountID: testClaudeAccountA, TargetAccountID: testClaudeAccountB,
		Policy: domain.ClaudeCodeSwitchPolicyHotReload, ExpectedAccountRevision: 1,
	}
	if err := svc.StageClaudeCodeAccountForSwitch(context.Background(), sw.ID, sw.TargetAccountID); err != nil {
		t.Fatal(err)
	}
	txn, err := svc.BeginClaudeCodeCredentialSwitch(context.Background(), sw)
	if err != nil {
		t.Fatal(err)
	}
	defer txn.ReleaseNativeLocks()
	if err := txn.CheckpointSource(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := txn.ActivateTarget(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := txn.UpdateIdentity(context.Background()); err != nil {
		t.Fatal(err)
	}
	txn.ReleaseNativeLocks()
	if err := txn.VerifyGlobal(context.Background()); err != nil {
		t.Fatal(err)
	}
	canonicalB, _, _ := keychain.Get(context.Background(), claudecode.ClaudeCanonicalCredentialService, "test-user")
	if !containsAny(string(canonicalB), "secret-b", `"shared":"keep"`, "device-secret-b", `"owner":"secret-b"`) || containsAny(string(canonicalB), "secret-a", "device-secret-a", `"owner":"secret-a"`) {
		t.Fatalf("activated credential crossed account fields: %s", canonicalB)
	}
	rollbackObservedNativeLocks := false
	m.run = func(_ context.Context, _ string, args []string, _ map[string]string) ([]byte, error) {
		if reflect.DeepEqual(args, []string{"auth", "status", "--json"}) {
			_, refreshErr := os.Stat(filepath.Join(m.claudeDir, ".oauth_refresh.lock"))
			_, configErr := os.Stat(m.claudeDir + ".lock")
			rollbackObservedNativeLocks = refreshErr == nil && configErr == nil
			return []byte(`{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}`), nil
		}
		return nil, errors.New("unexpected Claude command")
	}
	if err := txn.Rollback(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !rollbackObservedNativeLocks {
		t.Fatal("rollback released Claude native locks before authentication verification")
	}
	canonicalA, _, _ := keychain.Get(context.Background(), claudecode.ClaudeCanonicalCredentialService, "test-user")
	if !reflect.DeepEqual(canonicalA, claudeCredentialJSON("secret-a")) {
		t.Fatalf("rollback credential = %s", canonicalA)
	}
	identityA, _, err := readClaudeCodeOAuthIdentity(filepath.Join(home, ".claude.json"))
	if err != nil || identityA.AccountUUID != testClaudeAccountA {
		t.Fatalf("rollback identity = %+v err=%v", identityA, err)
	}
}

func TestClaudeCodeRecoveryUsesCredentialWhenConfigAlreadyNamesTarget(t *testing.T) {
	m, keychain, _, home := newTestClaudeCodeManager(t)
	originalCredential := claudeCredentialJSON("secret-a")
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = originalCredential
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	identityB, _, err := readClaudeCodeOAuthIdentityFromBytes(claudeIdentityJSON(testClaudeAccountB, "b@example.com"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.catalog.upsert(context.Background(), identityB, claudeCredentialJSON("secret-b"), m.now()); err != nil {
		t.Fatal(err)
	}
	sw := domain.ClaudeCodeAccountSwitch{ID: "recover-config-ahead", SourceAccountID: testClaudeAccountA, TargetAccountID: testClaudeAccountB, ExpectedAccountRevision: 1}
	txn, err := (&Service{claudeCodeAccounts: m}).BeginClaudeCodeCredentialSwitch(context.Background(), sw)
	if err != nil {
		t.Fatal(err)
	}
	if err := txn.CheckpointSource(context.Background()); err != nil {
		t.Fatal(err)
	}
	txn.ReleaseNativeLocks()
	if err := claudecode.WriteOAuthAccount(context.Background(), m.configPath, claudeCodeIdentityMap(identityB)); err != nil {
		t.Fatal(err)
	}

	outcome, _, err := (&Service{claudeCodeAccounts: m}).RecoverClaudeCodeCredentialSwitch(context.Background(), sw)
	if err != nil || outcome != ports.ClaudeCodeCredentialRecoveryFailed {
		t.Fatalf("recovery outcome=%q err=%v", outcome, err)
	}
	canonical, _, _ := keychain.Get(context.Background(), claudecode.ClaudeCanonicalCredentialService, "test-user")
	identity, _, identityErr := readClaudeCodeOAuthIdentity(m.configPath)
	if !reflect.DeepEqual(canonical, originalCredential) || identityErr != nil || identity.AccountUUID != testClaudeAccountA {
		t.Fatalf("recovery followed config instead of credential: canonical=%s identity=%+v err=%v", canonical, identity, identityErr)
	}
}

func TestClaudeCodeRecoveryUsesCredentialWhenConfigStillNamesSource(t *testing.T) {
	m, keychain, state, home := newTestClaudeCodeManager(t)
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = claudeCredentialJSON("secret-a")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	identityB, _, err := readClaudeCodeOAuthIdentityFromBytes(claudeIdentityJSON(testClaudeAccountB, "b@example.com"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.catalog.upsert(context.Background(), identityB, claudeCredentialJSON("secret-b"), m.now()); err != nil {
		t.Fatal(err)
	}
	sw := domain.ClaudeCodeAccountSwitch{ID: "recover-credential-ahead", SourceAccountID: testClaudeAccountA, TargetAccountID: testClaudeAccountB, ExpectedAccountRevision: 1}
	txn, err := (&Service{claudeCodeAccounts: m}).BeginClaudeCodeCredentialSwitch(context.Background(), sw)
	if err != nil {
		t.Fatal(err)
	}
	if err := txn.CheckpointSource(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := txn.ActivateTarget(context.Background()); err != nil {
		t.Fatal(err)
	}
	txn.ReleaseNativeLocks()

	outcome, _, err := (&Service{claudeCodeAccounts: m}).RecoverClaudeCodeCredentialSwitch(context.Background(), sw)
	if err != nil || outcome != ports.ClaudeCodeCredentialRecoveryCompleted {
		t.Fatalf("recovery outcome=%q err=%v", outcome, err)
	}
	identity, _, identityErr := readClaudeCodeOAuthIdentity(m.configPath)
	if identityErr != nil || identity.AccountUUID != testClaudeAccountB || state.active.AccountID != testClaudeAccountB || state.active.Revision != 2 {
		t.Fatalf("recovery did not finish target: identity=%+v pointer=%+v err=%v", identity, state.active, identityErr)
	}
}

func TestClaudeCodeRecoveryReleasesNativeLocksOnFailure(t *testing.T) {
	m, keychain, state, home := newTestClaudeCodeManager(t)
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = claudeCredentialJSON("secret-a")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	identityB, _, err := readClaudeCodeOAuthIdentityFromBytes(claudeIdentityJSON(testClaudeAccountB, "b@example.com"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := m.catalog.upsert(context.Background(), identityB, claudeCredentialJSON("secret-b"), m.now()); err != nil {
		t.Fatal(err)
	}
	sw := domain.ClaudeCodeAccountSwitch{ID: "recover-lock-release", SourceAccountID: testClaudeAccountA, TargetAccountID: testClaudeAccountB, ExpectedAccountRevision: 1}
	txn, err := (&Service{claudeCodeAccounts: m}).BeginClaudeCodeCredentialSwitch(context.Background(), sw)
	if err != nil {
		t.Fatal(err)
	}
	if err := txn.CheckpointSource(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := txn.ActivateTarget(context.Background()); err != nil {
		t.Fatal(err)
	}
	txn.ReleaseNativeLocks()
	state.setErr = errors.New("injected pointer failure")
	if _, _, err := (&Service{claudeCodeAccounts: m}).RecoverClaudeCodeCredentialSwitch(context.Background(), sw); err == nil {
		t.Fatal("recovery unexpectedly succeeded")
	}
	lockCtx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	release, err := claudecode.AcquireCredentialLocks(lockCtx, m.claudeDir)
	if err != nil {
		t.Fatalf("recovery leaked Claude native locks: %v", err)
	}
	release()
}

func TestClaudeCodeCredentialSwitchRoundTripPreservesSharedFieldsWithoutCrossingAccountFields(t *testing.T) {
	m, keychain, state, home := newTestClaudeCodeManager(t)
	keychain.items[claudecode.ClaudeCanonicalCredentialService+"\x00test-user"] = claudeCredentialJSON("secret-a")
	if err := os.WriteFile(filepath.Join(home, ".claude.json"), claudeIdentityJSON(testClaudeAccountA, "a@example.com"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := m.bootstrapInner(); err != nil {
		t.Fatal(err)
	}
	identityB, _, err := readClaudeCodeOAuthIdentityFromBytes(claudeIdentityJSON(testClaudeAccountB, "b@example.com"))
	if err != nil {
		t.Fatal(err)
	}
	fieldsB, err := claudecode.AccountCredentialFields(claudeCredentialJSON("secret-b"))
	if err != nil {
		t.Fatal(err)
	}
	credentialB, _ := json.Marshal(fieldsB)
	if _, err := m.catalog.upsert(context.Background(), identityB, credentialB, m.now()); err != nil {
		t.Fatal(err)
	}
	svc := &Service{claudeCodeAccounts: m}
	switchOnce := func(id, source, target string, revision int64) {
		t.Helper()
		sw := domain.ClaudeCodeAccountSwitch{ID: id, SourceAccountID: source, TargetAccountID: target, Policy: domain.ClaudeCodeSwitchPolicyHotReload, ExpectedAccountRevision: revision}
		if err := svc.StageClaudeCodeAccountForSwitch(context.Background(), sw.ID, target); err != nil {
			t.Fatal(err)
		}
		txn, err := svc.BeginClaudeCodeCredentialSwitch(context.Background(), sw)
		if err != nil {
			t.Fatal(err)
		}
		defer txn.ReleaseNativeLocks()
		if err := txn.CheckpointSource(context.Background()); err != nil {
			t.Fatal(err)
		}
		if err := txn.ActivateTarget(context.Background()); err != nil {
			t.Fatal(err)
		}
		if _, err := txn.UpdateIdentity(context.Background()); err != nil {
			t.Fatal(err)
		}
		txn.ReleaseNativeLocks()
		if err := txn.VerifyGlobal(context.Background()); err != nil {
			t.Fatal(err)
		}
		if _, err := txn.CommitActivePointer(context.Background()); err != nil {
			t.Fatal(err)
		}
		if err := txn.Cleanup(context.Background()); err != nil {
			t.Fatal(err)
		}
	}

	switchOnce("switch-a-b", testClaudeAccountA, testClaudeAccountB, 1)
	switchOnce("switch-b-a", testClaudeAccountB, testClaudeAccountA, 2)
	if state.active.AccountID != testClaudeAccountA || state.active.Revision != 3 {
		t.Fatalf("round-trip active pointer = %+v", state.active)
	}
	canonical, _, err := keychain.Get(context.Background(), claudecode.ClaudeCanonicalCredentialService, "test-user")
	if err != nil {
		t.Fatal(err)
	}
	if !containsAny(string(canonical), "secret-a", "device-secret-a", `"owner":"secret-a"`, `"shared":"keep"`) ||
		containsAny(string(canonical), "secret-b", "device-secret-b", `"owner":"secret-b"`) {
		t.Fatalf("round-trip credential crossed account fields: %s", canonical)
	}
}

func readClaudeCodeOAuthIdentityFromBytes(data []byte) (domain.ClaudeCodeAccountIdentity, map[string]any, error) {
	dir, err := os.MkdirTemp("", "ao-claude-identity-test-")
	if err != nil {
		return domain.ClaudeCodeAccountIdentity{}, nil, err
	}
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, ".claude.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return domain.ClaudeCodeAccountIdentity{}, nil, err
	}
	return readClaudeCodeOAuthIdentity(path)
}

func containsAny(value string, needles ...string) bool {
	for _, needle := range needles {
		if len(needle) > 0 && strings.Contains(value, needle) {
			return true
		}
	}
	return false
}
