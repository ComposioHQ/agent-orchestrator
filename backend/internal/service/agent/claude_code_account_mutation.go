package agent

import (
	"context"
	"errors"
	"strings"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/claudecode"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func (m *claudeCodeAccountManager) activateAccount(ctx context.Context, accountID string) error {
	accountID = strings.TrimSpace(accountID)
	exclusive, err := m.acquireExclusive(ctx)
	if err != nil {
		return err
	}
	if exclusive != nil {
		defer exclusive.Release()
	}
	release, err := m.acquireMutation(ctx)
	if err != nil {
		return err
	}
	defer release()

	m.mu.Lock()
	active := m.active
	caps := m.caps
	m.mu.Unlock()
	if caps.GlobalSwitch.State != domain.ClaudeCodeCapabilitySupported {
		return ports.ErrClaudeCodeAccountManagementUnsupported
	}
	if active.AccountID == accountID {
		return ports.ErrClaudeCodeAccountAlreadyActive
	}
	if active.AccountID != "" {
		return ports.ErrClaudeCodeGlobalAccountChanged
	}
	record, ok := m.catalog.record(accountID)
	if !ok || record.Snapshot.Status != domain.ClaudeCodeAccountStatusValid {
		return ports.ErrClaudeCodeAccountNotFound
	}
	credential, found, err := m.keychain.Get(ctx, claudecode.ClaudeAccountVaultService, accountID)
	if err != nil {
		return err
	}
	if !found {
		return ports.ErrClaudeCodeAccountNotFound
	}
	if err := m.activateCredentialWithoutSource(ctx, credential, record.Snapshot.Identity); err != nil {
		return err
	}
	m.publish()
	return nil
}

func (m *claudeCodeAccountManager) logout(ctx context.Context, accountID string) error {
	accountID = strings.TrimSpace(accountID)
	record, ok := m.catalog.record(accountID)
	if !ok || record.Snapshot.Status == domain.ClaudeCodeAccountStatusBroken {
		return ports.ErrClaudeCodeAccountNotFound
	}
	exclusive, err := m.acquireExclusive(ctx)
	if err != nil {
		return err
	}
	if exclusive != nil {
		defer exclusive.Release()
	}
	release, err := m.acquireMutation(ctx)
	if err != nil {
		return err
	}
	defer release()

	m.mu.Lock()
	active := m.active
	m.mu.Unlock()
	if active.AccountID != accountID {
		if err := m.catalog.markSignedOut(ctx, accountID, m.now()); err != nil {
			return err
		}
		m.resetPlanUsage(accountID)
		m.publish()
		return nil
	}

	releaseLocks, err := claudecode.AcquireCredentialLocks(ctx, m.claudeDir)
	if err != nil {
		return err
	}
	defer releaseLocks()
	canonical, found, err := m.keychain.Get(ctx, claudecode.ClaudeCanonicalCredentialService, m.keychainAccount)
	if err != nil || !found {
		return errors.New("canonical Claude Code credential is unavailable")
	}
	vault, vaultFound, err := m.keychain.Get(ctx, claudecode.ClaudeAccountVaultService, accountID)
	if err != nil || !vaultFound {
		return errors.New("account credential is unavailable for Claude Code")
	}
	_, previousIdentity, err := readClaudeCodeOAuthIdentity(m.configPath)
	if err != nil {
		return err
	}
	shared, err := claudecode.SharedCredentialProjection(canonical)
	if err != nil {
		return err
	}
	rollback := func() {
		_ = m.keychain.Set(context.WithoutCancel(ctx), claudecode.ClaudeCanonicalCredentialService, m.keychainAccount, canonical)
		_ = claudecode.WriteOAuthAccount(context.WithoutCancel(ctx), m.configPath, previousIdentity)
		_ = m.keychain.Set(context.WithoutCancel(ctx), claudecode.ClaudeAccountVaultService, accountID, vault)
		_ = m.catalog.refresh(context.WithoutCancel(ctx), m.now())
	}
	if err := m.keychain.Set(ctx, claudecode.ClaudeCanonicalCredentialService, m.keychainAccount, shared); err != nil {
		return err
	}
	if err := claudecode.WriteOAuthAccount(ctx, m.configPath, nil); err != nil {
		rollback()
		return err
	}
	if err := m.catalog.markSignedOut(ctx, accountID, m.now()); err != nil {
		rollback()
		return err
	}
	m.resetPlanUsage(accountID)
	if err := m.setActivePointer(ctx, ""); err != nil {
		rollback()
		return err
	}
	m.publish()
	return nil
}

func (m *claudeCodeAccountManager) deleteAccount(ctx context.Context, accountID string) error {
	accountID = strings.TrimSpace(accountID)
	release, err := m.acquireMutation(ctx)
	if err != nil {
		return err
	}
	defer release()
	m.mu.Lock()
	activeID := m.active.AccountID
	m.mu.Unlock()
	if activeID == accountID {
		return ports.ErrClaudeCodeAccountAlreadyActive
	}
	record, ok := m.catalog.record(accountID)
	if !ok || record.Snapshot.Status == domain.ClaudeCodeAccountStatusBroken {
		return ports.ErrClaudeCodeAccountNotFound
	}
	if record.Snapshot.Status != domain.ClaudeCodeAccountStatusSignedOut {
		return ports.ErrClaudeCodeAccountDeleteRequiresLogout
	}
	if err := m.catalog.delete(ctx, accountID, m.now()); err != nil {
		return err
	}
	m.mu.Lock()
	delete(m.planUsage, accountID)
	m.mu.Unlock()
	m.publish()
	return nil
}
