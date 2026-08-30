package agent

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
)

const (
	codexExistingProfileID         = "existing"
	codexProfileDescriptorFilename = "profile.json"
	codexProfileHomeDirectory      = "home"
	codexProfileVersion            = 1
	maxCodexProfileLabelRunes      = 80
)

type codexProfileDescriptor struct {
	Version   int                       `json:"version"`
	ID        string                    `json:"id"`
	Label     string                    `json:"label"`
	Source    domain.CodexProfileSource `json:"source"`
	CreatedAt time.Time                 `json:"createdAt"`
}

type codexProfileRecord struct {
	Snapshot  domain.CodexProfileSnapshot
	Home      string
	CreatedAt time.Time
}

type codexProfileCatalog struct {
	root         string
	existingHome string
	logger       *slog.Logger
	now          func() time.Time
	newID        func() string

	mu      sync.RWMutex
	records map[string]codexProfileRecord
}

func newCodexProfileCatalog(root, existingHome string, logger *slog.Logger) *codexProfileCatalog {
	if logger == nil {
		logger = slog.New(slog.DiscardHandler)
	}
	c := &codexProfileCatalog{
		root: root, existingHome: canonicalPath(existingHome), logger: logger,
		now: func() time.Time { return time.Now().UTC() }, newID: uuid.NewString,
		records: make(map[string]codexProfileRecord),
	}
	c.records[codexExistingProfileID] = c.existingRecord()
	return c
}

func (c *codexProfileCatalog) existingRecord() codexProfileRecord {
	return codexProfileRecord{
		Home: c.existingHome,
		Snapshot: domain.CodexProfileSnapshot{
			ID: codexExistingProfileID, Label: "Existing Codex account",
			Source: domain.CodexProfileSourceExisting, Status: domain.CodexProfileStatusValid,
			ReasonCode: domain.CodexProfileReasonValid, Reason: "This Codex account is available.",
			Authentication: uncheckedAuthentication(), AuthMethod: domain.CodexAuthMethodUnknown,
			UsableByCurrentLaunches: true,
		},
	}
}

func uncheckedAuthentication() domain.AgentAuthenticationObservation {
	return domain.AgentAuthenticationObservation{
		State: domain.AgentAuthenticationUnknown, Freshness: domain.AgentReadinessStale,
		ReasonCode: domain.AgentReadinessReasonNotChecked, Reason: "Authentication has not been checked yet.",
	}
}

func (c *codexProfileCatalog) snapshots() []domain.CodexProfileSnapshot {
	c.mu.RLock()
	defer c.mu.RUnlock()
	records := c.sortedRecordsLocked()
	out := make([]domain.CodexProfileSnapshot, 0, len(records))
	for _, record := range records {
		out = append(out, record.Snapshot)
	}
	return out
}

func (c *codexProfileCatalog) recordsFor(ids []string) ([]codexProfileRecord, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if len(ids) == 0 {
		return c.sortedRecordsLocked(), nil
	}
	seen := make(map[string]struct{}, len(ids))
	records := make([]codexProfileRecord, 0, len(ids))
	for _, id := range ids {
		if _, duplicate := seen[id]; duplicate {
			continue
		}
		record, ok := c.records[id]
		if !ok {
			return nil, unknownCodexProfileError{id: id}
		}
		seen[id] = struct{}{}
		records = append(records, record)
	}
	sortCodexProfileRecords(records)
	return records, nil
}

func (c *codexProfileCatalog) record(id string) (codexProfileRecord, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	record, ok := c.records[id]
	return record, ok
}

func (c *codexProfileCatalog) updateSnapshot(id string, update func(*domain.CodexProfileSnapshot)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	record, ok := c.records[id]
	if !ok {
		return
	}
	update(&record.Snapshot)
	c.records[id] = record
}

func (c *codexProfileCatalog) sortedRecordsLocked() []codexProfileRecord {
	records := make([]codexProfileRecord, 0, len(c.records))
	for _, record := range c.records {
		records = append(records, record)
	}
	sortCodexProfileRecords(records)
	return records
}

func sortCodexProfileRecords(records []codexProfileRecord) {
	sort.SliceStable(records, func(i, j int) bool {
		if records[i].Snapshot.ID == codexExistingProfileID {
			return true
		}
		if records[j].Snapshot.ID == codexExistingProfileID {
			return false
		}
		if !records[i].CreatedAt.Equal(records[j].CreatedAt) {
			return records[i].CreatedAt.Before(records[j].CreatedAt)
		}
		return records[i].Snapshot.ID < records[j].Snapshot.ID
	})
}

