package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/claudecode"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

type claudeCodeRollbackSnapshot struct {
	Credential   json.RawMessage `json:"credential"`
	OAuthAccount map[string]any  `json:"oauthAccount"`
}

type claudeCodeCredentialSwitch struct {
	manager      *claudeCodeAccountManager
	switchRecord domain.ClaudeCodeAccountSwitch
	rollback     claudeCodeRollbackSnapshot
	releaseLocks func()
	mutated      bool
}

func (s *Service) CurrentClaudeCodeActiveAccount() domain.ClaudeCodeActiveAccount {
	if s.claudeCodeAccounts == nil {
		return domain.ClaudeCodeActiveAccount{}
	}
	s.claudeCodeAccounts.mu.Lock()
	defer s.claudeCodeAccounts.mu.Unlock()
	return s.claudeCodeAccounts.active
}

func (s *Service) ClaudeCodeAccountLoginInProgress() bool {
	if s.claudeCodeAccounts == nil {
		return false
	}
	s.claudeCodeAccounts.mu.Lock()
	defer s.claudeCodeAccounts.mu.Unlock()
	return s.claudeCodeAccounts.login != nil && !terminalClaudeCodeLoginStatus(s.claudeCodeAccounts.login.snapshot.Status)
}

func (s *Service) BeginClaudeCodeAccountMutation(ctx context.Context) error {
	if s.claudeCodeAccounts == nil {
		return ports.ErrClaudeCodeAccountManagementUnsupported
	}
	_, err := s.claudeCodeAccounts.acquireMutation(ctx)
	return err
}

func (s *Service) EndClaudeCodeAccountMutation() {
	if s.claudeCodeAccounts == nil {
		return
	}
	select {
	case s.claudeCodeAccounts.mutation <- struct{}{}:
	default:
	}
}

func (s *Service) StageClaudeCodeAccountForSwitch(ctx context.Context, switchID, targetAccountID string) error {
	m := s.claudeCodeAccounts
	if m == nil {
		return ports.ErrClaudeCodeAccountManagementUnsupported
	}
	view := m.cached()
	if view.Capabilities.GlobalSwitch.State != domain.ClaudeCodeCapabilitySupported || view.UnmanagedGlobalAccount != nil {
		return ports.ErrClaudeCodeAccountManagementUnsupported
	}
	record, ok := m.catalog.record(targetAccountID)
	if !ok || record.Snapshot.Status != domain.ClaudeCodeAccountStatusValid {
		return ports.ErrClaudeCodeAccountNotFound
	}
	credential, found, err := m.keychain.Get(ctx, claudecode.ClaudeAccountVaultService, targetAccountID)
	if err != nil || !found {
		return errors.New("Claude Code target credential is unavailable")
	}
	stagingDir := filepath.Join(m.switchStagingRoot, switchID)
	configDir, authDir := filepath.Join(stagingDir, "config"), filepath.Join(stagingDir, "auth")
	for _, path := range []string{stagingDir, configDir, authDir} {
		if !pathWithin(m.switchStagingRoot, path) || ensurePrivateDirectory(path) != nil {
			return errors.New("Claude Code switch staging is unavailable")
		}
	}
	fields, err := claudecode.AccountCredentialFields(credential)
	if err != nil {
		return errors.New("Claude Code target credential is invalid")
	}
	staged, err := claudecode.MergeCredentialFields(fields, []byte(`{}`))
	if err != nil {
		return err
	}
	service := claudecode.IsolatedCredentialService(authDir)
	if err := m.keychain.Set(ctx, service, m.keychainAccount, staged); err != nil {
		return errors.New("Claude Code target credential could not be staged")
	}
	identityMap := claudeCodeIdentityMap(record.Snapshot.Identity)
	if err := writePrivateFileAtomic(filepath.Join(configDir, ".claude.json"), []byte("{}\n")); err != nil {
		return err
	}
	if err := claudecode.WriteOAuthAccount(ctx, filepath.Join(configDir, ".claude.json"), identityMap); err != nil {
		return err
	}
	if err := m.verifyAuth(ctx, isolatedClaudeCodeEnvironment(configDir, authDir)); err != nil {
		return errors.New("Claude Code target account requires reauthentication")
	}
	rotated, found, err := m.keychain.Get(ctx, service, m.keychainAccount)
	if err != nil || !found {
		return errors.New("Claude Code target credential refresh could not be captured")
	}
	accountFields, err := claudecode.AccountCredentialFields(rotated)
	if err != nil {
		return errors.New("Claude Code target credential refresh is invalid")
	}
	accountCredential, err := json.Marshal(accountFields)
	if err != nil {
		return err
	}
	_, _, err = m.catalog.upsert(ctx, record.Snapshot.Identity, accountCredential, m.now())
	return err
}

