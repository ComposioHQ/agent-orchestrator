// Package claudeops owns admission to operations that use or mutate Claude
// Code's device-global credential.
package claudeops

import (
	"context"
	"sync"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Gate coordinates Claude launches with exclusive device-credential mutations.
type Gate struct {
	mu        sync.Mutex
	shared    int
	exclusive bool
	drained   chan struct{}
}

// NewGate creates an idle Claude operation gate.
func NewGate() *Gate {
	drained := make(chan struct{})
	close(drained)
	return &Gate{drained: drained}
}

// AcquireShared admits one Claude launch unless an exclusive mutation is pending.
func (g *Gate) AcquireShared(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	g.mu.Lock()
	if g.exclusive {
		g.mu.Unlock()
		return nil, ports.ErrClaudeCodeAccountSwitchInProgress
	}
	if g.shared == 0 {
		g.drained = make(chan struct{})
	}
	g.shared++
	g.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			g.mu.Lock()
			g.shared--
			if g.shared == 0 {
				close(g.drained)
			}
			g.mu.Unlock()
		})
	}, nil
}

// AcquireExclusive fences new launches and waits for admitted launches to drain.
func (g *Gate) AcquireExclusive(ctx context.Context) (ports.ClaudeCodeOperationLease, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	g.mu.Lock()
	if g.exclusive {
		g.mu.Unlock()
		return nil, ports.ErrClaudeCodeAccountSwitchInProgress
	}
	g.exclusive = true
	drained := g.drained
	g.mu.Unlock()
	select {
	case <-drained:
		return &exclusiveLease{gate: g}, nil
	case <-ctx.Done():
		g.mu.Lock()
		g.exclusive = false
		g.mu.Unlock()
		return nil, ctx.Err()
	}
}

// ExclusivePendingOrHeld reports whether credentials are fenced for mutation.
func (g *Gate) ExclusivePendingOrHeld() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.exclusive
}

type exclusiveLease struct {
	gate *Gate
	once sync.Once
}

func (l *exclusiveLease) Release() {
	if l == nil || l.gate == nil {
		return
	}
	l.once.Do(func() {
		l.gate.mu.Lock()
		l.gate.exclusive = false
		l.gate.mu.Unlock()
	})
}

var _ ports.ClaudeCodeOperationGate = (*Gate)(nil)
