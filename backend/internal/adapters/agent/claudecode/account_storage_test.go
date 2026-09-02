package claudecode

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestClaudeKeychainServiceNameHashesTheRawNFCPath(t *testing.T) {
	const want = "Claude Code-credentials-d9bb68e0"
	if got := claudeKeychainServiceName("/tmp/ao pending/auth"); got != want {
		t.Fatalf("service name = %q, want %q", got, want)
	}

	// Claude normalizes the raw environment string to NFC before hashing.
	decomposed := "/tmp/Cafe\u0301/auth"
	composed := "/tmp/Caf\u00e9/auth"
	if got, want := claudeKeychainServiceName(decomposed), claudeKeychainServiceName(composed); got != want {
		t.Fatalf("NFC-equivalent paths hashed differently: %q != %q", got, want)
	}
}

func TestClaudeKeychainAccountFallsBackWithoutEnvironmentUser(t *testing.T) {
	got := claudeKeychainAccount("", func() (string, error) { return "login-user", nil })
	if got != "login-user" {
		t.Fatalf("fallback account = %q, want login-user", got)
	}
	got = claudeKeychainAccount("", func() (string, error) { return "", os.ErrNotExist })
	if got != "claude-code-user" {
		t.Fatalf("terminal fallback account = %q, want claude-code-user", got)
	}
	got = claudeKeychainAccount("environment-user", func() (string, error) {
		t.Fatal("lookup called despite USER")
		return "", nil
	})
	if got != "environment-user" {
		t.Fatalf("environment account = %q", got)
	}
}

func TestClaudeCredentialLocksUseNativeOrder(t *testing.T) {
	root := t.TempDir()
	claudeDir := filepath.Join(root, ".claude")
	if err := os.Mkdir(claudeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	var acquired []string
	release, err := acquireClaudeCredentialLocksWith(context.Background(), claudeDir, func(_ context.Context, path string, _, _ time.Duration) (func(), error) {
		acquired = append(acquired, path)
		return func() {}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	release()
	want := []string{filepath.Join(claudeDir, ".oauth_refresh.lock"), claudeDir + ".lock"}
	if !reflect.DeepEqual(acquired, want) {
		t.Fatalf("lock order = %v, want %v", acquired, want)
	}
}

func TestClaudeProperLockReclaimsOnlyStaleDirectories(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".oauth_refresh.lock")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	staleAt := time.Now().Add(-2 * time.Minute)
	if err := os.Chtimes(path, staleAt, staleAt); err != nil {
		t.Fatal(err)
	}

	release, err := acquireClaudeProperLock(context.Background(), path, time.Minute, 250*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("reclaimed lock was not held: %v", err)
	}
	release()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("lock directory still exists after release: %v", err)
	}
}

func TestClaudeCredentialMergeKeepsOnlyLiveSharedFields(t *testing.T) {
	target := []byte(`{
		"claudeAiOauth":{"accessToken":"target-secret"},
		"trustedDeviceToken":"target-device",
		"futureAccountField":{"value":"target"},
		"mcpOAuth":{"token":"stale-target-shared"}
	}`)
	live := []byte(`{
		"claudeAiOauth":{"accessToken":"source-secret"},
		"trustedDeviceToken":"source-device",
		"futureAccountField":{"value":"source"},
		"mcpOAuth":{"token":"live-shared"},
		"pluginSecrets":{"plugin":"live"}
	}`)

	accountFields, err := claudeAccountCredentialFields(target)
	if err != nil {
		t.Fatal(err)
	}
	merged, err := mergeClaudeCredentialFields(accountFields, live)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(merged, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"claudeAiOauth":      map[string]any{"accessToken": "target-secret"},
		"trustedDeviceToken": "target-device",
		"futureAccountField": map[string]any{"value": "target"},
		"mcpOAuth":           map[string]any{"token": "live-shared"},
		"pluginSecrets":      map[string]any{"plugin": "live"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("merged credential = %#v, want %#v", got, want)
	}
}

func TestWriteClaudeOAuthAccountPreservesUnrelatedConfig(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, ".claude.json")
	if err := os.WriteFile(configPath, []byte(`{"projects":{"/work":{"hasTrustDialogAccepted":true}},"theme":"dark","oauthAccount":{"accountUuid":"old"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	identity := map[string]any{"accountUuid": "new", "emailAddress": "new@example.com"}
	if err := writeClaudeOAuthAccount(context.Background(), configPath, identity); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got["theme"] != "dark" || got["oauthAccount"].(map[string]any)["accountUuid"] != "new" {
		t.Fatalf("config mutation lost or failed to replace fields: %#v", got)
	}
	projects := got["projects"].(map[string]any)
	if projects["/work"].(map[string]any)["hasTrustDialogAccepted"] != true {
		t.Fatalf("workspace trust was lost: %#v", got)
	}
}
