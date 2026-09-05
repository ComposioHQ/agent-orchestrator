package controllers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
)

type fakeClaudeCodeAccounts struct {
	result       agentsvc.ClaudeCodeAccounts
	err          error
	events       chan agentsvc.ClaudeCodeAccounts
	activatedID  string
	switchConfig ports.ClaudeCodeAccountSwitchConfig
	switchResult domain.ClaudeCodeAccountSwitch
}

func (f *fakeClaudeCodeAccounts) CachedClaudeCodeAccounts(context.Context) (agentsvc.ClaudeCodeAccounts, error) {
	return f.result, f.err
}
func (f *fakeClaudeCodeAccounts) EnsureClaudeCodeAccounts(context.Context) (agentsvc.ClaudeCodeAccounts, error) {
	return f.result, nil
}
func (f *fakeClaudeCodeAccounts) SubscribeClaudeCodeAccounts(context.Context) (<-chan agentsvc.ClaudeCodeAccounts, error) {
	if f.events != nil {
		return f.events, f.err
	}
	ch := make(chan agentsvc.ClaudeCodeAccounts, 1)
	ch <- f.result
	return ch, f.err
}
func (f *fakeClaudeCodeAccounts) OpenClaudeCodeAccountLoginTerminal(context.Context) (agentsvc.ClaudeCodeAccountLoginTerminalStart, error) {
	return agentsvc.ClaudeCodeAccountLoginTerminalStart{}, nil
}
func (f *fakeClaudeCodeAccounts) OpenClaudeCodeAccountReauthenticationTerminal(context.Context, string) (agentsvc.ClaudeCodeAccountLoginTerminalStart, error) {
	return agentsvc.ClaudeCodeAccountLoginTerminalStart{}, nil
}
func (f *fakeClaudeCodeAccounts) ActivateClaudeCodeAccount(_ context.Context, accountID string) (agentsvc.ClaudeCodeAccounts, error) {
	f.activatedID = accountID
	return f.result, f.err
}
func (f *fakeClaudeCodeAccounts) LogoutClaudeCodeAccount(context.Context, string) (agentsvc.ClaudeCodeAccounts, error) {
	return f.result, nil
}
func (f *fakeClaudeCodeAccounts) DeleteClaudeCodeAccount(context.Context, string) (agentsvc.ClaudeCodeAccounts, error) {
	return f.result, nil
}
func (*fakeClaudeCodeAccounts) VerifyClaudeCodeAccountLogin(context.Context, string) (domain.ClaudeCodeAccountLoginOperation, error) {
	return domain.ClaudeCodeAccountLoginOperation{}, nil
}
func (*fakeClaudeCodeAccounts) CancelClaudeCodeAccountLogin(context.Context, string) (domain.ClaudeCodeAccountLoginOperation, error) {
	return domain.ClaudeCodeAccountLoginOperation{}, nil
}
func (f *fakeClaudeCodeAccounts) StartClaudeCodeAccountSwitch(_ context.Context, cfg ports.ClaudeCodeAccountSwitchConfig) (domain.ClaudeCodeAccountSwitch, error) {
	f.switchConfig = cfg
	return f.switchResult, f.err
}
func (f *fakeClaudeCodeAccounts) RecoverClaudeCodeAccountSwitch(context.Context, string) (domain.ClaudeCodeAccountSwitch, error) {
	return f.switchResult, nil
}

