package sessionmanager

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const claudeCodeAccountSwitchWorkerTimeout = 2 * time.Minute

func claudeCodeAccountSwitchFingerprint(target string, revision int64) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("v1\x00%s\x00%d", target, revision)))
	return "v1:" + hex.EncodeToString(sum[:])
}

func (m *Manager) claudeCodeAccountSwitchDependencies() (ports.ClaudeCodeAccountCredentialManager, ports.ClaudeCodeAccountSwitchStore, error) {
	credentials, ok := m.agentReadiness.(ports.ClaudeCodeAccountCredentialManager)
	if !ok {
		return nil, nil, errors.New("account credential manager is unavailable for Claude Code")
	}
	store, ok := m.store.(ports.ClaudeCodeAccountSwitchStore)
	if !ok {
		return nil, nil, errors.New("account switch store is unavailable for Claude Code")
	}
	return credentials, store, nil
}

func (m *Manager) acquireClaudeCodeAccountSwitchGate(ctx context.Context) error {
	lease, err := m.claudeCodeOperationGate.AcquireExclusive(ctx)
	if err != nil {
		return err
	}
	m.claudeCodeAccountSwitchMu.Lock()
	defer m.claudeCodeAccountSwitchMu.Unlock()
	if m.claudeCodeAccountSwitchWorkerRunning || m.claudeCodeAccountSwitchLease != nil {
		lease.Release()
		return ports.ErrClaudeCodeAccountSwitchInProgress
	}
	m.claudeCodeAccountSwitchLease = lease
	m.claudeCodeAccountSwitchWorkerRunning = true
	return nil
}

func (m *Manager) finishClaudeCodeAccountSwitchWorker(keepFence bool) {
	m.claudeCodeAccountSwitchMu.Lock()
	m.claudeCodeAccountSwitchWorkerRunning = false
	var lease ports.ClaudeCodeOperationLease
	if !keepFence {
		lease = m.claudeCodeAccountSwitchLease
		m.claudeCodeAccountSwitchLease = nil
	}
	m.claudeCodeAccountSwitchMu.Unlock()
	if lease != nil {
		lease.Release()
	}
	m.publishClaudeCodeAccountSwitchChanged()
}

func (m *Manager) claimClaudeCodeRecoveryWorker(ctx context.Context) bool {
	m.claudeCodeAccountSwitchMu.Lock()
	if m.claudeCodeAccountSwitchWorkerRunning {
		m.claudeCodeAccountSwitchMu.Unlock()
		return false
	}
	if m.claudeCodeAccountSwitchLease != nil {
		m.claudeCodeAccountSwitchWorkerRunning = true
		m.claudeCodeAccountSwitchMu.Unlock()
		return true
	}
	m.claudeCodeAccountSwitchMu.Unlock()
	return m.acquireClaudeCodeAccountSwitchGate(ctx) == nil
}

// ClaudeCodeAccountSwitchInProgress reports whether Claude launches are fenced.
func (m *Manager) ClaudeCodeAccountSwitchInProgress() bool {
	return m.claudeCodeOperationGate != nil && m.claudeCodeOperationGate.ExclusivePendingOrHeld()
}