func (c *codexProfileCatalog) refresh() error {
	if c.root == "" {
		return errors.New("codex profile storage is unavailable")
	}
	entries, err := os.ReadDir(c.root)
	if errors.Is(err, os.ErrNotExist) {
		c.replaceRecords(map[string]codexProfileRecord{codexExistingProfileID: c.preservedExisting()})
		return nil
	}
	if err != nil {
		return fmt.Errorf("read Codex profile catalog: %w", err)
	}

	next := map[string]codexProfileRecord{codexExistingProfileID: c.preservedExisting()}
	existingCanonical := canonicalPath(c.existingHome)
	for _, entry := range entries {
		id := entry.Name()
		if !isCanonicalUUIDv4(id) {
			c.logger.Debug("ignored non-profile Codex catalog entry")
			continue
		}
		record := c.readManaged(id)
		if record.Snapshot.Status == domain.CodexProfileStatusValid && existingCanonical != "" && canonicalPath(record.Home) == existingCanonical {
			c.logger.Warn("ignored managed Codex profile that aliases the existing profile", "profile_id", id)
			continue
		}
		c.preserveAuthentication(&record)
		next[id] = record
	}
	c.replaceRecords(next)
	return nil
}

func (c *codexProfileCatalog) preservedExisting() codexProfileRecord {
	record := c.existingRecord()
	c.preserveAuthentication(&record)
	return record
}

func (c *codexProfileCatalog) preserveAuthentication(record *codexProfileRecord) {
	c.mu.RLock()
	previous, ok := c.records[record.Snapshot.ID]
	c.mu.RUnlock()
	if !ok || previous.Snapshot.Status != domain.CodexProfileStatusValid || record.Snapshot.Status != domain.CodexProfileStatusValid {
		return
	}
	record.Snapshot.Authentication = previous.Snapshot.Authentication
	record.Snapshot.AuthMethod = previous.Snapshot.AuthMethod
	record.Snapshot.AccountEmail = previous.Snapshot.AccountEmail
}

func (c *codexProfileCatalog) replaceRecords(records map[string]codexProfileRecord) {
	c.mu.Lock()
	c.records = records
	c.mu.Unlock()
}

func (c *codexProfileCatalog) readManaged(id string) codexProfileRecord {
	profileDir := filepath.Join(c.root, id)
	home := filepath.Join(profileDir, codexProfileHomeDirectory)
	broken := func(code, reason string) codexProfileRecord {
		return codexProfileRecord{
			Home: home,
			Snapshot: domain.CodexProfileSnapshot{
				ID: id, Label: "Unavailable Codex account", Source: domain.CodexProfileSourceManaged,
				Status: domain.CodexProfileStatusBroken, ReasonCode: code, Reason: reason,
				Authentication: uncheckedAuthentication(), AuthMethod: domain.CodexAuthMethodUnknown,
			},
		}
	}
	profileInfo, err := os.Lstat(profileDir)
	if err != nil || !profileInfo.IsDir() || profileInfo.Mode()&os.ModeSymlink != 0 || profileInfo.Mode().Perm() != 0o700 {
		return broken(domain.CodexProfileReasonUnsafePath, "This Codex account has an unsafe directory layout.")
	}
	descriptorPath := filepath.Join(profileDir, codexProfileDescriptorFilename)
	descriptor, err := readCodexProfileDescriptor(descriptorPath)
	label := strings.TrimSpace(descriptor.Label)
	if err != nil || descriptor.ID != id || descriptor.Version != codexProfileVersion || descriptor.Source != domain.CodexProfileSourceManaged || descriptor.CreatedAt.IsZero() || !validCodexProfileLabel(label) {
		return broken(domain.CodexProfileReasonDescriptorInvalid, "This Codex account descriptor is invalid.")
	}
	homeInfo, err := os.Lstat(home)
	if errors.Is(err, os.ErrNotExist) {
		return broken(domain.CodexProfileReasonHomeMissing, "This Codex account home is missing.")
	}
	if err != nil || !homeInfo.IsDir() || homeInfo.Mode()&os.ModeSymlink != 0 || homeInfo.Mode().Perm() != 0o700 {
		return broken(domain.CodexProfileReasonUnsafePath, "This Codex account has an unsafe home directory.")
	}
	return codexProfileRecord{
		Home: canonicalPath(home), CreatedAt: descriptor.CreatedAt,
		Snapshot: domain.CodexProfileSnapshot{
			ID: id, Label: label, Source: domain.CodexProfileSourceManaged,
			Status: domain.CodexProfileStatusValid, ReasonCode: domain.CodexProfileReasonValid,
			Reason: "This Codex account is available.", Authentication: uncheckedAuthentication(),
			AuthMethod: domain.CodexAuthMethodUnknown,
		},
	}
}

