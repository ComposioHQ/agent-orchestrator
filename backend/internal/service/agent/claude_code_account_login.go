package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/claudecode"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/service/shellterm"
)

func (m *claudeCodeAccountManager) openLoginTerminal(ctx context.Context, targetAccountID string) (ClaudeCodeAccountLoginTerminalStart, error) {
	release, err := m.acquireMutation(ctx)
	if err != nil {
		return ClaudeCodeAccountLoginTerminalStart{}, err
	}
	defer release()
	if m.terminal == nil || m.resolveExecutable == nil {
		return ClaudeCodeAccountLoginTerminalStart{}, apierr.Unavailable("CLAUDE_CODE_ACCOUNT_MANAGEMENT_UNAVAILABLE", "Claude Code login terminal is unavailable")
	}
	if m.cached().Capabilities.NativeLogin.State != domain.ClaudeCodeCapabilitySupported {
		return ClaudeCodeAccountLoginTerminalStart{}, apierr.NotImplemented("CLAUDE_CODE_ACCOUNT_MANAGEMENT_UNSUPPORTED", "Claude Code account management is unsupported")
	}
	targetAccountID = strings.TrimSpace(targetAccountID)
	if targetAccountID != "" {
		if record, ok := m.catalog.record(targetAccountID); !ok || record.Snapshot.Status == domain.ClaudeCodeAccountStatusBroken {
			return ClaudeCodeAccountLoginTerminalStart{}, apierr.NotFound("CLAUDE_CODE_ACCOUNT_NOT_FOUND", "Claude Code account not found")
		}
	}
	m.mu.Lock()
	if m.login != nil && !terminalClaudeCodeLoginStatus(m.login.snapshot.Status) {
		m.mu.Unlock()
		return ClaudeCodeAccountLoginTerminalStart{}, apierr.Conflict("CLAUDE_CODE_ACCOUNT_LOGIN_IN_PROGRESS", "A Claude Code account login is already in progress", nil)
	}
	m.mu.Unlock()

	id := m.newID()
	pendingDir := filepath.Join(m.pendingRoot, id)
	configDir := filepath.Join(pendingDir, "config")
	authDir := filepath.Join(pendingDir, "auth")
	for _, path := range []string{pendingDir, configDir, authDir} {
		if !pathWithin(m.pendingRoot, path) || ensurePrivateDirectory(path) != nil {
			_ = os.RemoveAll(pendingDir)
			return ClaudeCodeAccountLoginTerminalStart{}, apierr.Unavailable("CLAUDE_CODE_ACCOUNT_MANAGEMENT_UNAVAILABLE", "Claude Code login could not be prepared")
		}
	}
	claudeBinary, err := m.resolveExecutable(ctx)
	if err != nil || strings.TrimSpace(claudeBinary) == "" {
		_ = os.RemoveAll(pendingDir)
		return ClaudeCodeAccountLoginTerminalStart{}, apierr.Unavailable("CLAUDE_CODE_ACCOUNT_MANAGEMENT_UNAVAILABLE", "Claude Code login terminal is unavailable")
	}
	executable, err := m.loginExecutable()
	if err != nil || strings.TrimSpace(executable) == "" {
		_ = os.RemoveAll(pendingDir)
		return ClaudeCodeAccountLoginTerminalStart{}, apierr.Unavailable("CLAUDE_CODE_ACCOUNT_MANAGEMENT_UNAVAILABLE", "Claude Code login terminal is unavailable")
	}
	env := isolatedClaudeCodeEnvironment(configDir, authDir)
	title := "Add Claude Code account"
	if targetAccountID != "" {
		title = "Sign in to Claude Code account"
	}
	now := m.now()
	snapshot := domain.ClaudeCodeAccountLoginOperation{
		OperationID: id, AccountID: targetAccountID, Status: domain.ClaudeCodeAccountLoginPending,
		ReasonCode: "login_pending", Reason: "Waiting for Claude Code sign-in.", ExpiresAt: now.Add(claudeCodeAccountLoginLifetime),
	}
	m.mu.Lock()
	m.login = &claudeCodeLoginOperation{snapshot: snapshot, targetAccountID: targetAccountID, pendingDir: pendingDir, configDir: configDir, authDir: authDir}
	m.mu.Unlock()
	terminal, err := m.terminal.OpenCommandTerminal(ctx, shellterm.OpenCommandTerminalInput{
		Argv: []string{executable, "claude-code-login", "--claude-binary", claudeBinary}, Env: env, WorkingDir: configDir, Title: title,
	})
	if err != nil {
		m.clearLogin(id)
		m.cleanupLogin(&claudeCodeLoginOperation{pendingDir: pendingDir, authDir: authDir})
		return ClaudeCodeAccountLoginTerminalStart{}, apierr.Unavailable("CLAUDE_CODE_ACCOUNT_MANAGEMENT_UNAVAILABLE", "Claude Code login terminal could not be opened")
	}
	m.mu.Lock()
	if m.login == nil || m.login.snapshot.OperationID != id {
		m.mu.Unlock()
		_ = m.terminal.CloseShellTerminal(context.WithoutCancel(ctx), terminal.HandleID)
		m.cleanupLogin(&claudeCodeLoginOperation{pendingDir: pendingDir, authDir: authDir})
		return ClaudeCodeAccountLoginTerminalStart{}, apierr.Conflict("CLAUDE_CODE_ACCOUNT_LOGIN_IN_PROGRESS", "Claude Code login changed concurrently", nil)
	}
	m.login.terminalHandle, m.login.terminalTitle, m.login.terminalCreated = terminal.HandleID, terminal.Title, terminal.CreatedAt
	m.mu.Unlock()
	go m.expireLogin(id, snapshot.ExpiresAt)
	m.publish()
	return ClaudeCodeAccountLoginTerminalStart{Operation: snapshot, ShellTerminal: terminal}, nil
}

