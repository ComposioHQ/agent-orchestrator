package ticket

import (
	"strings"
	"sync"
	"time"
)

// MemoryReplayGuard is the single-use record for one sandbox process.
//
// In-memory is the right durability for it, not a compromise. A ticket lives at
// most MaxTTL; the listener that would have to remember it is the same process
// that would have to still be running to serve the replayed connection. If the
// listener restarts, every ticket minted before the restart is unusable anyway
// because the connections they authorize are gone — there is nothing for a
// replay to reach.
//
// Memory is bounded by (issuance rate x MaxTTL), and only for tickets whose MAC
// already verified: an attacker without the sandbox key cannot add a single
// entry. Expired entries are pruned lazily on Consume, which is the only path
// that adds one.
type MemoryReplayGuard struct {
	now func() time.Time

	mu    sync.Mutex
	spent map[string]time.Time
	// nextPrune throttles the sweep so a burst of opens does not walk the whole
	// map on every connection.
	nextPrune time.Time
}

// pruneInterval is how often Consume sweeps expired entries. It is well under
// MaxTTL, so the map never holds much more than one ticket lifetime's worth.
const pruneInterval = 30 * time.Second

// NewMemoryReplayGuard builds a guard. now may be nil.
func NewMemoryReplayGuard(now func() time.Time) *MemoryReplayGuard {
	if now == nil {
		now = time.Now
	}
	return &MemoryReplayGuard{now: now, spent: make(map[string]time.Time)}
}

// Consume records a ticket id, or reports that it was already spent.
func (g *MemoryReplayGuard) Consume(id string, expiresAt time.Time) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now().UTC()
	g.pruneLocked(now)
	if _, used := g.spent[id]; used {
		return ErrReplayed
	}
	// A ticket whose expiry is somehow in the past would be forgotten by the
	// very next sweep, re-opening the replay window it was meant to close.
	// Hold every entry for at least one full ticket lifetime.
	horizon := now.Add(MaxTTL)
	if expiresAt.After(horizon) {
		horizon = expiresAt
	}
	g.spent[id] = horizon
	return nil
}

// Len reports how many ids are currently remembered. It exists for the bound
// test, which is the only thing that keeps the pruning honest.
func (g *MemoryReplayGuard) Len() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.spent)
}

func (g *MemoryReplayGuard) pruneLocked(now time.Time) {
	if now.Before(g.nextPrune) {
		return
	}
	g.nextPrune = now.Add(pruneInterval)
	for id, expiresAt := range g.spent {
		if !expiresAt.After(now) {
			delete(g.spent, id)
		}
	}
}

// FromSubprotocols extracts a ticket from a WebSocket handshake's offered
// subprotocol list. It returns the ticket and whether the client also offered
// the mux subprotocol itself, so the caller can refuse a handshake that carries
// a credential but does not speak the protocol.
//
// Only the FIRST ticket entry is honoured. A client offering several is either
// confused or probing, and picking one by search order would make which ticket
// gets spent depend on header ordering.
func FromSubprotocols(offered []string) (presented string, speaksMux bool) {
	for _, entry := range offered {
		entry = strings.TrimSpace(entry)
		switch {
		case entry == Subprotocol:
			speaksMux = true
		case presented == "" && strings.HasPrefix(entry, TicketSubprotocolPrefix):
			presented = strings.TrimPrefix(entry, TicketSubprotocolPrefix)
		}
	}
	return presented, speaksMux
}

// Subprotocols renders the handshake list a client offers for one ticket. The
// control plane publishes exactly this in terminal metadata, so client and
// listener cannot drift on the encoding.
func Subprotocols(presented string) []string {
	return []string{Subprotocol, TicketSubprotocolPrefix + presented}
}
