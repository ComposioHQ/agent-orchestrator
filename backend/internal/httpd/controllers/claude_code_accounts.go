package controllers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apispec"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/envelope"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
)

// ClaudeCodeAccountService is the HTTP-facing Claude account-management contract.
type ClaudeCodeAccountService interface {
	CachedClaudeCodeAccounts(context.Context) (agentsvc.ClaudeCodeAccounts, error)
	EnsureClaudeCodeAccounts(context.Context) (agentsvc.ClaudeCodeAccounts, error)
	SubscribeClaudeCodeAccounts(context.Context) (<-chan agentsvc.ClaudeCodeAccounts, error)
	OpenClaudeCodeAccountLoginTerminal(context.Context) (agentsvc.ClaudeCodeAccountLoginTerminalStart, error)
	OpenClaudeCodeAccountReauthenticationTerminal(context.Context, string) (agentsvc.ClaudeCodeAccountLoginTerminalStart, error)
	ActivateClaudeCodeAccount(context.Context, string) (agentsvc.ClaudeCodeAccounts, error)
	LogoutClaudeCodeAccount(context.Context, string) (agentsvc.ClaudeCodeAccounts, error)
	DeleteClaudeCodeAccount(context.Context, string) (agentsvc.ClaudeCodeAccounts, error)
	VerifyClaudeCodeAccountLogin(context.Context, string) (domain.ClaudeCodeAccountLoginOperation, error)
	CancelClaudeCodeAccountLogin(context.Context, string) (domain.ClaudeCodeAccountLoginOperation, error)
	StartClaudeCodeAccountSwitch(context.Context, ports.ClaudeCodeAccountSwitchConfig) (domain.ClaudeCodeAccountSwitch, error)
	RecoverClaudeCodeAccountSwitch(context.Context, string) (domain.ClaudeCodeAccountSwitch, error)
}

// ClaudeCodeAccountsController exposes Claude Code account-management routes.
type ClaudeCodeAccountsController struct{ Svc ClaudeCodeAccountService }

const maxClaudeCodeAccountSwitchBodyBytes = 4 << 10

// Register installs Claude Code account-management request routes.
func (c *ClaudeCodeAccountsController) Register(r chi.Router) {
	r.Get("/agents/claude-code/accounts", c.list)
	r.Post("/agents/claude-code/accounts/ensure", c.ensure)
	r.Post("/agents/claude-code/accounts/login-terminal", c.openLoginTerminal)
	r.Post("/agents/claude-code/accounts/{accountId}/login-terminal", c.openReauthenticationTerminal)
	r.Post("/agents/claude-code/accounts/login-operations/{operationId}/verify", c.verifyLogin)
	r.Post("/agents/claude-code/accounts/login-operations/{operationId}/cancel", c.cancelLogin)
	r.Post("/agents/claude-code/accounts/{accountId}/activate", c.activateAccount)
	r.Post("/agents/claude-code/accounts/{accountId}/logout", c.logoutAccount)
	r.Delete("/agents/claude-code/accounts/{accountId}", c.deleteAccount)
	r.Post("/agents/claude-code/account-switches", c.startSwitch)
	r.Post("/agents/claude-code/account-switches/{switchId}/recover", c.recoverSwitch)
}

// RegisterStreams installs Claude Code account-management event streams.
func (c *ClaudeCodeAccountsController) RegisterStreams(r chi.Router) {
	r.Get("/agents/claude-code/accounts/events", c.events)
}

func requireEmptyRequestBody(w http.ResponseWriter, r *http.Request) bool {
	body, err := io.ReadAll(io.LimitReader(r.Body, 1))
	if err != nil || len(body) != 0 {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_REQUEST_BODY", "Request body must be empty", nil)
		return false
	}
	return true
}

func (c *ClaudeCodeAccountsController) list(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/agents/claude-code/accounts")
		return
	}
	result, err := c.Svc.CachedClaudeCodeAccounts(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, newClaudeCodeAccountsResponse(result))
}

func (c *ClaudeCodeAccountsController) ensure(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/agents/claude-code/accounts/ensure")
		return
	}
	if !requireEmptyRequestBody(w, r) {
		return
	}
	result, err := c.Svc.EnsureClaudeCodeAccounts(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, newClaudeCodeAccountsResponse(result))
}

func (c *ClaudeCodeAccountsController) openLoginTerminal(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/agents/claude-code/accounts/login-terminal")
		return
	}
	if !requireEmptyRequestBody(w, r) {
		return
	}
	result, err := c.Svc.OpenClaudeCodeAccountLoginTerminal(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	writeClaudeCodeLoginTerminal(w, result)
}

