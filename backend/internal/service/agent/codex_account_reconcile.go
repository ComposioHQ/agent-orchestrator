package agent

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/httpd/apierr"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func (m *codexAccountManager) bootstrap() {
	m.bootstrapOnce.Do(func() {
		defer close(m.bootstrapDone)
		err := m.bootstrapInner()
		m.mu.Lock()
		m.bootstrapErr = err
		m.bootstrapped = err == nil
		m.mu.Unlock()
		m.publish()
	})
}

func (m *codexAccountManager) bootstrapInner() error {
	if err := cleanupPendingCredentialHomes(m.pendingRoot); err != nil {
		return err
	}
	if err := cleanupPendingCredentialHomes(m.switchStagingRoot); err != nil {
		return err
	}
	if err := m.catalog.refresh(); err != nil {
		return err
	}
	if m.stateStore != nil {
		active, ok, err := m.stateStore.GetCodexActiveAccount(m.ctx)
		if err != nil {
			return err
		}
		if ok {
			m.mu.Lock()
			m.active = active
			m.mu.Unlock()
		}
	}
	return m.reconcileGlobal(m.ctx)
}

func (m *codexAccountManager) reconcileGlobal(ctx context.Context) error {
	m.mu.Lock()
	call := m.reconcile
	if call == nil {
		call = &accountReconcileCall{done: make(chan struct{})}
		m.reconcile = call
		go m.runGlobalReconciliation(call)
	}
	m.mu.Unlock()
	select {
	case <-call.done:
		return call.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *codexAccountManager) runGlobalReconciliation(call *accountReconcileCall) {
	call.err = m.reconcileGlobalInner()
	m.mu.Lock()
	if m.reconcile == call {
		m.reconcile = nil
	}
	close(call.done)
	m.mu.Unlock()
	m.publish()
}

func (m *codexAccountManager) reconcileGlobalInner() error {
	exclusive, err := m.acquireGlobalMutation(m.ctx)
	if err != nil {
		return err
	}
	if exclusive != nil {
		defer exclusive.Release()
	}
	release, err := m.acquireAccountMutation(m.ctx)
	if err != nil {
		return err
	}
	defer release()
	if m.factory == nil || m.globalHome == "" {
		return errors.New("codex global account discovery is unavailable")
	}
	select {
	case m.processes <- struct{}{}:
		defer func() { <-m.processes }()
	case <-m.ctx.Done():
		return m.ctx.Err()
	}
	readCtx, cancel := context.WithTimeout(m.ctx, codexAccountAuthTimeout)
	defer cancel()
	client, err := m.factory.Open(readCtx, ports.CodexAccountContext{Home: m.globalHome, Managed: false})
	if err != nil {
		m.setGlobalAuthenticationFailure(failedAuthentication(m.now(), domain.AgentReadinessReasonAuthCheckFailed, "Authentication check failed."))
		m.setUnmanagedGlobal("Device Codex account", domain.CodexAuthMethodUnknown, nil, "global_account_unverified", "AO could not verify the device's current Codex account.")
		return errors.New("global Codex account read failed")
	}
	observation, readErr := client.Read(readCtx, false)
	_ = client.Close()
	if readErr != nil || observation.Authentication == domain.AgentAuthenticationUnknown {
		m.setGlobalAuthenticationFailure(failedAuthentication(m.now(), domain.AgentReadinessReasonAuthCheckInconclusive, "Authentication check was inconclusive."))
		m.setUnmanagedGlobal("Device Codex account", observation.Method, observation.Email, "global_account_unverified", "AO could not verify the device's current Codex account.")
		return errors.New("global Codex account read was inconclusive")
	}
	if observation.Authentication == domain.AgentAuthenticationUnauthorized {
		m.setGlobalAuthentication(accountAuthenticationObservation(m.now(), observation.Authentication))
		m.mu.Lock()
		m.unmanaged = nil
		m.mu.Unlock()
		return m.setActivePointer(m.ctx, "")
	}
	if observation.Authentication != domain.AgentAuthenticationAuthorized && observation.Authentication != domain.AgentAuthenticationNotApplicable {
		m.setGlobalAuthenticationFailure(failedAuthentication(m.now(), domain.AgentReadinessReasonAuthCheckInconclusive, "Authentication check was inconclusive."))
		m.setUnmanagedGlobal("Device Codex account", observation.Method, observation.Email, "global_account_unverified", "AO could not verify the device's current Codex account.")
		return nil
	}
	m.setGlobalAuthentication(accountAuthenticationObservation(m.now(), observation.Authentication))
	globalCredential, credentialErr := readOpaqueCredential(m.globalCredentialPath())
	if credentialErr != nil || m.validateGlobalCredentialStore() != nil {
		m.setUnmanagedGlobal(accountLabel("device", observation.Method, observation.Email), observation.Method, observation.Email, "global_credential_store_unsupported", "This Codex account is active on the device, but its credential store cannot be switched safely.")
		return nil
	}
	credentialObservation, credentialErr := m.verifyOpaqueGlobalCredential(globalCredential)
	if credentialErr != nil || !codexObservationsMatch(observation, credentialObservation) {
		m.setUnmanagedGlobal(accountLabel("device", observation.Method, observation.Email), observation.Method, observation.Email, "global_credential_store_unsupported", "This Codex account is active on the device, but its credential store cannot be switched safely.")
		return nil
	}
	observation = credentialObservation
	if err := m.catalog.refresh(); err != nil {
		return err
	}
	record, found := m.matchGlobalAccount(observation, globalCredential)
	if !found {
		if !distinguishableCodexIdentity(observation) {
			m.setUnmanagedGlobal(accountLabel("device", observation.Method, observation.Email), observation.Method, observation.Email, "global_account_identity_unverified", "AO cannot safely distinguish this device Codex account from saved accounts.")
			return nil
		}
		pendingID := m.newID()
		pendingDir, home, createErr := createPendingCredentialHome(m.pendingRoot, pendingID)
		if createErr != nil {
			return createErr
		}
		defer func() { _ = os.RemoveAll(pendingDir) }()
		if err := writePrivateFileAtomic(filepath.Join(home, codexCredentialFilename), globalCredential); err != nil {
			return err
		}
		verifyCtx, verifyCancel := context.WithTimeout(m.ctx, codexAccountAuthTimeout)
		verifiedClient, openErr := m.factory.Open(verifyCtx, ports.CodexAccountContext{Home: home, Managed: true})
		if openErr != nil {
			verifyCancel()
			return openErr
		}
		checked, checkErr := verifiedClient.Read(verifyCtx, true)
		_ = verifiedClient.Close()
		verifyCancel()
		if checkErr != nil || (checked.Authentication != domain.AgentAuthenticationAuthorized && checked.Authentication != domain.AgentAuthenticationNotApplicable) {
			m.setUnmanagedGlobal(accountLabel("device", observation.Method, observation.Email), observation.Method, observation.Email, "global_account_unverified", "AO could not verify the device's current Codex account for import.")
			return nil
		}
		record, err = m.catalog.commitPending(pendingDir, checked)
		if err != nil {
			return err
		}
		observation = checked
	}
	if err := writePrivateFileAtomic(filepath.Join(record.Home, codexCredentialFilename), globalCredential); err != nil {
		return err
	}
	if err := m.catalog.updateVerifiedDescriptor(record.Snapshot.ID, observation); err != nil {
		return err
	}
	if err := m.catalog.refresh(); err != nil {
		return err
	}
	if latestGlobal, latestErr := readOpaqueCredential(m.globalCredentialPath()); latestErr != nil || !bytes.Equal(latestGlobal, globalCredential) {
		m.setUnmanagedGlobal(accountLabel("device", observation.Method, observation.Email), observation.Method, observation.Email, "global_account_changed", "The device Codex account changed while AO was reconciling it.")
		return ports.ErrCodexGlobalAccountChanged
	}
	m.catalog.updateSnapshot(record.Snapshot.ID, func(snapshot *domain.CodexAccountSnapshot) {
		snapshot.Authentication = accountAuthenticationObservation(m.now(), observation.Authentication)
	})
	if err := m.setActivePointer(m.ctx, record.Snapshot.ID); err != nil {
		return err
	}
	m.mu.Lock()
	m.unmanaged = nil
	m.mu.Unlock()
	return nil
}

func (m *codexAccountManager) matchGlobalAccount(observation ports.CodexAccountObservation, globalCredential []byte) (codexAccountRecord, bool) {
	records, err := m.catalog.recordsFor(nil)
	if err != nil {
		return codexAccountRecord{}, false
	}
	m.mu.Lock()
	activeID := m.active.AccountID
	m.mu.Unlock()
	if active, ok := m.catalog.record(activeID); ok && (active.Snapshot.Status == domain.CodexAccountStatusValid || active.Snapshot.Status == domain.CodexAccountStatusSignedOut) {
		if sameCodexStructuredIdentity(active.Snapshot, observation) {
			return active, true
		}
	}
	if distinguishableCodexIdentity(observation) {
		var matched *codexAccountRecord
		for i := range records {
			record := records[i]
			if (record.Snapshot.Status == domain.CodexAccountStatusValid || record.Snapshot.Status == domain.CodexAccountStatusSignedOut) && sameCodexStructuredIdentity(record.Snapshot, observation) && (matched == nil || record.VerifiedAt.After(matched.VerifiedAt)) {
				candidate := record
				matched = &candidate
			}
		}
		if matched != nil {
			return *matched, true
		}
		return codexAccountRecord{}, false
	}
	var opaqueMatch *codexAccountRecord
	for i := range records {
		record := records[i]
		if record.Snapshot.Status != domain.CodexAccountStatusValid || !credentialMatchesRecord(record, globalCredential) {
			continue
		}
		if opaqueMatch != nil {
			return codexAccountRecord{}, false
		}
		candidate := record
		opaqueMatch = &candidate
	}
	if opaqueMatch != nil {
		return *opaqueMatch, true
	}
	return codexAccountRecord{}, false
}

func credentialMatchesRecord(record codexAccountRecord, credential []byte) bool {
	stored, err := readOpaqueCredential(filepath.Join(record.Home, codexCredentialFilename))
	return err == nil && bytes.Equal(stored, credential)
}

func (m *codexAccountManager) observationAndCredentialIdentifyRecord(record codexAccountRecord, observation ports.CodexAccountObservation, credential []byte) bool {
	if distinguishableCodexIdentity(observation) {
		return sameCodexStructuredIdentity(record.Snapshot, observation)
	}
	matched, ok := m.matchGlobalAccount(observation, credential)
	return ok && matched.Snapshot.ID == record.Snapshot.ID
}

func distinguishableCodexIdentity(observation ports.CodexAccountObservation) bool {
	return observation.Method != domain.CodexAuthMethodUnknown && observation.Email != nil && safeAccountEmail(*observation.Email)
}

func sameCodexStructuredIdentity(snapshot domain.CodexAccountSnapshot, observation ports.CodexAccountObservation) bool {
	if snapshot.AuthMethod != observation.Method || !distinguishableCodexIdentity(observation) || snapshot.AccountEmail == nil {
		return false
	}
	return strings.EqualFold(strings.TrimSpace(*snapshot.AccountEmail), strings.TrimSpace(*observation.Email))
}

func codexObservationMatchesAccount(snapshot domain.CodexAccountSnapshot, observation ports.CodexAccountObservation) bool {
	if sameCodexStructuredIdentity(snapshot, observation) {
		return true
	}
	return snapshot.AuthMethod == domain.CodexAuthMethodAPIKey && observation.Method == domain.CodexAuthMethodAPIKey
}

func codexObservationsMatch(left, right ports.CodexAccountObservation) bool {
	if left.Method != right.Method {
		return false
	}
	if left.Email != nil && right.Email != nil && safeAccountEmail(*left.Email) && safeAccountEmail(*right.Email) {
		return strings.EqualFold(strings.TrimSpace(*left.Email), strings.TrimSpace(*right.Email))
	}
	return left.Method == domain.CodexAuthMethodAPIKey
}

func (m *codexAccountManager) verifyOpaqueGlobalCredential(credential []byte) (ports.CodexAccountObservation, error) {
	pendingID := m.newID()
	pendingDir, home, err := createPendingCredentialHome(m.pendingRoot, pendingID)
	if err != nil {
		return ports.CodexAccountObservation{}, err
	}
	defer func() { _ = os.RemoveAll(pendingDir) }()
	if err := writePrivateFileAtomic(filepath.Join(home, codexCredentialFilename), credential); err != nil {
		return ports.CodexAccountObservation{}, err
	}
	verifyCtx, cancel := context.WithTimeout(m.ctx, codexAccountAuthTimeout)
	defer cancel()
	client, err := m.factory.Open(verifyCtx, ports.CodexAccountContext{Home: home, Managed: true})
	if err != nil {
		return ports.CodexAccountObservation{}, err
	}
	// Reconciliation only needs to prove that the opaque global credential is
	// usable from a file-backed home. A proactive refresh here can race Codex's
	// live global credential and rotate the copied refresh token, incorrectly
	// classifying the device account as unmanaged. Strict refresh remains part
	// of login and switch admission, where no duplicate live credential is being
	// introduced.
	observation, readErr := client.Read(verifyCtx, false)
	_ = client.Close()
	if readErr != nil {
		return ports.CodexAccountObservation{}, readErr
	}
	if observation.Authentication != domain.AgentAuthenticationAuthorized && observation.Authentication != domain.AgentAuthenticationNotApplicable {
		return ports.CodexAccountObservation{}, errors.New("global Codex credential could not be verified in a file-backed store")
	}
	return observation, nil
}

func (m *codexAccountManager) setUnmanagedGlobal(label string, method domain.CodexAuthMethod, email *string, code, reason string) {
	m.mu.Lock()
	m.unmanaged = &domain.CodexUnmanagedGlobalAccount{Label: label, AuthMethod: method, AccountEmail: email, ReasonCode: code, Reason: reason}
	m.mu.Unlock()
}

func (m *codexAccountManager) setGlobalAuthentication(observation domain.AgentAuthenticationObservation) {
	m.mu.Lock()
	m.globalAuth = observation
	m.mu.Unlock()
}

func (m *codexAccountManager) setGlobalAuthenticationFailure(observation domain.AgentAuthenticationObservation) {
	m.mu.Lock()
	preserveAuthenticationFailure(&m.globalAuth, observation)
	m.mu.Unlock()
}

func (m *codexAccountManager) setActivePointer(ctx context.Context, accountID string) error {
	m.mu.Lock()
	current := m.active
	m.mu.Unlock()
	if current.AccountID == accountID {
		return nil
	}
	now := m.now()
	active, _, err := m.commitActivePointer(ctx, accountID, current, now)
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.active = active
	m.mu.Unlock()
	return nil
}

type activePointerCommitOutcome uint8

const (
	activePointerUnchanged activePointerCommitOutcome = iota
	activePointerCommitted
	activePointerUncertain
)

func (m *codexAccountManager) commitActivePointer(
	ctx context.Context,
	accountID string,
	current domain.CodexActiveAccount,
	at time.Time,
) (domain.CodexActiveAccount, activePointerCommitOutcome, error) {
	if m.stateStore == nil {
		return domain.CodexActiveAccount{
			AccountID: accountID, Revision: current.Revision + 1, ActivatedAt: at, UpdatedAt: at,
		}, activePointerCommitted, nil
	}
	active, err := m.stateStore.SetCodexActiveAccount(ctx, accountID, current.Revision, at)
	if err == nil {
		return active, activePointerCommitted, nil
	}
	settleCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), codexAccountAuthTimeout)
	defer cancel()
	settled, found, readErr := m.stateStore.GetCodexActiveAccount(settleCtx)
	if readErr != nil {
		return domain.CodexActiveAccount{}, activePointerUncertain, errors.Join(err, readErr)
	}
	if found && settled.AccountID == accountID && settled.Revision == current.Revision+1 {
		return settled, activePointerCommitted, nil
	}
	if (found && settled.AccountID == current.AccountID && settled.Revision == current.Revision) ||
		(!found && current.Revision == 0) {
		return domain.CodexActiveAccount{}, activePointerUnchanged, err
	}
	return settled, activePointerUncertain, errors.Join(err, ports.ErrCodexGlobalAccountChanged)
}

func mapUnknownCodexAccount(err error) error {
	var unknown unknownCodexAccountError
	if errors.As(err, &unknown) {
		return apierr.Invalid("INVALID_CODEX_ACCOUNT_ID", "Unknown Codex account", map[string]any{"accountId": unknown.id})
	}
	return err
}