// StartClaudeCodeAccountSwitch records and asynchronously executes a hot switch.
func (m *Manager) StartClaudeCodeAccountSwitch(ctx context.Context, cfg ports.ClaudeCodeAccountSwitchConfig) (domain.ClaudeCodeAccountSwitch, error) {
	cfg.TargetAccountID = strings.TrimSpace(cfg.TargetAccountID)
	cfg.IdempotencyKey = strings.TrimSpace(cfg.IdempotencyKey)
	if cfg.TargetAccountID == "" || cfg.IdempotencyKey == "" || cfg.ExpectedAccountRevision < 1 {
		return domain.ClaudeCodeAccountSwitch{}, errors.New("target account, expected revision, and idempotency key are required")
	}
	credentials, store, err := m.claudeCodeAccountSwitchDependencies()
	if err != nil {
		return domain.ClaudeCodeAccountSwitch{}, err
	}
	fingerprint := claudeCodeAccountSwitchFingerprint(cfg.TargetAccountID, cfg.ExpectedAccountRevision)
	if existing, ok, readErr := store.GetClaudeCodeAccountSwitchByIdempotency(ctx, cfg.IdempotencyKey); readErr != nil {
		return domain.ClaudeCodeAccountSwitch{}, readErr
	} else if ok {
		if existing.RequestFingerprint != fingerprint {
			return existing, ports.ErrClaudeCodeAccountSwitchIdempotencyConflict
		}
		return existing, nil
	}
	if _, active, readErr := store.GetActiveClaudeCodeAccountSwitch(ctx); readErr != nil {
		return domain.ClaudeCodeAccountSwitch{}, readErr
	} else if active {
		return domain.ClaudeCodeAccountSwitch{}, ports.ErrClaudeCodeAccountSwitchInProgress
	}
	if err := credentials.WaitClaudeCodeAccountBootstrap(ctx); err != nil {
		return domain.ClaudeCodeAccountSwitch{}, err
	}
	if err := m.acquireClaudeCodeAccountSwitchGate(ctx); err != nil {
		return domain.ClaudeCodeAccountSwitch{}, err
	}
	releaseGate := true
	defer func() {
		if releaseGate {
			m.finishClaudeCodeAccountSwitchWorker(false)
		}
	}()
	if err := credentials.BeginClaudeCodeAccountMutation(ctx); err != nil {
		return domain.ClaudeCodeAccountSwitch{}, err
	}
	releaseMutation := true
	defer func() {
		if releaseMutation {
			credentials.EndClaudeCodeAccountMutation()
		}
	}()
	current := credentials.CurrentClaudeCodeActiveAccount()
	if current.AccountID == "" || current.Revision < 1 {
		return domain.ClaudeCodeAccountSwitch{}, ports.ErrClaudeCodeActiveAccountUnavailable
	}
	if current.AccountID == cfg.TargetAccountID {
		return domain.ClaudeCodeAccountSwitch{}, ports.ErrClaudeCodeAccountAlreadyActive
	}
	if current.Revision != cfg.ExpectedAccountRevision {
		return domain.ClaudeCodeAccountSwitch{}, ports.ErrClaudeCodeAccountRevisionConflict
	}
	if credentials.ClaudeCodeAccountLoginInProgress() {
		return domain.ClaudeCodeAccountSwitch{}, ports.ErrClaudeCodeAccountLoginInProgress
	}
	now := m.clock()
	sw := domain.ClaudeCodeAccountSwitch{
		ID: uuid.NewString(), SourceAccountID: current.AccountID, TargetAccountID: cfg.TargetAccountID,
		Policy: domain.ClaudeCodeSwitchPolicyHotReload, Phase: domain.ClaudeCodeAccountSwitchRequested,
		IdempotencyKey: cfg.IdempotencyKey, RequestFingerprint: fingerprint,
		ExpectedAccountRevision: cfg.ExpectedAccountRevision, CreatedAt: now, UpdatedAt: now,
	}
	created, inserted, err := store.CreateClaudeCodeAccountSwitch(ctx, sw)
	if err != nil {
		return domain.ClaudeCodeAccountSwitch{}, err
	}
	if !inserted {
		return created, nil
	}
	releaseGate, releaseMutation = false, false
	m.agentSwitchWorkers.Add(1)
	go func() {
		defer m.agentSwitchWorkers.Done()
		workerCtx, cancel := context.WithTimeout(m.backgroundContext, claudeCodeAccountSwitchWorkerTimeout)
		defer cancel()
		m.runClaudeCodeAccountSwitch(workerCtx, credentials, store, created)
	}()
	return created, nil
}