func (c *ClaudeCodeAccountsController) openReauthenticationTerminal(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/agents/claude-code/accounts/{accountId}/login-terminal")
		return
	}
	if !requireEmptyRequestBody(w, r) {
		return
	}
	result, err := c.Svc.OpenClaudeCodeAccountReauthenticationTerminal(r.Context(), strings.TrimSpace(chi.URLParam(r, "accountId")))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	writeClaudeCodeLoginTerminal(w, result)
}

func writeClaudeCodeLoginTerminal(w http.ResponseWriter, result agentsvc.ClaudeCodeAccountLoginTerminalStart) {
	envelope.WriteJSON(w, http.StatusAccepted, OpenClaudeCodeAccountLoginTerminalResponse{
		Operation: newClaudeCodeLoginResponse(result.Operation),
		ShellTerminal: ClaudeCodeAccountLoginTerminalResponse{
			HandleID: result.ShellTerminal.HandleID, Title: result.ShellTerminal.Title, CreatedAt: result.ShellTerminal.CreatedAt,
		},
	})
}

func (c *ClaudeCodeAccountsController) verifyLogin(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/agents/claude-code/accounts/login-operations/{operationId}/verify")
		return
	}
	if !requireEmptyRequestBody(w, r) {
		return
	}
	result, err := c.Svc.VerifyClaudeCodeAccountLogin(r.Context(), strings.TrimSpace(chi.URLParam(r, "operationId")))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, newClaudeCodeLoginResponse(result))
}

func (c *ClaudeCodeAccountsController) cancelLogin(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/agents/claude-code/accounts/login-operations/{operationId}/cancel")
		return
	}
	if !requireEmptyRequestBody(w, r) {
		return
	}
	result, err := c.Svc.CancelClaudeCodeAccountLogin(r.Context(), strings.TrimSpace(chi.URLParam(r, "operationId")))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, newClaudeCodeLoginResponse(result))
}

func (c *ClaudeCodeAccountsController) activateAccount(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/agents/claude-code/accounts/{accountId}/activate")
		return
	}
	if !requireEmptyRequestBody(w, r) {
		return
	}
	result, err := c.Svc.ActivateClaudeCodeAccount(r.Context(), strings.TrimSpace(chi.URLParam(r, "accountId")))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, newClaudeCodeAccountsResponse(result))
}

func (c *ClaudeCodeAccountsController) logoutAccount(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/agents/claude-code/accounts/{accountId}/logout")
		return
	}
	if !requireEmptyRequestBody(w, r) {
		return
	}
	result, err := c.Svc.LogoutClaudeCodeAccount(r.Context(), strings.TrimSpace(chi.URLParam(r, "accountId")))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, newClaudeCodeAccountsResponse(result))
}

func (c *ClaudeCodeAccountsController) deleteAccount(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "DELETE", "/api/v1/agents/claude-code/accounts/{accountId}")
		return
	}
	if !requireEmptyRequestBody(w, r) {
		return
	}
	result, err := c.Svc.DeleteClaudeCodeAccount(r.Context(), strings.TrimSpace(chi.URLParam(r, "accountId")))
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, newClaudeCodeAccountsResponse(result))
}

func (c *ClaudeCodeAccountsController) startSwitch(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/agents/claude-code/account-switches")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxClaudeCodeAccountSwitchBodyBytes)
	var request StartClaudeCodeAccountSwitchRequest
	if err := decodeJSONStrict(r, &request); err != nil {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_JSON", "Invalid JSON body", nil)
		return
	}
	idempotencyKey := strings.TrimSpace(request.IdempotencyKey)
	if strings.TrimSpace(request.TargetAccountID) == "" || request.ExpectedAccountRevision < 1 || idempotencyKey == "" || utf8.RuneCountInString(idempotencyKey) > 200 {
		envelope.WriteAPIError(w, r, http.StatusBadRequest, "bad_request", "INVALID_ACCOUNT_SWITCH", "Target account, expected revision, and idempotency key are required", nil)
		return
	}
	result, err := c.Svc.StartClaudeCodeAccountSwitch(r.Context(), ports.ClaudeCodeAccountSwitchConfig{
		TargetAccountID: strings.TrimSpace(request.TargetAccountID), ExpectedAccountRevision: request.ExpectedAccountRevision,
		IdempotencyKey: idempotencyKey,
	})
	if err != nil {
		writeClaudeCodeAccountError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusAccepted, newClaudeCodeSwitchResponse(result))
}

