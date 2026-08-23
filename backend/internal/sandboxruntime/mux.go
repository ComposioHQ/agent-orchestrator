package sandboxruntime

import (
	"context"
	"encoding/base64"
	"errors"
	"sync"
	"sync/atomic"

	"github.com/aoagents/agent-orchestrator/backend/internal/terminal/muxproto"
)

const (
	defaultMuxBuffer = 256
	maxReplayBytes   = 1 << 20
)

// PTYMux is a direct, in-process mux over one PTY. It speaks exactly the local
// mux JSON frames but owns no AO session state; durable facts remain remote.
type PTYMux struct {
	pty       PTY
	sessionID string

	writeMu sync.Mutex
	mu      sync.Mutex
	clients map[*muxClient]struct{}
	replay  []byte
	exited  bool
	closed  bool
	done    chan struct{}
}

type muxClient struct {
	out     chan muxproto.ServerFrame
	operate bool
	opened  atomic.Bool
}

// NewPTYMux starts broadcasting one direct PTY through the shared mux frames.
func NewPTYMux(pty PTY, sessionID string) *PTYMux {
	m := &PTYMux{pty: pty, sessionID: sessionID, clients: make(map[*muxClient]struct{}), done: make(chan struct{})}
	go m.readLoop()
	return m
}

// Done closes when the owned PTY exits.
func (m *PTYMux) Done() <-chan struct{} { return m.done }

// AddClient registers one authenticated viewer and returns its removal hook.
func (m *PTYMux) AddClient(operate bool) (*muxClient, func()) {
	c := &muxClient{out: make(chan muxproto.ServerFrame, defaultMuxBuffer), operate: operate}
	m.mu.Lock()
	m.clients[c] = struct{}{}
	m.mu.Unlock()
	var once sync.Once
	return c, func() {
		once.Do(func() {
			m.mu.Lock()
			delete(m.clients, c)
			m.mu.Unlock()
		})
	}
}

// Handle applies one client frame to the direct PTY mux.
func (m *PTYMux) Handle(c *muxClient, frame muxproto.ClientFrame) {
	switch frame.Channel {
	case muxproto.ChannelSystem:
		if frame.Type == muxproto.TypePing {
			m.enqueue(c, muxproto.ServerFrame{Channel: muxproto.ChannelSystem, Type: muxproto.TypePong})
		}
	case muxproto.ChannelTerminal:
		m.handleTerminal(c, frame)
	}
}

func (m *PTYMux) handleTerminal(c *muxClient, frame muxproto.ClientFrame) {
	if frame.ID != m.sessionID && frame.Type != muxproto.TypeOpen {
		return
	}
	switch frame.Type {
	case muxproto.TypeOpen:
		if frame.ID == "" || frame.ID != m.sessionID {
			m.enqueue(c, muxproto.ServerFrame{Channel: muxproto.ChannelTerminal, ID: frame.ID, Type: muxproto.TypeError, Error: "terminal is outside ticket scope"})
			return
		}
		if c.opened.Swap(true) {
			return
		}
		if c.operate && frame.Rows > 0 && frame.Cols > 0 {
			_ = m.resize(frame.Rows, frame.Cols)
		}
		m.enqueue(c, muxproto.ServerFrame{Channel: muxproto.ChannelTerminal, ID: m.sessionID, Type: muxproto.TypeOpened})
		m.mu.Lock()
		replay := append([]byte(nil), m.replay...)
		exited := m.exited
		m.mu.Unlock()
		if len(replay) > 0 {
			m.enqueue(c, dataFrame(m.sessionID, replay))
		}
		if exited {
			m.enqueue(c, muxproto.ServerFrame{Channel: muxproto.ChannelTerminal, ID: m.sessionID, Type: muxproto.TypeExited})
		}
	case muxproto.TypeData:
		if !c.opened.Load() || !c.operate {
			m.enqueue(c, muxproto.ServerFrame{Channel: muxproto.ChannelTerminal, ID: m.sessionID, Type: muxproto.TypeError, Error: "terminal input is outside ticket scope"})
			return
		}
		raw, err := base64.StdEncoding.DecodeString(frame.Data)
		if err == nil {
			m.writeMu.Lock()
			_, _ = m.pty.Write(raw)
			m.writeMu.Unlock()
		}
	case muxproto.TypeResize:
		if c.opened.Load() && c.operate {
			_ = m.resize(frame.Rows, frame.Cols)
		}
	case muxproto.TypeClose:
		c.opened.Store(false)
	}
}

func (m *PTYMux) resize(rows, cols uint16) error {
	if rows == 0 || cols == 0 {
		return errors.New("terminal dimensions must be non-zero")
	}
	m.writeMu.Lock()
	defer m.writeMu.Unlock()
	return m.pty.Resize(rows, cols)
}

func (m *PTYMux) readLoop() {
	buf := make([]byte, 32<<10)
	for {
		n, err := m.pty.Read(buf)
		if n > 0 {
			chunk := append([]byte(nil), buf[:n]...)
			m.mu.Lock()
			m.replay = append(m.replay, chunk...)
			if len(m.replay) > maxReplayBytes {
				m.replay = append([]byte(nil), m.replay[len(m.replay)-maxReplayBytes:]...)
			}
			clients := m.openClientsLocked()
			m.mu.Unlock()
			for _, c := range clients {
				m.enqueue(c, dataFrame(m.sessionID, chunk))
			}
		}
		if err != nil {
			break
		}
	}
	_ = m.pty.Wait()
	m.mu.Lock()
	m.exited = true
	clients := m.openClientsLocked()
	m.mu.Unlock()
	for _, c := range clients {
		m.enqueue(c, muxproto.ServerFrame{Channel: muxproto.ChannelTerminal, ID: m.sessionID, Type: muxproto.TypeExited})
	}
	close(m.done)
}

func (m *PTYMux) openClientsLocked() []*muxClient {
	clients := make([]*muxClient, 0, len(m.clients))
	for c := range m.clients {
		if c.opened.Load() {
			clients = append(clients, c)
		}
	}
	return clients
}

func (m *PTYMux) enqueue(c *muxClient, frame muxproto.ServerFrame) {
	select {
	case c.out <- frame:
	default:
		// A slow client loses its attachment, never the PTY or another viewer.
		m.mu.Lock()
		delete(m.clients, c)
		m.mu.Unlock()
	}
}

func dataFrame(id string, data []byte) muxproto.ServerFrame {
	return muxproto.ServerFrame{Channel: muxproto.ChannelTerminal, ID: id, Type: muxproto.TypeData, Data: base64.StdEncoding.EncodeToString(data)}
}

// Close terminates the PTY and releases its file descriptor.
func (m *PTYMux) Close(ctx context.Context) error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	m.mu.Unlock()
	err := m.pty.Terminate(ctx)
	_ = m.pty.Close()
	return err
}