func (s *Service) BeginClaudeCodeCredentialSwitch(ctx context.Context, sw domain.ClaudeCodeAccountSwitch) (ports.ClaudeCodeCredentialSwitch, error) {
	m := s.claudeCodeAccounts
	if m == nil {
		return nil, ports.ErrClaudeCodeAccountManagementUnsupported
	}
	if err := m.ensureExpectedActive(sw.SourceAccountID); err != nil {
		return nil, err
	}
	releaseLocks, err := claudecode.AcquireCredentialLocks(ctx, m.claudeDir)
	if err != nil {
		return nil, err
	}
	abort := true
	defer func() {
		if abort {
			releaseLocks()
		}
	}()
	credential, found, err := m.keychain.Get(ctx, claudecode.ClaudeCanonicalCredentialService, m.keychainAccount)
	if err != nil || !found {
		return nil, errors.New("canonical Claude Code credential is unavailable")
	}
	identity, rawIdentity, err := readClaudeCodeOAuthIdentity(m.configPath)
	if err != nil || identity.AccountUUID != sw.SourceAccountID {
		return nil, ports.ErrClaudeCodeGlobalAccountChanged
	}
	snapshot := claudeCodeRollbackSnapshot{Credential: append(json.RawMessage(nil), credential...), OAuthAccount: rawIdentity}
	data, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	if err := m.keychain.Set(ctx, claudecode.ClaudeSwitchRollbackVaultService, sw.ID, data); err != nil {
		return nil, errors.New("Claude Code rollback snapshot could not be saved")
	}
	abort = false
	return &claudeCodeCredentialSwitch{manager: m, switchRecord: sw, rollback: snapshot, releaseLocks: releaseLocks}, nil
}

func (t *claudeCodeCredentialSwitch) CheckpointSource(ctx context.Context) error {
	credential, found, err := t.manager.keychain.Get(ctx, claudecode.ClaudeCanonicalCredentialService, t.manager.keychainAccount)
	if err != nil || !found {
		return errors.New("canonical Claude Code credential is unavailable")
	}
	fields, err := claudecode.AccountCredentialFields(credential)
	if err != nil {
		return err
	}
	accountCredential, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	source, ok := t.manager.catalog.record(t.switchRecord.SourceAccountID)
	if !ok {
		return ports.ErrClaudeCodeActiveAccountUnavailable
	}
	_, _, err = t.manager.catalog.upsert(ctx, source.Snapshot.Identity, accountCredential, t.manager.now())
	return err
}

func (t *claudeCodeCredentialSwitch) ActivateTarget(ctx context.Context) error {
	target, found, err := t.manager.keychain.Get(ctx, claudecode.ClaudeAccountVaultService, t.switchRecord.TargetAccountID)
	if err != nil || !found {
		return errors.New("Claude Code target credential is unavailable")
	}
	live, found, err := t.manager.keychain.Get(ctx, claudecode.ClaudeCanonicalCredentialService, t.manager.keychainAccount)
	if err != nil || !found {
		return errors.New("canonical Claude Code credential is unavailable")
	}
	fields, err := claudecode.AccountCredentialFields(target)
	if err != nil {
		return err
	}
	merged, err := claudecode.MergeCredentialFields(fields, live)
	if err != nil {
		return err
	}
	if err := t.manager.keychain.Set(ctx, claudecode.ClaudeCanonicalCredentialService, t.manager.keychainAccount, merged); err != nil {
		return errors.New("Claude Code target credential could not be activated")
	}
	t.mutated = true
	return nil
}

