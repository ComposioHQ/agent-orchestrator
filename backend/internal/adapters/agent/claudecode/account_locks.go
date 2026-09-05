package claudecode

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const claudeLockTouchInterval = 3 * time.Second

const claudeCredentialLockStale = 60 * time.Second

type claudeLockAcquirer func(context.Context, string, time.Duration, time.Duration) (func(), error)

// AcquireCredentialLocks acquires Claude Code's refresh locks in native order.
func AcquireCredentialLocks(ctx context.Context, claudeDir string) (func(), error) {
	return acquireClaudeCredentialLocksWith(ctx, claudeDir, acquireClaudeProperLock)
}

func acquireClaudeCredentialLocksWith(ctx context.Context, claudeDir string, acquire claudeLockAcquirer) (func(), error) {
	paths := []string{filepath.Join(claudeDir, ".oauth_refresh.lock"), claudeDir + ".lock"}
	releases := make([]func(), 0, len(paths))
	for _, path := range paths {
		release, err := acquire(ctx, path, claudeCredentialLockStale, claudeLockWait)
		if err != nil {
			for i := len(releases) - 1; i >= 0; i-- {
				releases[i]()
			}
			return nil, err
		}
		releases = append(releases, release)
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			for i := len(releases) - 1; i >= 0; i-- {
				releases[i]()
			}
		})
	}, nil
}

func acquireClaudeProperLock(ctx context.Context, path string, staleAfter, timeout time.Duration) (func(), error) {
	deadline := time.Now().Add(timeout)
	for {
		if err := os.Mkdir(path, 0o700); err == nil {
			break
		} else if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("acquire Claude lock: %w", err)
		}
		if info, err := os.Stat(path); err == nil && time.Since(info.ModTime()) > staleAfter {
			_ = os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, errors.New("credential update already in progress for Claude Code; retry shortly")
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}

	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(claudeLockTouchInterval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case now := <-ticker.C:
				_ = os.Chtimes(path, now, now)
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(stop)
			<-done
			_ = os.Remove(path)
		})
	}, nil
}