func readCodexProfileDescriptor(path string) (codexProfileDescriptor, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 || info.Size() > 16<<10 {
		return codexProfileDescriptor{}, errors.New("descriptor is not a regular file")
	}
	f, err := os.Open(path) //nolint:gosec // exact AO-owned descriptor path is verified with Lstat and SameFile.
	if err != nil {
		return codexProfileDescriptor{}, err
	}
	defer func() { _ = f.Close() }()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return codexProfileDescriptor{}, errors.New("descriptor changed while opening")
	}
	data, err := io.ReadAll(io.LimitReader(f, 16<<10))
	if err != nil {
		return codexProfileDescriptor{}, err
	}
	if !utf8.Valid(data) {
		return codexProfileDescriptor{}, errors.New("descriptor is not valid UTF-8")
	}
	var descriptor codexProfileDescriptor
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&descriptor); err != nil {
		return codexProfileDescriptor{}, err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return codexProfileDescriptor{}, errors.New("descriptor contains trailing data")
	}
	return descriptor, nil
}

func (c *codexProfileCatalog) create(label string) (codexProfileRecord, error) {
	label = strings.TrimSpace(label)
	if !validCodexProfileLabel(label) {
		return codexProfileRecord{}, errInvalidCodexProfileLabel
	}
	if err := ensurePrivateDirectory(c.root); err != nil {
		return codexProfileRecord{}, fmt.Errorf("prepare Codex profile catalog: %w", err)
	}
	id := c.newID()
	if !isCanonicalUUIDv4(id) {
		return codexProfileRecord{}, errors.New("generated invalid Codex profile id")
	}
	stage, err := os.MkdirTemp(c.root, ".profile-")
	if err != nil {
		return codexProfileRecord{}, fmt.Errorf("stage Codex profile: %w", err)
	}
	defer func() { _ = os.RemoveAll(stage) }()
	if err := os.Chmod(stage, 0o700); err != nil { //nolint:gosec // profile directories intentionally require owner-only traversal.
		return codexProfileRecord{}, err
	}
	if err := os.Mkdir(filepath.Join(stage, codexProfileHomeDirectory), 0o700); err != nil {
		return codexProfileRecord{}, err
	}
	descriptor := codexProfileDescriptor{Version: codexProfileVersion, ID: id, Label: label, Source: domain.CodexProfileSourceManaged, CreatedAt: c.now()}
	data, err := json.Marshal(descriptor)
	if err != nil {
		return codexProfileRecord{}, err
	}
	data = append(data, '\n')
	descriptorFile, err := os.OpenFile(filepath.Join(stage, codexProfileDescriptorFilename), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return codexProfileRecord{}, err
	}
	if _, err = descriptorFile.Write(data); err == nil {
		err = descriptorFile.Sync()
	}
	closeErr := descriptorFile.Close()
	if err != nil {
		return codexProfileRecord{}, err
	}
	if closeErr != nil {
		return codexProfileRecord{}, closeErr
	}
	final := filepath.Join(c.root, id)
	if err := os.Rename(stage, final); err != nil {
		return codexProfileRecord{}, fmt.Errorf("publish Codex profile: %w", err)
	}
	record := c.readManaged(id)
	c.mu.Lock()
	c.records[id] = record
	c.mu.Unlock()
	c.logger.Info("created managed Codex profile", "profile_id", id, "source", domain.CodexProfileSourceManaged)
	return record, nil
}

func ensurePrivateDirectory(path string) error {
	if path == "" {
		return errors.New("empty directory")
	}
	if info, err := os.Lstat(path); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("path is not a safe directory")
		}
		return os.Chmod(path, 0o700) //nolint:gosec // state directories intentionally require owner-only traversal.
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return err
	}
	return os.Chmod(path, 0o700) //nolint:gosec // state directories intentionally require owner-only traversal.
}

func validCodexProfileLabel(label string) bool {
	if label == "" || strings.TrimSpace(label) != label || !utf8.ValidString(label) || utf8.RuneCountInString(label) > maxCodexProfileLabelRunes {
		return false
	}
	for _, r := range label {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func isCanonicalUUIDv4(value string) bool {
	parsed, err := uuid.Parse(value)
	return err == nil && parsed.Version() == 4 && parsed.String() == value
}

func canonicalPath(path string) string {
	if path == "" {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	return filepath.Clean(abs)
}

var errInvalidCodexProfileLabel = errors.New("invalid Codex profile label")

type unknownCodexProfileError struct{ id string }

func (e unknownCodexProfileError) Error() string {
	return fmt.Sprintf("unknown Codex profile %q", e.id)
}