func isolatedClaudeCodeEnvironment(configDir, authDir string) map[string]string {
	env := map[string]string{
		"CLAUDE_CONFIG_DIR":               configDir,
		"CLAUDE_SECURESTORAGE_CONFIG_DIR": authDir,
	}
	for _, key := range claudeCodeAuthOverrideVariables {
		env[key] = ""
	}
	return env
}

func (m *claudeCodeAccountManager) clearLogin(id string) {
	m.mu.Lock()
	if m.login != nil && m.login.snapshot.OperationID == id {
		m.login = nil
	}
	m.mu.Unlock()
}

func (m *claudeCodeAccountManager) cleanupLogin(op *claudeCodeLoginOperation) {
	if op == nil {
		return
	}
	if op.terminalHandle != "" && m.terminal != nil {
		_ = m.terminal.CloseShellTerminal(context.Background(), op.terminalHandle)
	}
	if op.authDir != "" {
		_ = m.keychain.Delete(context.Background(), claudecode.IsolatedCredentialService(op.authDir), m.keychainAccount)
	}
	if op.pendingDir != "" && pathWithin(m.pendingRoot, op.pendingDir) {
		_ = os.RemoveAll(op.pendingDir)
	}
}

func (m *claudeCodeAccountManager) verifyLogin(ctx context.Context, operationID string) (domain.ClaudeCodeAccountLoginOperation, error) {
	m.mu.Lock()
	op := m.login
	if op == nil || op.snapshot.OperationID != operationID {
		m.mu.Unlock()
		return domain.ClaudeCodeAccountLoginOperation{}, apierr.NotFound("CLAUDE_CODE_ACCOUNT_LOGIN_NOT_FOUND", "Claude Code account login operation not found")
	}
	if terminalClaudeCodeLoginStatus(op.snapshot.Status) {
		result := op.snapshot
		m.mu.Unlock()
		return result, nil
	}
	op.snapshot.Status, op.snapshot.ReasonCode, op.snapshot.Reason = domain.ClaudeCodeAccountLoginVerifying, "login_verifying", "Verifying the Claude Code account."
	configDir, authDir, targetAccountID := op.configDir, op.authDir, op.targetAccountID
	m.mu.Unlock()
	m.publish()

	env := isolatedClaudeCodeEnvironment(configDir, authDir)
	if err := m.verifyAuth(ctx, env); err != nil {
		return m.finishLogin(operationID, domain.ClaudeCodeAccountLoginUnverified, "login_unverified", "Claude Code could not verify this account.", nil), nil
	}
	identity, _, err := readClaudeCodeOAuthIdentity(filepath.Join(configDir, ".claude.json"))
	if err != nil {
		return m.finishLogin(operationID, domain.ClaudeCodeAccountLoginFailed, "identity_invalid", "Claude Code account identity is invalid.", nil), nil
	}
	credential, found, err := m.keychain.Get(ctx, claudecode.IsolatedCredentialService(authDir), m.keychainAccount)
	if err != nil || !found {
		return m.finishLogin(operationID, domain.ClaudeCodeAccountLoginFailed, "credential_unavailable", "The verified Claude Code credential could not be saved.", nil), nil
	}
	fields, err := claudecode.AccountCredentialFields(credential)
	if err != nil {
		return m.finishLogin(operationID, domain.ClaudeCodeAccountLoginFailed, "unsupported_credential", "Only Claude OAuth accounts are supported.", nil), nil
	}
	accountCredential, err := json.Marshal(fields)
	if err != nil {
		return m.finishLogin(operationID, domain.ClaudeCodeAccountLoginFailed, "credential_invalid", "The verified Claude Code credential could not be saved.", nil), nil
	}

	exclusive, err := m.acquireExclusive(ctx)
	if err != nil {
		return domain.ClaudeCodeAccountLoginOperation{}, err
	}
	if exclusive != nil {
		defer exclusive.Release()
	}
	release, err := m.acquireMutation(ctx)
	if err != nil {
		return domain.ClaudeCodeAccountLoginOperation{}, err
	}
	defer release()

	if targetAccountID == "" {
		if _, exists := m.catalog.record(identity.AccountUUID); exists {
			return m.finishLogin(operationID, domain.ClaudeCodeAccountLoginFailed, "account_already_exists", "This Claude Code account already exists; reauthenticate it instead.", nil), nil
		}
	} else {
		target, exists := m.catalog.record(targetAccountID)
		if !exists {
			return domain.ClaudeCodeAccountLoginOperation{}, ports.ErrClaudeCodeAccountNotFound
		}
		if identity.AccountUUID != target.Snapshot.Identity.AccountUUID {
			return m.finishLogin(operationID, domain.ClaudeCodeAccountLoginFailed, "identity_mismatch", "Sign in with the same Claude Code account to replace its credentials.", nil), nil
		}
	}
	record, err := m.catalog.upsert(ctx, identity, accountCredential, m.now())
	if err != nil {
		return m.finishLogin(operationID, domain.ClaudeCodeAccountLoginFailed, "credential_save_failed", "The verified Claude Code credential could not be saved.", nil), nil
	}
	m.resetPlanUsage(identity.AccountUUID)
	m.mu.Lock()
	active := m.active
	m.mu.Unlock()
	if active.AccountID == "" {
		if err := m.activateCredentialWithoutSource(ctx, accountCredential, identity); err != nil {
			return m.finishLogin(operationID, domain.ClaudeCodeAccountLoginFailed, "credential_activation_failed", "The Claude Code credential could not be activated safely.", nil), nil
		}
	} else if targetAccountID != "" && active.AccountID == targetAccountID {
		if err := m.replaceActiveCredentialAndAdvance(ctx, accountCredential, identity); err != nil {
			return m.finishLogin(operationID, domain.ClaudeCodeAccountLoginFailed, "credential_activation_failed", "The active Claude Code credential could not be replaced safely.", nil), nil
		}
	}
	snapshot := record.Snapshot
	snapshot.PlanUsage = initialClaudeCodePlanUsage(snapshot)
	m.mu.Lock()
	snapshot.Active = snapshot.ID == m.active.AccountID
	m.mu.Unlock()
	return m.finishLogin(operationID, domain.ClaudeCodeAccountLoginCompleted, "login_completed", "Claude Code account saved.", &snapshot), nil
}

