package claudecode

import (
	"context"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"
)

const claudeLockTouchInterval = 3 * time.Second

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
			return nil, errors.New("Claude Code appears to be updating credentials; retry shortly")
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