func TestClaudeCodeAccountSwitchRouteIsStrictAndAccepted(t *testing.T) {
	fake := &fakeClaudeCodeAccounts{switchResult: domain.ClaudeCodeAccountSwitch{
		ID: "switch-1", SourceAccountID: "account-a", TargetAccountID: "account-b",
		Policy: domain.ClaudeCodeSwitchPolicyHotReload, Phase: domain.ClaudeCodeAccountSwitchRequested,
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}}
	router := chi.NewRouter()
	router.Route("/api/v1", (&ClaudeCodeAccountsController{Svc: fake}).Register)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/agents/claude-code/account-switches", strings.NewReader(`{"targetAccountId":"account-b","expectedAccountRevision":7,"idempotencyKey":"request-1"}`))
	req.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, req)
	if response.Code != http.StatusAccepted {
		t.Fatalf("start status=%d body=%s", response.Code, response.Body.String())
	}
	if fake.switchConfig.TargetAccountID != "account-b" || fake.switchConfig.ExpectedAccountRevision != 7 || fake.switchConfig.IdempotencyKey != "request-1" {
		t.Fatalf("switch config = %+v", fake.switchConfig)
	}

	req = httptest.NewRequest(http.MethodPost, "/api/v1/agents/claude-code/account-switches", strings.NewReader(`{"targetAccountId":"account-b","expectedAccountRevision":7,"idempotencyKey":"request-1","credential":"secret"}`))
	response = httptest.NewRecorder()
	router.ServeHTTP(response, req)
	if response.Code != http.StatusBadRequest || strings.Contains(response.Body.String(), "secret") {
		t.Fatalf("strict response status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestClaudeCodeActivateAccountRoute(t *testing.T) {
	fake := &fakeClaudeCodeAccounts{result: agentsvc.ClaudeCodeAccounts{
		ActiveAccountID: "account-b", AccountRevision: 1, Accounts: []domain.ClaudeCodeAccountSnapshot{},
	}}
	router := chi.NewRouter()
	router.Route("/api/v1", (&ClaudeCodeAccountsController{Svc: fake}).Register)

	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/agents/claude-code/accounts/account-b/activate", nil))
	if response.Code != http.StatusOK || fake.activatedID != "account-b" || !strings.Contains(response.Body.String(), `"activeAccountId":"account-b"`) {
		t.Fatalf("activate status=%d account=%q body=%s", response.Code, fake.activatedID, response.Body.String())
	}

	response = httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/agents/claude-code/accounts/account-b/activate", strings.NewReader(`{}`)))
	if response.Code != http.StatusBadRequest {
		t.Fatalf("non-empty activate status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestClaudeCodeAccountSwitchRouteBoundsInput(t *testing.T) {
	router := chi.NewRouter()
	router.Route("/api/v1", (&ClaudeCodeAccountsController{Svc: &fakeClaudeCodeAccounts{}}).Register)

	tests := []struct {
		name string
		body string
	}{
		{name: "oversized body", body: `{"targetAccountId":"account-b","expectedAccountRevision":7,"idempotencyKey":"` + strings.Repeat("x", maxClaudeCodeAccountSwitchBodyBytes) + `"}`},
		{name: "oversized idempotency key", body: `{"targetAccountId":"account-b","expectedAccountRevision":7,"idempotencyKey":"` + strings.Repeat("x", 201) + `"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/agents/claude-code/account-switches", strings.NewReader(tt.body)))
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestClaudeCodeAccountSwitchConflictsAreSafe(t *testing.T) {
	tests := []struct {
		name string
		err  error
		code string
	}{
		{name: "login in progress", err: ports.ErrClaudeCodeAccountLoginInProgress, code: "CLAUDE_CODE_ACCOUNT_LOGIN_IN_PROGRESS"},
		{name: "active account unavailable", err: ports.ErrClaudeCodeActiveAccountUnavailable, code: "CLAUDE_CODE_ACTIVE_ACCOUNT_UNAVAILABLE"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fake := &fakeClaudeCodeAccounts{err: tt.err}
			router := chi.NewRouter()
			router.Route("/api/v1", (&ClaudeCodeAccountsController{Svc: fake}).Register)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/agents/claude-code/account-switches", strings.NewReader(`{"targetAccountId":"account-b","expectedAccountRevision":7,"idempotencyKey":"request-1"}`)))
			if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), tt.code) {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
}

func TestClaudeCodeAccountListContainsOnlySafeIdentityProjection(t *testing.T) {
	now := time.Now().UTC()
	email := "person@example.com"
	supported := domain.ClaudeCodeCapabilityObservation{State: domain.ClaudeCodeCapabilitySupported, ReasonCode: "supported", Reason: "Available"}
	fake := &fakeClaudeCodeAccounts{result: agentsvc.ClaudeCodeAccounts{
		ActiveAccountID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", AccountRevision: 3,
		Accounts: []domain.ClaudeCodeAccountSnapshot{{
			ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", Label: email, Status: domain.ClaudeCodeAccountStatusValid,
			Active: true, AccountEmail: &email, Identity: domain.ClaudeCodeAccountIdentity{
				AccountUUID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", EmailAddress: email, DisplayName: "Person",
			}, PlanUsage: domain.ClaudeCodePlanUsageSnapshot{
				State: domain.ClaudeCodePlanUsageAvailable, Freshness: domain.AgentReadinessFresh,
				Promotion:  &domain.ClaudeCodePlanPromotion{PercentIncrease: 50, EndsOn: "2026-09-13"},
				Windows:    []domain.ClaudeCodePlanUsageWindow{{ID: "five_hour", DisplayName: "5-hour limit", UsedPercent: 12}},
				ReasonCode: domain.ClaudeCodePlanUsageReasonAvailable, Reason: "Plan usage is up to date.",
			}, CreatedAt: now, UpdatedAt: now,
		}},
		Capabilities: domain.ClaudeCodeAccountCapabilities{
			AccountRead: supported, NativeLogin: supported, AccountManagement: supported,
			GlobalSwitch: supported, HotReload: supported,
			SessionExitResume: domain.ClaudeCodeCapabilityObservation{State: domain.ClaudeCodeCapabilityUnsupported},
		},
	}}
	router := chi.NewRouter()
	router.Route("/api/v1", (&ClaudeCodeAccountsController{Svc: fake}).Register)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/agents/claude-code/accounts", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	for _, forbidden := range []string{"claudeAiOauth", "refreshToken", "trustedDeviceToken", "Keychain", "credentialPath"} {
		if strings.Contains(response.Body.String(), forbidden) {
			t.Fatalf("response exposed forbidden field %q: %s", forbidden, response.Body.String())
		}
	}
	for _, expected := range []string{`"planUsage"`, `"five_hour"`, `"usedPercent":12`, `"promotion"`, `"percentIncrease":50`, `"endsOn":"2026-09-13"`} {
		if !strings.Contains(response.Body.String(), expected) {
			t.Fatalf("response omitted %q: %s", expected, response.Body.String())
		}
	}
}

func TestClaudeCodeEmptyBodyRoutesRejectPayload(t *testing.T) {
	router := chi.NewRouter()
	router.Route("/api/v1", (&ClaudeCodeAccountsController{Svc: &fakeClaudeCodeAccounts{}}).Register)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/agents/claude-code/accounts/ensure", strings.NewReader(`{"unexpected":true}`)))
	if response.Code != http.StatusBadRequest || strings.Contains(response.Body.String(), "unexpected") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

type cancelOnClaudeEventRecorder struct {
	*httptest.ResponseRecorder
	cancel context.CancelFunc
}

func (w *cancelOnClaudeEventRecorder) Flush() {
	w.ResponseRecorder.Flush()
	if strings.Contains(w.Body.String(), "event: claude_code_account") {
		w.cancel()
	}
}

func TestClaudeCodeAccountEventStreamUsesNamedSafeSnapshot(t *testing.T) {
	events := make(chan agentsvc.ClaudeCodeAccounts, 1)
	events <- agentsvc.ClaudeCodeAccounts{AccountRevision: 9, Accounts: []domain.ClaudeCodeAccountSnapshot{}}
	controller := &ClaudeCodeAccountsController{Svc: &fakeClaudeCodeAccounts{events: events}}
	ctx, cancel := context.WithCancel(context.Background())
	recorder := &cancelOnClaudeEventRecorder{ResponseRecorder: httptest.NewRecorder(), cancel: cancel}
	controller.events(recorder, httptest.NewRequest(http.MethodGet, "/api/v1/agents/claude-code/accounts/events", nil).WithContext(ctx))
	body := recorder.Body.String()
	if !strings.Contains(body, "event: claude_code_account\n") || !strings.Contains(body, `"accountRevision":9`) {
		t.Fatalf("unexpected event stream: %s", body)
	}
}