func (m *Manager) runClaudeCodeAccountSwitch(ctx context.Context, credentials ports.ClaudeCodeAccountCredentialManager, store ports.ClaudeCodeAccountSwitchStore, sw domain.ClaudeCodeAccountSwitch) {
	keepFence := false
	defer func() {
		credentials.EndClaudeCodeAccountMutation()
		m.finishClaudeCodeAccountSwitchWorker(keepFence)
	}()
	fail := func(code string, transaction ports.ClaudeCodeCredentialSwitch) {
		if transaction != nil {
			if sw.Phase != domain.ClaudeCodeAccountSwitchRollbackRequired {
				if err := m.advanceClaudeCodeAccountSwitch(ctx, store, &sw, domain.ClaudeCodeAccountSwitchRollbackRequired, code); err != nil {
					keepFence = true
					return
				}
			}
			if err := transaction.Rollback(ctx); err != nil {
				_ = m.advanceClaudeCodeAccountSwitch(ctx, store, &sw, domain.ClaudeCodeAccountSwitchRecoveryRequired, "rollback_verification_failed")
				keepFence = true
				return
			}
			_ = transaction.Cleanup(context.WithoutCancel(ctx))
		} else {
			_ = credentials.CleanupClaudeCodeSwitchArtifacts(context.WithoutCancel(ctx), sw.ID)
		}
		now := m.clock()
		sw.CompletedAt = &now
		_ = m.advanceClaudeCodeAccountSwitch(ctx, store, &sw, domain.ClaudeCodeAccountSwitchFailed, code)
	}

	if err := m.advanceClaudeCodeAccountSwitch(ctx, store, &sw, domain.ClaudeCodeAccountSwitchVerifyingTarget, ""); err != nil {
		return
	}
	if err := credentials.StageClaudeCodeAccountForSwitch(ctx, sw.ID, sw.TargetAccountID); err != nil {
		fail("target_verification_failed", nil)
		return
	}
	if err := m.advanceClaudeCodeAccountSwitch(ctx, store, &sw, domain.ClaudeCodeAccountSwitchCheckpointingSource, ""); err != nil {
		return
	}
	txn, err := credentials.BeginClaudeCodeCredentialSwitch(ctx, sw)
	if err != nil {
		fail("rollback_snapshot_failed", nil)
		return
	}
	defer txn.ReleaseNativeLocks()
	if err := txn.CheckpointSource(ctx); err != nil {
		fail("source_checkpoint_failed", txn)
		return
	}
	if err := m.advanceClaudeCodeAccountSwitch(ctx, store, &sw, domain.ClaudeCodeAccountSwitchActivatingTarget, ""); err != nil {
		fail("phase_conflict", txn)
		return
	}
	if err := txn.ActivateTarget(ctx); err != nil {
		fail("target_activation_failed", txn)
		return
	}
	if err := m.advanceClaudeCodeAccountSwitch(ctx, store, &sw, domain.ClaudeCodeAccountSwitchUpdatingIdentity, ""); err != nil {
		fail("phase_conflict", txn)
		return
	}
	committedAt, err := txn.UpdateIdentity(ctx)
	if err != nil {
		fail("identity_update_failed", txn)
		return
	}
	sw.CredentialsCommittedAt = &committedAt
	if err := m.advanceClaudeCodeAccountSwitch(ctx, store, &sw, domain.ClaudeCodeAccountSwitchVerifyingGlobal, ""); err != nil {
		fail("phase_conflict", txn)
		return
	}
	txn.ReleaseNativeLocks()
	if err := txn.VerifyGlobal(ctx); err != nil {
		fail("global_verification_failed", txn)
		return
	}
	if _, err := txn.CommitActivePointer(ctx); err != nil {
		fail("active_pointer_commit_failed", txn)
		return
	}
	completedAt := m.clock()
	uncertainUntil := committedAt.Add(30 * time.Second)
	sw.CompletedAt, sw.PropagationUncertainUntil = &completedAt, &uncertainUntil
	if err := m.advanceClaudeCodeAccountSwitch(ctx, store, &sw, domain.ClaudeCodeAccountSwitchCompleted, ""); err != nil {
		keepFence = true
		return
	}
	if err := txn.Cleanup(context.WithoutCancel(ctx)); err != nil {
		m.logger.Warn("Claude Code account switch cleanup failed", "switchID", sw.ID)
	}
}

func (m *Manager) advanceClaudeCodeAccountSwitch(ctx context.Context, store ports.ClaudeCodeAccountSwitchStore, sw *domain.ClaudeCodeAccountSwitch, next domain.ClaudeCodeAccountSwitchPhase, code string) error {
	previous := sw.Phase
	sw.Phase, sw.FailureCode, sw.UpdatedAt = next, code, m.clock()
	ok, err := store.UpdateClaudeCodeAccountSwitch(ctx, *sw, previous)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("account switch changed concurrently for Claude Code")
	}
	m.publishClaudeCodeAccountSwitchChanged()
	return nil
}

// GetActiveClaudeCodeAccountSwitch returns the current nonterminal switch.
func (m *Manager) GetActiveClaudeCodeAccountSwitch(ctx context.Context) (domain.ClaudeCodeAccountSwitch, bool, error) {
	_, store, err := m.claudeCodeAccountSwitchDependencies()
	if err != nil {
		return domain.ClaudeCodeAccountSwitch{}, false, err
	}
	sw, ok, err := store.GetActiveClaudeCodeAccountSwitch(ctx)
	if ok {
		m.claudeCodeAccountSwitchMu.Lock()
		sw.CanRecover = !m.claudeCodeAccountSwitchWorkerRunning
		m.claudeCodeAccountSwitchMu.Unlock()
	}
	return sw, ok, err
}