func (t *claudeCodeCredentialSwitch) UpdateIdentity(ctx context.Context) (time.Time, error) {
	record, ok := t.manager.catalog.record(t.switchRecord.TargetAccountID)
	if !ok {
		return time.Time{}, ports.ErrClaudeCodeAccountNotFound
	}
	if err := claudecode.WriteOAuthAccount(ctx, t.manager.configPath, claudeCodeIdentityMap(record.Snapshot.Identity)); err != nil {
		return time.Time{}, err
	}
	return t.manager.now(), nil
}

func (t *claudeCodeCredentialSwitch) ReleaseNativeLocks() {
	if t.releaseLocks != nil {
		t.releaseLocks()
		t.releaseLocks = nil
	}
}

func (t *claudeCodeCredentialSwitch) VerifyGlobal(ctx context.Context) error {
	if err := t.manager.verifyAuth(ctx, nil); err != nil {
		return err
	}
	identity, _, err := readClaudeCodeOAuthIdentity(t.manager.configPath)
	if err != nil || identity.AccountUUID != t.switchRecord.TargetAccountID {
		return errors.New("Claude Code global identity does not match the switch target")
	}
	return nil
}

func (t *claudeCodeCredentialSwitch) CommitActivePointer(ctx context.Context) (domain.ClaudeCodeActiveAccount, error) {
	t.manager.mu.Lock()
	active := t.manager.active
	t.manager.mu.Unlock()
	if active.AccountID != t.switchRecord.SourceAccountID || active.Revision != t.switchRecord.ExpectedAccountRevision {
		return domain.ClaudeCodeActiveAccount{}, ports.ErrClaudeCodeAccountRevisionConflict
	}
	if err := t.manager.setActivePointer(ctx, t.switchRecord.TargetAccountID); err != nil {
		return domain.ClaudeCodeActiveAccount{}, err
	}
	t.manager.mu.Lock()
	defer t.manager.mu.Unlock()
	return t.manager.active, nil
}

func (t *claudeCodeCredentialSwitch) Rollback(ctx context.Context) error {
	if t.releaseLocks == nil {
		release, err := claudecode.AcquireCredentialLocks(ctx, t.manager.claudeDir)
		if err != nil {
			return err
		}
		t.releaseLocks = release
	}
	if err := t.manager.keychain.Set(ctx, claudecode.ClaudeCanonicalCredentialService, t.manager.keychainAccount, t.rollback.Credential); err != nil {
		return errors.New("Claude Code rollback credential could not be restored")
	}
	if err := claudecode.WriteOAuthAccount(ctx, t.manager.configPath, t.rollback.OAuthAccount); err != nil {
		return err
	}
	t.ReleaseNativeLocks()
	if err := t.manager.verifyAuth(ctx, nil); err != nil {
		return errors.New("Claude Code rollback could not be verified")
	}
	identity, _, err := readClaudeCodeOAuthIdentity(t.manager.configPath)
	if err != nil || identity.AccountUUID != t.switchRecord.SourceAccountID {
		return errors.New("Claude Code rollback identity could not be verified")
	}
	t.mutated = false
	return nil
}

func (t *claudeCodeCredentialSwitch) Cleanup(ctx context.Context) error {
	t.ReleaseNativeLocks()
	if err := t.manager.keychain.Delete(ctx, claudecode.ClaudeSwitchRollbackVaultService, t.switchRecord.ID); err != nil {
		return err
	}
	stagingDir := filepath.Join(t.manager.switchStagingRoot, t.switchRecord.ID)
	authDir := filepath.Join(stagingDir, "auth")
	_ = t.manager.keychain.Delete(ctx, claudecode.IsolatedCredentialService(authDir), t.manager.keychainAccount)
	if pathWithin(t.manager.switchStagingRoot, stagingDir) {
		return os.RemoveAll(stagingDir)
	}
	return nil
}