// activateCredentialWithoutSource installs a saved account when Claude is
// currently signed out. It is deliberately separate from switching because
// there is no source credential to checkpoint or restore.
func (m *claudeCodeAccountManager) activateCredentialWithoutSource(ctx context.Context, accountCredential []byte, identity domain.ClaudeCodeAccountIdentity) error {
	releaseLocks, err := claudecode.AcquireCredentialLocks(ctx, m.claudeDir)
	if err != nil {
		return err
	}
	defer releaseLocks()

	live, found, err := m.keychain.Get(ctx, claudecode.ClaudeCanonicalCredentialService, m.keychainAccount)
	if err != nil {
		return err
	}
	if found {
		hasAccountCredential, err := claudecode.HasAccountCredential(live)
		if err != nil {
			return err
		}
		if hasAccountCredential {
			return ports.ErrClaudeCodeGlobalAccountChanged
		}
	}
	previousIdentity, err := readOptionalClaudeCodeOAuthIdentity(m.configPath)
	if err != nil {
		return err
	}
	fields, err := claudecode.AccountCredentialFields(accountCredential)
	if err != nil {
		return err
	}
	merged, err := claudecode.MergeCredentialFields(fields, live)
	if err != nil {
		return err
	}
	if err := m.keychain.Set(ctx, claudecode.ClaudeCanonicalCredentialService, m.keychainAccount, merged); err != nil {
		return err
	}
	rollback := func() error {
		rollbackCtx := context.WithoutCancel(ctx)
		credentialErr := m.keychain.Delete(rollbackCtx, claudecode.ClaudeCanonicalCredentialService, m.keychainAccount)
		if found {
			credentialErr = m.keychain.Set(rollbackCtx, claudecode.ClaudeCanonicalCredentialService, m.keychainAccount, live)
		}
		return errors.Join(credentialErr, claudecode.WriteOAuthAccount(rollbackCtx, m.configPath, previousIdentity))
	}
	if err := claudecode.WriteOAuthAccount(ctx, m.configPath, claudeCodeIdentityMap(identity)); err != nil {
		return errors.Join(err, rollback())
	}
	if err := m.setActivePointer(ctx, identity.AccountUUID); err != nil {
		return errors.Join(err, rollback())
	}
	m.mu.Lock()
	m.unmanaged = nil
	m.mu.Unlock()
	return nil
}

