package agent

import (
	"context"
	"errors"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func (s *Service) WarmClaudeCodeAccounts() {
	if s.claudeCodeAccounts != nil {
		go s.claudeCodeAccounts.bootstrap()
	}
}

func (s *Service) WaitClaudeCodeAccountBootstrap(ctx context.Context) error {
	if s.claudeCodeAccounts == nil {
		return apierr.Unavailable("CLAUDE_CODE_ACCOUNT_MANAGEMENT_UNAVAILABLE", "Claude Code account management is unavailable")
	}
	go s.claudeCodeAccounts.bootstrap()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.claudeCodeAccounts.bootstrapDone:
		if s.claudeCodeAccounts.bootstrapErr != nil {
			return apierr.Unavailable("CLAUDE_CODE_ACCOUNT_MANAGEMENT_UNAVAILABLE", "Claude Code account setup did not complete")
		}
		return nil
	}
}

func (s *Service) CachedClaudeCodeAccounts(ctx context.Context) (ClaudeCodeAccounts, error) {
	if err := s.WaitClaudeCodeAccountBootstrap(ctx); err != nil {
		return ClaudeCodeAccounts{}, err
	}
	result := s.claudeCodeAccounts.cached()
	if s.claudeCodeSwitches != nil {
		if sw, ok, err := s.claudeCodeSwitches.GetActiveClaudeCodeAccountSwitch(ctx); err == nil && ok {
			result.CurrentSwitch = &sw
		}
	}
	return result, nil
}

func (s *Service) EnsureClaudeCodeAccounts(ctx context.Context) (ClaudeCodeAccounts, error) {
	if err := s.WaitClaudeCodeAccountBootstrap(ctx); err != nil {
		return ClaudeCodeAccounts{}, err
	}
	if err := s.claudeCodeAccounts.reconcileGlobal(ctx); err != nil {
		return ClaudeCodeAccounts{}, mapClaudeCodeAccountError(err)
	}
	s.claudeCodeAccounts.publish()
	return s.CachedClaudeCodeAccounts(ctx)
}