// RecoverClaudeCodeAccountSwitch retries a durable switch recovery operation.
func (m *Manager) RecoverClaudeCodeAccountSwitch(ctx context.Context, id string) (domain.ClaudeCodeAccountSwitch, error) {
	credentials, store, err := m.claudeCodeAccountSwitchDependencies()
	if err != nil {
		return domain.ClaudeCodeAccountSwitch{}, err
	}
	sw, ok, err := store.GetClaudeCodeAccountSwitch(ctx, strings.TrimSpace(id))
	if err != nil {
		return sw, err
	}
	if !ok {
		return sw, ports.ErrClaudeCodeAccountSwitchNotFound
	}
	if sw.Phase.Terminal() {
		return sw, errors.New("account switch is already terminal for Claude Code")
	}
	if !m.claimClaudeCodeRecoveryWorker(ctx) {
		return sw, ports.ErrClaudeCodeAccountSwitchInProgress
	}
	if err := credentials.BeginClaudeCodeAccountMutation(ctx); err != nil {
		m.finishClaudeCodeAccountSwitchWorker(true)
		return sw, err
	}
	m.agentSwitchWorkers.Add(1)
	go func() {
		defer m.agentSwitchWorkers.Done()
		workerCtx, cancel := context.WithTimeout(m.backgroundContext, claudeCodeAccountSwitchWorkerTimeout)
		defer cancel()
		m.recoverClaudeCodeAccountSwitch(workerCtx, credentials, store, sw)
	}()
	return sw, nil
}

func (m *Manager) recoverClaudeCodeAccountSwitch(ctx context.Context, credentials ports.ClaudeCodeAccountCredentialManager, store ports.ClaudeCodeAccountSwitchStore, sw domain.ClaudeCodeAccountSwitch) {
	keepFence := false
	defer func() {
		credentials.EndClaudeCodeAccountMutation()
		m.finishClaudeCodeAccountSwitchWorker(keepFence)
	}()
	outcome, committedAt, err := credentials.RecoverClaudeCodeCredentialSwitch(ctx, sw)
	if err != nil {
		if sw.Phase != domain.ClaudeCodeAccountSwitchRecoveryRequired {
			_ = m.advanceClaudeCodeAccountSwitch(ctx, store, &sw, domain.ClaudeCodeAccountSwitchRecoveryRequired, "recovery_failed")
		}
		keepFence = true
		return
	}
	now := m.clock()
	sw.CompletedAt = &now
	if outcome == ports.ClaudeCodeCredentialRecoveryCompleted {
		sw.CredentialsCommittedAt = committedAt
		if committedAt != nil {
			until := committedAt.Add(30 * time.Second)
			sw.PropagationUncertainUntil = &until
		}
		_ = m.advanceClaudeCodeAccountSwitch(ctx, store, &sw, domain.ClaudeCodeAccountSwitchCompleted, "")
		return
	}
	_ = m.advanceClaudeCodeAccountSwitch(ctx, store, &sw, domain.ClaudeCodeAccountSwitchFailed, "recovered_source")
}

// ReconcileClaudeCodeAccountSwitches resumes any nonterminal switch after startup.
func (m *Manager) ReconcileClaudeCodeAccountSwitches(ctx context.Context) error {
	credentials, credentialsOK := m.agentReadiness.(ports.ClaudeCodeAccountCredentialManager)
	store, storeOK := m.store.(ports.ClaudeCodeAccountSwitchStore)
	if !credentialsOK || !storeOK {
		return nil
	}
	sw, ok, err := store.GetActiveClaudeCodeAccountSwitch(ctx)
	if err != nil || !ok {
		return err
	}
	if err := credentials.WaitClaudeCodeAccountBootstrap(ctx); err != nil {
		return err
	}
	if err := m.acquireClaudeCodeAccountSwitchGate(ctx); err != nil {
		return err
	}
	if err := credentials.BeginClaudeCodeAccountMutation(ctx); err != nil {
		m.finishClaudeCodeAccountSwitchWorker(false)
		return err
	}
	m.agentSwitchWorkers.Add(1)
	go func() {
		defer m.agentSwitchWorkers.Done()
		workerCtx, cancel := context.WithTimeout(m.backgroundContext, claudeCodeAccountSwitchWorkerTimeout)
		defer cancel()
		m.recoverClaudeCodeAccountSwitch(workerCtx, credentials, store, sw)
	}()
	return nil
}

// SetClaudeCodeAccountSwitchObserver installs a state-change callback.
func (m *Manager) SetClaudeCodeAccountSwitchObserver(observer func()) {
	m.claudeCodeAccountSwitchObserverMu.Lock()
	m.claudeCodeAccountSwitchObserver = observer
	m.claudeCodeAccountSwitchObserverMu.Unlock()
}

func (m *Manager) publishClaudeCodeAccountSwitchChanged() {
	m.claudeCodeAccountSwitchObserverMu.Lock()
	observer := m.claudeCodeAccountSwitchObserver
	m.claudeCodeAccountSwitchObserverMu.Unlock()
	if observer != nil {
		observer()
	}
}
