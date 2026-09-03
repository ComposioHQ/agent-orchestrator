package controllers

import (
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	agentsvc "github.com/aoagents/agent-orchestrator/backend/internal/service/agent"
)

func newClaudeCodeAccountsResponse(input agentsvc.ClaudeCodeAccounts) ClaudeCodeAccountsResponse {
	accounts := make([]ClaudeCodeAccountResponse, len(input.Accounts))
	for i := range input.Accounts {
		accounts[i] = newClaudeCodeAccountResponse(input.Accounts[i])
	}
	response := ClaudeCodeAccountsResponse{
		ActiveAccountID: input.ActiveAccountID, AccountRevision: input.AccountRevision,
		Accounts: accounts, Capabilities: newClaudeCodeCapabilitiesResponse(input.Capabilities),
	}
	if input.UnmanagedGlobalAccount != nil {
		response.UnmanagedGlobalAccount = &ClaudeCodeUnmanagedGlobalAccountResponse{
			Label: input.UnmanagedGlobalAccount.Label, AccountEmail: input.UnmanagedGlobalAccount.AccountEmail,
			ReasonCode: input.UnmanagedGlobalAccount.ReasonCode, Reason: input.UnmanagedGlobalAccount.Reason,
		}
	}
	if input.ActiveLogin != nil {
		response.ActiveLogin = &ClaudeCodeActiveLoginResponse{
			OperationID: input.ActiveLogin.OperationID, AccountID: input.ActiveLogin.AccountID,
			Status: string(input.ActiveLogin.Status), ReasonCode: input.ActiveLogin.ReasonCode,
			Reason: input.ActiveLogin.Reason, ExpiresAt: input.ActiveLogin.ExpiresAt,
			ShellTerminal: ClaudeCodeAccountLoginTerminalResponse{
				HandleID: input.ActiveLogin.ShellTerminal.HandleID, Title: input.ActiveLogin.ShellTerminal.Title,
				CreatedAt: input.ActiveLogin.ShellTerminal.CreatedAt,
			},
		}
	}
	if input.CurrentSwitch != nil {
		sw := newClaudeCodeSwitchResponse(*input.CurrentSwitch)
		response.CurrentSwitch = &sw
	}
	return response
}

func newClaudeCodeAccountResponse(input domain.ClaudeCodeAccountSnapshot) ClaudeCodeAccountResponse {
	identity := input.Identity
	return ClaudeCodeAccountResponse{
		ID: input.ID, Label: input.Label, Status: string(input.Status), ReasonCode: input.ReasonCode,
		Reason: input.Reason, Active: input.Active, AccountEmail: input.AccountEmail,
		CreatedAt: input.CreatedAt, UpdatedAt: input.UpdatedAt,
		Authentication: ClaudeCodeAuthenticationResponse{
			State: string(input.Authentication.State), Freshness: string(input.Authentication.Freshness),
			CheckedAt: input.Authentication.CheckedAt, AttemptedAt: input.Authentication.AttemptedAt,
			ReasonCode: input.Authentication.ReasonCode, Reason: input.Authentication.Reason,
		},
		Identity: ClaudeCodeAccountIdentityResponse{
			AccountUUID: identity.AccountUUID, EmailAddress: identity.EmailAddress, DisplayName: identity.DisplayName,
			OrganizationUUID: identity.OrganizationUUID, OrganizationName: identity.OrganizationName,
			BillingType: identity.BillingType, SeatTier: identity.SeatTier,
			AccountCreatedAt: identity.AccountCreatedAt, SubscriptionCreatedAt: identity.SubscriptionCreatedAt,
		},
		PlanUsage: newClaudeCodePlanUsageResponse(input.PlanUsage),
	}
}

func newClaudeCodePlanUsageResponse(input domain.ClaudeCodePlanUsageSnapshot) ClaudeCodePlanUsageResponse {
	windows := make([]ClaudeCodePlanUsageWindowResponse, len(input.Windows))
	for index, window := range input.Windows {
		windows[index] = ClaudeCodePlanUsageWindowResponse{
			ID: window.ID, DisplayName: window.DisplayName, UsedPercent: window.UsedPercent, ResetsAt: window.ResetsAt,
		}
	}
	response := ClaudeCodePlanUsageResponse{
		State: string(input.State), Freshness: string(input.Freshness), Plan: input.Plan,
		Windows: windows, ObservedAt: input.ObservedAt, CheckedAt: input.CheckedAt, AttemptedAt: input.AttemptedAt,
		ReasonCode: input.ReasonCode, Reason: input.Reason,
	}
	if input.Promotion != nil {
		response.Promotion = &ClaudeCodePlanPromotionResponse{PercentIncrease: input.Promotion.PercentIncrease, EndsOn: input.Promotion.EndsOn}
	}
	return response
}

func newClaudeCodeCapabilitiesResponse(input domain.ClaudeCodeAccountCapabilities) ClaudeCodeAccountCapabilitiesResponse {
	return ClaudeCodeAccountCapabilitiesResponse{
		AccountRead: newClaudeCodeCapabilityResponse(input.AccountRead), NativeLogin: newClaudeCodeCapabilityResponse(input.NativeLogin),
		AccountManagement: newClaudeCodeCapabilityResponse(input.AccountManagement), GlobalSwitch: newClaudeCodeCapabilityResponse(input.GlobalSwitch),
		HotReload: newClaudeCodeCapabilityResponse(input.HotReload), SessionExitResume: newClaudeCodeCapabilityResponse(input.SessionExitResume),
	}
}

func newClaudeCodeCapabilityResponse(input domain.ClaudeCodeCapabilityObservation) ClaudeCodeCapabilityObservationResponse {
	return ClaudeCodeCapabilityObservationResponse{State: string(input.State), ReasonCode: input.ReasonCode, Reason: input.Reason}
}

func newClaudeCodeLoginResponse(input domain.ClaudeCodeAccountLoginOperation) ClaudeCodeAccountLoginResponse {
	response := ClaudeCodeAccountLoginResponse{
		OperationID: input.OperationID, AccountID: input.AccountID, Status: string(input.Status),
		ReasonCode: input.ReasonCode, Reason: input.Reason, ExpiresAt: input.ExpiresAt,
	}
	if input.Account != nil {
		account := newClaudeCodeAccountResponse(*input.Account)
		response.Account = &account
	}
	return response
}

func newClaudeCodeSwitchResponse(input domain.ClaudeCodeAccountSwitch) ClaudeCodeAccountSwitchResponse {
	return ClaudeCodeAccountSwitchResponse{
		ID: input.ID, SourceAccountID: input.SourceAccountID, TargetAccountID: input.TargetAccountID,
		SwitchPolicy: string(input.Policy), Phase: string(input.Phase), FailureCode: input.FailureCode,
		CanRecover: input.CanRecover, CredentialsCommittedAt: input.CredentialsCommittedAt,
		PropagationUncertainUntil: input.PropagationUncertainUntil,
		CreatedAt:                 input.CreatedAt, UpdatedAt: input.UpdatedAt, CompletedAt: input.CompletedAt,
	}
}