func (c *ClaudeCodeAccountsController) recoverSwitch(w http.ResponseWriter, r *http.Request) {
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "POST", "/api/v1/agents/claude-code/account-switches/{switchId}/recover")
		return
	}
	if !requireEmptyRequestBody(w, r) {
		return
	}
	result, err := c.Svc.RecoverClaudeCodeAccountSwitch(r.Context(), strings.TrimSpace(chi.URLParam(r, "switchId")))
	if err != nil {
		writeClaudeCodeAccountError(w, r, err)
		return
	}
	envelope.WriteJSON(w, http.StatusOK, newClaudeCodeSwitchResponse(result))
}

func writeClaudeCodeAccountError(w http.ResponseWriter, r *http.Request, err error) {
	switch {
	case errors.Is(err, ports.ErrClaudeCodeAccountNotFound), errors.Is(err, ports.ErrClaudeCodeAccountSwitchNotFound):
		envelope.WriteAPIError(w, r, http.StatusNotFound, "not_found", "CLAUDE_CODE_ACCOUNT_NOT_FOUND", "Claude Code account or switch not found", nil)
	case errors.Is(err, ports.ErrClaudeCodeAccountAlreadyActive):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "CLAUDE_CODE_ACCOUNT_ALREADY_ACTIVE", "This Claude Code account is already active", nil)
	case errors.Is(err, ports.ErrClaudeCodeAccountDeleteRequiresLogout):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "CLAUDE_CODE_ACCOUNT_DELETE_REQUIRES_LOGOUT", "Log out of this Claude Code account before deleting it", nil)
	case errors.Is(err, ports.ErrClaudeCodeAccountRevisionConflict):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "CLAUDE_CODE_ACCOUNT_REVISION_CONFLICT", "The active Claude Code account changed", nil)
	case errors.Is(err, ports.ErrClaudeCodeAccountSwitchInProgress):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "CLAUDE_CODE_ACCOUNT_SWITCH_IN_PROGRESS", "A Claude Code account switch is already in progress", nil)
	case errors.Is(err, ports.ErrClaudeCodeAccountLoginInProgress):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "CLAUDE_CODE_ACCOUNT_LOGIN_IN_PROGRESS", "A Claude Code account login is already in progress", nil)
	case errors.Is(err, ports.ErrClaudeCodeActiveAccountUnavailable):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "CLAUDE_CODE_ACTIVE_ACCOUNT_UNAVAILABLE", "No active Claude Code account is available to switch", nil)
	case errors.Is(err, ports.ErrClaudeCodeAccountSwitchIdempotencyConflict):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "CLAUDE_CODE_ACCOUNT_SWITCH_IDEMPOTENCY_CONFLICT", "The idempotency key belongs to another Claude Code account switch", nil)
	case errors.Is(err, ports.ErrClaudeCodeAccountManagementUnsupported):
		envelope.WriteAPIError(w, r, http.StatusNotImplemented, "not_implemented", "CLAUDE_CODE_ACCOUNT_MANAGEMENT_UNSUPPORTED", "Claude Code account management is unsupported", nil)
	case errors.Is(err, ports.ErrClaudeCodeKeychainUnavailable):
		envelope.WriteAPIError(w, r, http.StatusServiceUnavailable, "unavailable", "CLAUDE_CODE_KEYCHAIN_UNAVAILABLE", "The macOS Keychain is unavailable", nil)
	case errors.Is(err, ports.ErrClaudeCodeGlobalAccountChanged):
		envelope.WriteAPIError(w, r, http.StatusConflict, "conflict", "CLAUDE_CODE_GLOBAL_ACCOUNT_CHANGED", "The device Claude Code account changed during switching", nil)
	default:
		envelope.WriteError(w, r, err)
	}
}

func (c *ClaudeCodeAccountsController) events(w http.ResponseWriter, r *http.Request) { //nolint:dupl // Provider-specific event names and DTOs are intentionally explicit.
	if c.Svc == nil {
		apispec.NotImplemented(w, r, "GET", "/api/v1/agents/claude-code/accounts/events")
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		envelope.WriteAPIError(w, r, http.StatusInternalServerError, "internal", "SSE_UNSUPPORTED", "Streaming is not supported by this server", nil)
		return
	}
	events, err := c.Svc.SubscribeClaudeCodeAccounts(r.Context())
	if err != nil {
		envelope.WriteError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	heartbeat := time.NewTicker(25 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-heartbeat.C:
			if _, err := fmt.Fprint(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case event, ok := <-events:
			if !ok {
				return
			}
			data, err := json.Marshal(newClaudeCodeAccountsResponse(event))
			if err != nil {
				return
			}
			if _, err := fmt.Fprintf(w, "event: claude_code_account\ndata: %s\n\n", data); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