func (m *claudeCodeAccountManager) replaceActiveCredentialAndAdvance(ctx context.Context, accountCredential []byte, identity domain.ClaudeCodeAccountIdentity) error {
	releaseLocks, err := claudecode.AcquireCredentialLocks(ctx, m.claudeDir)
	if err != nil {
		return err
	}
	defer releaseLocks()
	live, found, err := m.keychain.Get(ctx, claudecode.ClaudeCanonicalCredentialService, m.keychainAccount)
	if err != nil || !found {
		return errors.New("canonical Claude Code credential is unavailable")
	}
	_, previousIdentity, err := readClaudeCodeOAuthIdentity(m.configPath)
	if err != nil {
		return err
	}
	fields, err := claudecode.AccountCredentialFields(accountCredential)
	if err != nil {
		return err
	}
	merged, err := claudecode.MergeCredentialFields(fields, live)
	if err != nil {
		return err
	}
	if err := m.keychain.Set(ctx, claudecode.ClaudeCanonicalCredentialService, m.keychainAccount, merged); err != nil {
		return err
	}
	rollback := func() error {
		rollbackCtx := context.WithoutCancel(ctx)
		return errors.Join(
			m.keychain.Set(rollbackCtx, claudecode.ClaudeCanonicalCredentialService, m.keychainAccount, live),
			claudecode.WriteOAuthAccount(rollbackCtx, m.configPath, previousIdentity),
		)
	}
	if err := claudecode.WriteOAuthAccount(ctx, m.configPath, claudeCodeIdentityMap(identity)); err != nil {
		return errors.Join(err, rollback())
	}
	if err := m.advanceActivePointer(ctx, identity.AccountUUID); err != nil {
		return errors.Join(err, rollback())
	}
	return nil
}

func (m *claudeCodeAccountManager) finishLogin(operationID string, status domain.ClaudeCodeAccountLoginStatus, code, reason string, account *domain.ClaudeCodeAccountSnapshot) domain.ClaudeCodeAccountLoginOperation {
	m.mu.Lock()
	if m.login == nil || m.login.snapshot.OperationID != operationID {
		m.mu.Unlock()
		return domain.ClaudeCodeAccountLoginOperation{}
	}
	m.login.snapshot.Status, m.login.snapshot.ReasonCode, m.login.snapshot.Reason, m.login.snapshot.Account = status, code, reason, account
	result := m.login.snapshot
	op := *m.login
	m.mu.Unlock()
	if terminalClaudeCodeLoginStatus(status) {
		m.cleanupLogin(&op)
	}
	m.publish()
	return result
}

func (m *claudeCodeAccountManager) cancelLogin(ctx context.Context, operationID string) (domain.ClaudeCodeAccountLoginOperation, error) {
	m.mu.Lock()
	op := m.login
	if op == nil || op.snapshot.OperationID != operationID {
		m.mu.Unlock()
		return domain.ClaudeCodeAccountLoginOperation{}, apierr.NotFound("CLAUDE_CODE_ACCOUNT_LOGIN_NOT_FOUND", "Claude Code account login operation not found")
	}
	if terminalClaudeCodeLoginStatus(op.snapshot.Status) {
		result := op.snapshot
		m.mu.Unlock()
		return result, nil
	}
	m.mu.Unlock()
	select {
	case <-ctx.Done():
		return domain.ClaudeCodeAccountLoginOperation{}, ctx.Err()
	default:
	}
	return m.finishLogin(operationID, domain.ClaudeCodeAccountLoginCancelled, "login_cancelled", "Claude Code account login was cancelled.", nil), nil
}

func (m *claudeCodeAccountManager) expireLogin(operationID string, expiresAt time.Time) {
	timer := time.NewTimer(time.Until(expiresAt))
	defer timer.Stop()
	select {
	case <-m.ctx.Done():
		return
	case <-timer.C:
		m.finishLogin(operationID, domain.ClaudeCodeAccountLoginExpired, "login_expired", "Claude Code account login expired.", nil)
	}
}
