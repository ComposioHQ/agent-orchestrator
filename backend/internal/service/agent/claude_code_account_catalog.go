package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/agent/claudecode"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

const (
	claudeCodeAccountDescriptorFilename = "account.json"
	claudeCodeAccountDescriptorVersion  = 1
)

type claudeCodeAccountDescriptor struct {
	SchemaVersion int                              `json:"schemaVersion"`
	ID            string                           `json:"id"`
	Label         string                           `json:"label"`
	Identity      domain.ClaudeCodeAccountIdentity `json:"identity"`
	CreatedAt     time.Time                        `json:"createdAt"`
	UpdatedAt     time.Time                        `json:"updatedAt"`
}

type claudeCodeAccountRecord struct {
	Descriptor claudeCodeAccountDescriptor
	Snapshot   domain.ClaudeCodeAccountSnapshot
}

type claudeCodeAccountCatalog struct {
	root            string
	keychain        claudecode.Keychain
	keychainAccount string

	mu      sync.RWMutex
	records map[string]claudeCodeAccountRecord
}

func newClaudeCodeAccountCatalog(root string, keychain claudecode.Keychain, keychainAccount string) *claudeCodeAccountCatalog {
	return &claudeCodeAccountCatalog{
		root: canonicalPath(root), keychain: keychain, keychainAccount: keychainAccount,
		records: map[string]claudeCodeAccountRecord{},
	}
}

func validClaudeCodeAccountID(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.String() == value
}

