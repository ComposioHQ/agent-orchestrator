package cdc

import (
	"context"
	"log/slog"
	"sync"
)

// Broadcaster is the in-process fan-out the poller feeds. Subscribers such as
// terminal session-state fan-out register a callback; every polled Event is
// delivered to all current subscribers. It is the single seam between the CDC
// poller and live delivery, so transports can be built and swapped without
// touching the poller.
type Broadcaster struct {
	mu     sync.RWMutex
	nextID int
	subs   map[int]func(Event)
	logger *slog.Logger
}

// NewBroadcaster returns an empty Broadcaster ready for subscriptions.
func NewBroadcaster() *Broadcaster {
	return &Broadcaster{subs: map[int]func(Event){}, logger: slog.Default()}
}

// Subscribe registers fn and returns an unsubscribe function. fn is called
// synchronously from the poller loop, so it must not block; a transport that
// needs buffering should push onto its own channel inside fn.
func (b *Broadcaster) Subscribe(fn func(Event)) (unsubscribe func()) {
	b.mu.Lock()
	id := b.nextID
	b.nextID++
	b.subs[id] = fn
	b.mu.Unlock()
	return func() {
		b.mu.Lock()
		delete(b.subs, id)
		b.mu.Unlock()
	}
}

// SubscribeChanges implements ports.ChangeEventSubscriber. The local daemon is
// single tenant, so ctx carries cancellation only; hosted fan-out applies the
// tenant identity as a database scope.
func (b *Broadcaster) SubscribeChanges(ctx context.Context, fn func(Event)) (func(), error) {
	unsubscribe := b.Subscribe(fn)
	if ctx != nil {
		go func() {
			<-ctx.Done()
			unsubscribe()
		}()
	}
	return unsubscribe, nil
}

// SubscriberCount reports the number of current subscribers.
func (b *Broadcaster) SubscriberCount() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.subs)
}

// Publish delivers e to every current subscriber. A panicking subscriber is
// recovered and logged so one bad callback can't kill the poller goroutine or
// starve the other subscribers.
func (b *Broadcaster) Publish(e Event) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	for _, fn := range b.subs {
		b.deliver(fn, e)
	}
}

func (b *Broadcaster) deliver(fn func(Event), e Event) {
	defer func() {
		if r := recover(); r != nil {
			b.logger.Error("cdc broadcaster: subscriber panicked", "seq", e.Seq, "panic", r)
		}
	}()
	fn(e)
}
