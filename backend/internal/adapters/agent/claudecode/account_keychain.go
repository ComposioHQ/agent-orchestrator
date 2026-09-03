package claudecode

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/user"
	"strconv"
	"strings"
)

const (
	// ClaudeCanonicalCredentialService is Claude Code's device-global credential service.
	ClaudeCanonicalCredentialService = claudeCanonicalKeychainService
	// ClaudeAccountVaultService stores per-account credentials owned by AO.
	ClaudeAccountVaultService = "Agent Orchestrator Claude Accounts"
	// ClaudeSwitchRollbackVaultService stores temporary rollback snapshots owned by AO.
	ClaudeSwitchRollbackVaultService = "Agent Orchestrator Claude Switch Rollbacks"
)

// ErrKeychainUnavailable reports that the native credential store cannot be used safely.
var ErrKeychainUnavailable = errors.New("keychain unavailable for Claude Code")

// Keychain stores opaque Claude credential JSON. Implementations never include
// values in process arguments or returned error text.
type Keychain interface {
	Supported() bool
	Get(context.Context, string, string) ([]byte, bool, error)
	Set(context.Context, string, string, []byte) error
	Delete(context.Context, string, string) error
}

// IsolatedCredentialService derives Claude Code's hashed service for an isolated secure-storage directory.
func IsolatedCredentialService(secureStorageDir string) string {
	return claudeKeychainServiceName(secureStorageDir)
}

// KeychainAccount returns the OS account name Claude Code uses for Keychain entries.
func KeychainAccount() string {
	return claudeKeychainAccount(os.Getenv("USER"), func() (string, error) {
		current, err := user.LookupId(strconv.Itoa(os.Geteuid()))
		if err != nil {
			return "", err
		}
		return current.Username, nil
	})
}

func claudeKeychainAccount(envUser string, lookup func() (string, error)) string {
	if value := strings.TrimSpace(envUser); value != "" {
		return value
	}
	if lookup != nil {
		if value, err := lookup(); err == nil && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return "claude-code-user"
}

// AccountCredentialFields extracts only fields owned by one Claude Code account.
func AccountCredentialFields(data []byte) (map[string]json.RawMessage, error) {
	return claudeAccountCredentialFields(data)
}

// HasAccountCredential reports whether a canonical Keychain object still
// contains Claude's account-owned OAuth credential. Claude may retain shared
// plugin or MCP fields in the Keychain item after signing out.
func HasAccountCredential(data []byte) (bool, error) {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(data, &root); err != nil {
		return false, err
	}
	return claudeAccountCredentialPresent(root["claudeAiOauth"])
}

// MergeCredentialFields combines account-owned fields with allowlisted live machine-shared fields.
func MergeCredentialFields(account map[string]json.RawMessage, live []byte) ([]byte, error) {
	return mergeClaudeCredentialFields(account, live)
}

// SharedCredentialProjection returns only allowlisted machine-shared credential fields.
func SharedCredentialProjection(live []byte) ([]byte, error) {
	return claudeSharedCredentialProjection(live)
}

// WriteOAuthAccount replaces only oauthAccount in Claude Code's configuration.
func WriteOAuthAccount(ctx context.Context, configPath string, identity map[string]any) error {
	return writeClaudeOAuthAccount(ctx, configPath, identity)
}