func claudeCodeAccountLabel(identity domain.ClaudeCodeAccountIdentity) string {
	for _, value := range []string{identity.DisplayName, identity.EmailAddress} {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return "Claude Code account"
}

func (c *claudeCodeAccountCatalog) refresh(ctx context.Context, now time.Time) error {
	if err := ensurePrivateDirectory(c.root); err != nil {
		return fmt.Errorf("prepare Claude Code account catalog: %w", err)
	}
	entries, err := os.ReadDir(c.root)
	if err != nil {
		return fmt.Errorf("read Claude Code account catalog: %w", err)
	}
	next := make(map[string]claudeCodeAccountRecord, len(entries))
	for _, entry := range entries {
		id := entry.Name()
		if !validClaudeCodeAccountID(id) {
			continue
		}
		next[id] = c.readRecord(ctx, id, now)
	}
	c.mu.Lock()
	c.records = next
	c.mu.Unlock()
	return nil
}

func (c *claudeCodeAccountCatalog) readRecord(ctx context.Context, id string, now time.Time) claudeCodeAccountRecord {
	broken := func(reason string) claudeCodeAccountRecord {
		return claudeCodeAccountRecord{Snapshot: domain.ClaudeCodeAccountSnapshot{
			ID: id, Label: "Unavailable Claude Code account", Status: domain.ClaudeCodeAccountStatusBroken,
			ReasonCode: domain.ClaudeCodeAccountReasonBroken, Reason: reason,
			Authentication: failedAuthentication(now, domain.AgentReadinessReasonAuthCheckInconclusive, "Authentication is unavailable."),
		}}
	}
	dir := filepath.Join(c.root, id)
	if !pathWithin(c.root, dir) || validateCodexDirectory(dir, true) != nil {
		return broken("This Claude Code account has an unsafe directory layout.")
	}
	descriptor, err := readClaudeCodeAccountDescriptor(filepath.Join(dir, claudeCodeAccountDescriptorFilename))
	if err != nil || descriptor.SchemaVersion != claudeCodeAccountDescriptorVersion || descriptor.ID != id || descriptor.Identity.AccountUUID != id || descriptor.CreatedAt.IsZero() || descriptor.UpdatedAt.IsZero() {
		return broken("This Claude Code account descriptor is invalid.")
	}
	if !validClaudeCodeAccountIdentity(descriptor.Identity) {
		return broken("This Claude Code account identity is invalid.")
	}
	value, found, err := c.keychain.Get(ctx, claudecode.ClaudeAccountVaultService, id)
	if err != nil {
		return broken("This Claude Code account credential is unavailable.")
	}
	status := domain.ClaudeCodeAccountStatusValid
	reasonCode, reason := domain.ClaudeCodeAccountReasonValid, "This Claude Code account is available."
	auth := accountAuthenticationObservation(now, domain.AgentAuthenticationAuthorized)
	if !found {
		status, reasonCode, reason = domain.ClaudeCodeAccountStatusSignedOut, domain.ClaudeCodeAccountReasonSignedOut, "This Claude Code account is signed out."
		auth = signedOutAuthentication(now, "This Claude Code account is signed out.")
	} else if _, err := claudecode.AccountCredentialFields(value); err != nil {
		return broken("This Claude Code account credential is invalid.")
	}
	email := descriptor.Identity.EmailAddress
	return claudeCodeAccountRecord{Descriptor: descriptor, Snapshot: domain.ClaudeCodeAccountSnapshot{
		ID: id, Label: descriptor.Label, Status: status, ReasonCode: reasonCode, Reason: reason,
		Authentication: auth, Identity: descriptor.Identity, AccountEmail: optionalString(email),
		CreatedAt: descriptor.CreatedAt, UpdatedAt: descriptor.UpdatedAt,
	}}
}

func optionalString(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func readClaudeCodeAccountDescriptor(path string) (claudeCodeAccountDescriptor, error) {
	data, _, err := readCodexFileState(path, false)
	if err != nil {
		return claudeCodeAccountDescriptor{}, err
	}
	var descriptor claudeCodeAccountDescriptor
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&descriptor); err != nil {
		return claudeCodeAccountDescriptor{}, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return claudeCodeAccountDescriptor{}, errors.New("descriptor contains trailing or invalid data")
	}
	return descriptor, nil
}

func (c *claudeCodeAccountCatalog) upsert(ctx context.Context, identity domain.ClaudeCodeAccountIdentity, credential []byte, now time.Time) (claudeCodeAccountRecord, bool, error) {
	if !validClaudeCodeAccountIdentity(identity) {
		return claudeCodeAccountRecord{}, false, errors.New("Claude Code account identity is invalid")
	}
	if _, err := claudecode.AccountCredentialFields(credential); err != nil {
		return claudeCodeAccountRecord{}, false, errors.New("Claude Code account credential is invalid")
	}
	id := identity.AccountUUID
	existing, exists := c.record(id)
	createdAt := now
	if exists && !existing.Descriptor.CreatedAt.IsZero() {
		createdAt = existing.Descriptor.CreatedAt
	}
	dir := filepath.Join(c.root, id)
	if !pathWithin(c.root, dir) {
		return claudeCodeAccountRecord{}, false, errors.New("Claude Code account path is unsafe")
	}
	if err := ensurePrivateDirectory(dir); err != nil {
		return claudeCodeAccountRecord{}, false, err
	}
	descriptor := claudeCodeAccountDescriptor{
		SchemaVersion: claudeCodeAccountDescriptorVersion, ID: id, Label: claudeCodeAccountLabel(identity),
		Identity: identity, CreatedAt: createdAt.UTC(), UpdatedAt: now.UTC(),
	}
	data, err := json.MarshalIndent(descriptor, "", "  ")
	if err != nil {
		return claudeCodeAccountRecord{}, false, err
	}
	data = append(data, '\n')
	if err := c.keychain.Set(ctx, claudecode.ClaudeAccountVaultService, id, credential); err != nil {
		return claudeCodeAccountRecord{}, false, err
	}
	if err := writePrivateFileAtomic(filepath.Join(dir, claudeCodeAccountDescriptorFilename), data); err != nil {
		if !exists {
			_ = c.keychain.Delete(context.WithoutCancel(ctx), claudecode.ClaudeAccountVaultService, id)
		}
		return claudeCodeAccountRecord{}, false, err
	}
	if err := c.refresh(ctx, now); err != nil {
		return claudeCodeAccountRecord{}, false, err
	}
	record, ok := c.record(id)
	if !ok || record.Snapshot.Status != domain.ClaudeCodeAccountStatusValid {
		return claudeCodeAccountRecord{}, false, errors.New("saved Claude Code account failed validation")
	}
	return record, !exists, nil
}

func (c *claudeCodeAccountCatalog) record(id string) (claudeCodeAccountRecord, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	record, ok := c.records[id]
	return record, ok
}

func (c *claudeCodeAccountCatalog) snapshots(activeID string) []domain.ClaudeCodeAccountSnapshot {
	c.mu.RLock()
	records := make([]claudeCodeAccountRecord, 0, len(c.records))
	for _, record := range c.records {
		records = append(records, record)
	}
	c.mu.RUnlock()
	sort.Slice(records, func(i, j int) bool {
		if records[i].Snapshot.ID == activeID {
			return true
		}
		if records[j].Snapshot.ID == activeID {
			return false
		}
		return records[i].Snapshot.CreatedAt.Before(records[j].Snapshot.CreatedAt)
	})
	out := make([]domain.ClaudeCodeAccountSnapshot, 0, len(records))
	for _, record := range records {
		snapshot := record.Snapshot
		snapshot.Active = snapshot.ID == activeID
		out = append(out, snapshot)
	}
	return out
}

func (c *claudeCodeAccountCatalog) markSignedOut(ctx context.Context, id string, now time.Time) error {
	if _, ok := c.record(id); !ok {
		return ports.ErrClaudeCodeAccountNotFound
	}
	if err := c.keychain.Delete(ctx, claudecode.ClaudeAccountVaultService, id); err != nil {
		return err
	}
	return c.refresh(ctx, now)
}

func (c *claudeCodeAccountCatalog) deleteSignedOut(ctx context.Context, id string, now time.Time) error {
	record, ok := c.record(id)
	if !ok {
		return ports.ErrClaudeCodeAccountNotFound
	}
	if record.Snapshot.Status != domain.ClaudeCodeAccountStatusSignedOut {
		return errors.New("only a signed-out Claude Code account can be deleted")
	}
	dir := filepath.Join(c.root, id)
	if validateCodexDirectory(dir, true) != nil {
		return errors.New("Claude Code account directory is unsafe")
	}
	if err := os.Remove(filepath.Join(dir, claudeCodeAccountDescriptorFilename)); err != nil {
		return err
	}
	if err := os.Remove(dir); err != nil {
		return err
	}
	return c.refresh(ctx, now)
}