func (s *Service) SubscribeClaudeCodeAccounts(ctx context.Context) (<-chan ClaudeCodeAccounts, error) {
	if err := s.WaitClaudeCodeAccountBootstrap(ctx); err != nil {
		return nil, err
	}
	source := s.claudeCodeAccounts.subscribe(ctx)
	out := make(chan ClaudeCodeAccounts, 1)
	go func() {
		defer close(out)
		for item := range source {
			if s.claudeCodeSwitches != nil {
				if sw, ok, err := s.claudeCodeSwitches.GetActiveClaudeCodeAccountSwitch(ctx); err == nil && ok {
					item.CurrentSwitch = &sw
				}
			}
			select {
			case out <- item:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out, nil
}

func (s *Service) SetClaudeCodeAccountSwitchCoordinator(coordinator ClaudeCodeAccountSwitchCoordinator) {
	s.claudeCodeSwitches = coordinator
}

func (s *Service) StartClaudeCodeAccountSwitch(ctx context.Context, cfg ports.ClaudeCodeAccountSwitchConfig) (domain.ClaudeCodeAccountSwitch, error) {
	if s.claudeCodeSwitches == nil {
		return domain.ClaudeCodeAccountSwitch{}, apierr.Unavailable("CLAUDE_CODE_ACCOUNT_MANAGEMENT_UNAVAILABLE", "Claude Code account switching is unavailable")
	}
	sw, err := s.claudeCodeSwitches.StartClaudeCodeAccountSwitch(ctx, cfg)
	return sw, mapClaudeCodeAccountError(err)
}

func (s *Service) RecoverClaudeCodeAccountSwitch(ctx context.Context, id string) (domain.ClaudeCodeAccountSwitch, error) {
	if s.claudeCodeSwitches == nil {
		return domain.ClaudeCodeAccountSwitch{}, apierr.Unavailable("CLAUDE_CODE_ACCOUNT_MANAGEMENT_UNAVAILABLE", "Claude Code account switching is unavailable")
	}
	sw, err := s.claudeCodeSwitches.RecoverClaudeCodeAccountSwitch(ctx, strings.TrimSpace(id))
	return sw, mapClaudeCodeAccountError(err)
}

func (s *Service) SetClaudeCodeAccountLoginTerminalOpener(opener claudeCodeAccountLoginTerminalService) {
	if s.claudeCodeAccounts != nil {
		s.claudeCodeAccounts.terminal = opener
	}
}

func (s *Service) OpenClaudeCodeAccountLoginTerminal(ctx context.Context) (ClaudeCodeAccountLoginTerminalStart, error) {
	if err := s.WaitClaudeCodeAccountBootstrap(ctx); err != nil {
		return ClaudeCodeAccountLoginTerminalStart{}, err
	}
	return s.claudeCodeAccounts.openLoginTerminal(ctx, "")
}

func (s *Service) OpenClaudeCodeAccountReauthenticationTerminal(ctx context.Context, accountID string) (ClaudeCodeAccountLoginTerminalStart, error) {
	if err := s.WaitClaudeCodeAccountBootstrap(ctx); err != nil {
		return ClaudeCodeAccountLoginTerminalStart{}, err
	}
	return s.claudeCodeAccounts.openLoginTerminal(ctx, strings.TrimSpace(accountID))
}

func (s *Service) VerifyClaudeCodeAccountLogin(ctx context.Context, operationID string) (domain.ClaudeCodeAccountLoginOperation, error) {
	if err := s.WaitClaudeCodeAccountBootstrap(ctx); err != nil {
		return domain.ClaudeCodeAccountLoginOperation{}, err
	}
	return s.claudeCodeAccounts.verifyLogin(ctx, strings.TrimSpace(operationID))
}

func (s *Service) CancelClaudeCodeAccountLogin(ctx context.Context, operationID string) (domain.ClaudeCodeAccountLoginOperation, error) {
	if err := s.WaitClaudeCodeAccountBootstrap(ctx); err != nil {
		return domain.ClaudeCodeAccountLoginOperation{}, err
	}
	return s.claudeCodeAccounts.cancelLogin(ctx, strings.TrimSpace(operationID))
}

func (s *Service) LogoutClaudeCodeAccount(ctx context.Context, accountID string) (ClaudeCodeAccounts, error) {
	if err := s.WaitClaudeCodeAccountBootstrap(ctx); err != nil {
		return ClaudeCodeAccounts{}, err
	}
	if err := s.claudeCodeAccounts.logout(ctx, strings.TrimSpace(accountID)); err != nil {
		return ClaudeCodeAccounts{}, mapClaudeCodeAccountError(err)
	}
	return s.claudeCodeAccounts.cached(), nil
}

func (s *Service) DeleteClaudeCodeAccount(ctx context.Context, accountID string) (ClaudeCodeAccounts, error) {
	if err := s.WaitClaudeCodeAccountBootstrap(ctx); err != nil {
		return ClaudeCodeAccounts{}, err
	}
	if err := s.claudeCodeAccounts.deleteAccount(ctx, strings.TrimSpace(accountID)); err != nil {
		return ClaudeCodeAccounts{}, mapClaudeCodeAccountError(err)
	}
	return s.claudeCodeAccounts.cached(), nil
}

func mapClaudeCodeAccountError(err error) error {
	switch {
	case errors.Is(err, ports.ErrClaudeCodeAccountNotFound):
		return apierr.NotFound("CLAUDE_CODE_ACCOUNT_NOT_FOUND", "Claude Code account not found")
	case errors.Is(err, ports.ErrClaudeCodeAccountAlreadyActive):
		return apierr.Conflict("CLAUDE_CODE_ACCOUNT_ALREADY_ACTIVE", "The active Claude Code account cannot be deleted", nil)
	case errors.Is(err, ports.ErrClaudeCodeAccountRevisionConflict):
		return apierr.Conflict("CLAUDE_CODE_ACCOUNT_REVISION_CONFLICT", "Claude Code account state changed; refresh and try again", nil)
	case errors.Is(err, ports.ErrClaudeCodeGlobalAccountChanged):
		return apierr.Conflict("CLAUDE_CODE_GLOBAL_ACCOUNT_CHANGED", "The device Claude Code account changed; refresh and try again", nil)
	case errors.Is(err, ports.ErrClaudeCodeAccountSwitchInProgress):
		return apierr.Conflict("CLAUDE_CODE_ACCOUNT_SWITCH_IN_PROGRESS", "A Claude Code account switch is already in progress", nil)
	case errors.Is(err, ports.ErrClaudeCodeAccountSwitchNotFound):
		return apierr.NotFound("CLAUDE_CODE_ACCOUNT_SWITCH_NOT_FOUND", "Claude Code account switch not found")
	case errors.Is(err, ports.ErrClaudeCodeAccountSwitchIdempotencyConflict):
		return apierr.Conflict("CLAUDE_CODE_ACCOUNT_SWITCH_IDEMPOTENCY_CONFLICT", "The idempotency key was already used for a different Claude Code account switch", nil)
	default:
		return err
	}
}
