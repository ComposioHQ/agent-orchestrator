package claudecode

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

var errClaudeConfigUnchanged = errors.New("claude config unchanged")

const (
	claudeConfigLockStale = 10 * time.Second
	claudeLockWait        = 9 * time.Second
)

func writeClaudeOAuthAccount(ctx context.Context, configPath string, identity map[string]any) error {
	return mutateClaudeConfig(ctx, configPath, func(root map[string]any) error {
		if len(identity) == 0 {
			delete(root, "oauthAccount")
		} else {
			root["oauthAccount"] = identity
		}
		return nil
	})
}

func mutateClaudeConfig(ctx context.Context, configPath string, mutate func(map[string]any) error) error {
	release, err := acquireClaudeProperLock(ctx, configPath+".lock", claudeConfigLockStale, claudeLockWait)
	if err != nil {
		return err
	}
	defer release()

	root := map[string]any{}
	data, err := os.ReadFile(configPath)
	switch {
	case err == nil && len(bytes.TrimSpace(data)) == 0:
		return fmt.Errorf("claude config %s is empty; refusing to overwrite", configPath)
	case err == nil:
		if err := json.Unmarshal(data, &root); err != nil {
			return fmt.Errorf("parse Claude config: %w", err)
		}
	case os.IsNotExist(err):
	default:
		return fmt.Errorf("read Claude config: %w", err)
	}
	if err := mutate(root); err != nil {
		if errors.Is(err, errClaudeConfigUnchanged) {
			return nil
		}
		return err
	}
	out, err := json.MarshalIndent(root, "", "  ")
	if err != nil {
		return err
	}
	out = append(out, '\n')
	dir := filepath.Dir(configPath)
	tmp, err := os.CreateTemp(dir, ".claude.json.tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(out); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpPath, configPath)
}
