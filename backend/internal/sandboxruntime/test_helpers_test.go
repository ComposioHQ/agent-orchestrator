package sandboxruntime

import (
	"context"
	"io"
	"sync"
)

type fakePTY struct {
	readCh     chan []byte
	done       chan struct{}
	once       sync.Once
	mu         sync.Mutex
	writes     []byte
	resizes    [][2]uint16
	terminated bool
}

func newFakePTY() *fakePTY {
	return &fakePTY{readCh: make(chan []byte, 8), done: make(chan struct{})}
}

func (p *fakePTY) Read(dst []byte) (int, error) {
	select {
	case data := <-p.readCh:
		return copy(dst, data), nil
	case <-p.done:
		return 0, io.EOF
	}
}
func (p *fakePTY) Write(data []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.writes = append(p.writes, data...)
	return len(data), nil
}
func (p *fakePTY) Resize(rows, cols uint16) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.resizes = append(p.resizes, [2]uint16{rows, cols})
	return nil
}
func (p *fakePTY) Close() error { p.stop(); return nil }
func (p *fakePTY) Wait() error  { <-p.done; return nil }
func (p *fakePTY) Terminate(context.Context) error {
	p.mu.Lock()
	p.terminated = true
	p.mu.Unlock()
	p.stop()
	return nil
}
func (p *fakePTY) stop() { p.once.Do(func() { close(p.done) }) }

type fakeRedeemer struct {
	mu     sync.Mutex
	grants map[string]TicketGrant
	calls  int
}

func (r *fakeRedeemer) Redeem(_ context.Context, ticket string) (TicketGrant, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	grant, ok := r.grants[ticket]
	if !ok {
		return TicketGrant{}, ErrTicketRejected
	}
	delete(r.grants, ticket) // atomic consume
	return grant, nil
}