func claudeCodeIdentityMap(identity domain.ClaudeCodeAccountIdentity) map[string]any {
	values := map[string]any{
		"accountUuid": identity.AccountUUID, "emailAddress": identity.EmailAddress, "displayName": identity.DisplayName,
		"organizationUuid": identity.OrganizationUUID, "organizationName": identity.OrganizationName,
		"billingType": identity.BillingType, "seatTier": identity.SeatTier,
	}
	if identity.AccountCreatedAt != nil {
		values["accountCreatedAt"] = *identity.AccountCreatedAt
	}
	if identity.SubscriptionCreatedAt != nil {
		values["subscriptionCreatedAt"] = *identity.SubscriptionCreatedAt
	}
	return values
}

func (s *Service) RecoverClaudeCodeCredentialSwitch(ctx context.Context, sw domain.ClaudeCodeAccountSwitch) (ports.ClaudeCodeCredentialRecoveryOutcome, *time.Time, error) {
	m := s.claudeCodeAccounts
	if m == nil {
		return "", nil, ports.ErrClaudeCodeAccountManagementUnsupported
	}
	identity, _, identityErr := readClaudeCodeOAuthIdentity(m.configPath)
	if identityErr == nil && identity.AccountUUID == sw.TargetAccountID {
		if err := m.verifyAuth(ctx, nil); err != nil {
			return "", nil, err
		}
		m.mu.Lock()
		active := m.active
		m.mu.Unlock()
		if active.AccountID == sw.SourceAccountID && active.Revision == sw.ExpectedAccountRevision {
			if err := m.setActivePointer(ctx, sw.TargetAccountID); err != nil {
				return "", nil, err
			}
		}
		committedAt := m.now()
		_ = m.cleanupClaudeCodeSwitchArtifacts(ctx, sw.ID)
		return ports.ClaudeCodeCredentialRecoveryCompleted, &committedAt, nil
	}
	if identityErr == nil && identity.AccountUUID == sw.SourceAccountID {
		if err := m.verifyAuth(ctx, nil); err != nil {
			return "", nil, err
		}
		_ = m.cleanupClaudeCodeSwitchArtifacts(ctx, sw.ID)
		return ports.ClaudeCodeCredentialRecoveryFailed, nil, nil
	}
	data, found, err := m.keychain.Get(ctx, claudecode.ClaudeSwitchRollbackVaultService, sw.ID)
	if err != nil || !found {
		return "", nil, errors.New("Claude Code rollback snapshot is unavailable")
	}
	var snapshot claudeCodeRollbackSnapshot
	if json.Unmarshal(data, &snapshot) != nil || len(snapshot.Credential) == 0 || len(snapshot.OAuthAccount) == 0 {
		return "", nil, errors.New("Claude Code rollback snapshot is invalid")
	}
	txn := &claudeCodeCredentialSwitch{manager: m, switchRecord: sw, rollback: snapshot}
	if err := txn.Rollback(ctx); err != nil {
		return "", nil, err
	}
	_ = txn.Cleanup(ctx)
	return ports.ClaudeCodeCredentialRecoveryFailed, nil, nil
}

func (m *claudeCodeAccountManager) cleanupClaudeCodeSwitchArtifacts(ctx context.Context, switchID string) error {
	if err := m.keychain.Delete(ctx, claudecode.ClaudeSwitchRollbackVaultService, switchID); err != nil {
		return err
	}
	stagingDir := filepath.Join(m.switchStagingRoot, switchID)
	_ = m.keychain.Delete(ctx, claudecode.IsolatedCredentialService(filepath.Join(stagingDir, "auth")), m.keychainAccount)
	if pathWithin(m.switchStagingRoot, stagingDir) {
		return os.RemoveAll(stagingDir)
	}
	return nil
}

func (s *Service) CleanupClaudeCodeSwitchArtifacts(ctx context.Context, switchID string) error {
	if s.claudeCodeAccounts == nil {
		return ports.ErrClaudeCodeAccountManagementUnsupported
	}
	return s.claudeCodeAccounts.cleanupClaudeCodeSwitchArtifacts(ctx, switchID)
}

func (s *Service) PublishClaudeCodeAccounts() {
	if s.claudeCodeAccounts != nil {
		s.claudeCodeAccounts.publish()
	}
}

var _ ports.ClaudeCodeAccountCredentialManager = (*Service)(nil)
