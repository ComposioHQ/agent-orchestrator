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
	ClaudeCanonicalCredentialService = claudeCanonicalKeychainService
	ClaudeAccountVaultService        = "Agent Orchestrator Claude Accounts"
	ClaudeSwitchRollbackVaultService = "Agent Orchestrator Claude Switch Rollbacks"
)

var ErrKeychainUnavailable = errors.New("Claude Code Keychain unavailable")

// Keychain stores opaque Claude credential JSON. Implementations never include
// values in process arguments or returned error text.
type Keychain interface {
	Supported() bool
	Get(context.Context, string, string) ([]byte, bool, error)
	Set(context.Context, string, string, []byte) error
	Delete(context.Context, string, string) error
}

func IsolatedCredentialService(secureStorageDir string) string {
	return claudeKeychainServiceName(secureStorageDir)
}

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

func AccountCredentialFields(data []byte) (map[string]json.RawMessage, error) {
	return claudeAccountCredentialFields(data)
}

func MergeCredentialFields(account map[string]json.RawMessage, live []byte) ([]byte, error) {
	return mergeClaudeCredentialFields(account, live)
}

func SharedCredentialProjection(live []byte) ([]byte, error) {
	return claudeSharedCredentialProjection(live)
}

func WriteOAuthAccount(ctx context.Context, configPath string, identity map[string]any) error {
	return writeClaudeOAuthAccount(ctx, configPath, identity)
}
