package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
	"github.com/aoagents/agent-orchestrator/backend/internal/tenant"
)

const (
	defaultEventPollInterval = 500 * time.Millisecond
	defaultListenRetry       = 100 * time.Millisecond
	cloudSubscriberBuffer    = 64
)

type eventSubscription struct {
	orgID    string
	identity tenant.Identity
	fn       func(ports.ChangeEvent)
}

// EventHubConfig controls the durable catch-up loop. LISTEN/NOTIFY is only a
// low-latency wake-up; PollInterval bounds recovery when a notification or the
// listener connection is lost.
type EventHubConfig struct {
	PollInterval time.Duration
	ListenRetry  time.Duration
	Logger       *slog.Logger
}

// EventHub fans committed tenant events to subscribers on this API instance.
// Every API instance owns a listener and catches up from ao_change_log, so a
// notification received by several instances produces fan-out on all of them.
type EventHub struct {
	store        *Store
	pollInterval time.Duration
	listenRetry  time.Duration
	logger       *slog.Logger

	mu      sync.Mutex
	nextID  int
	subs    map[int]eventSubscription
	cursors map[string]int64
	wake    chan string
	cancel  context.CancelFunc
	wg      sync.WaitGroup
}

func NewEventHub(store *Store, cfg EventHubConfig) *EventHub {
	hub := &EventHub{
		store:        store,
		pollInterval: cfg.PollInterval,
		listenRetry:  cfg.ListenRetry,
		logger:       cfg.Logger,
		subs:         make(map[int]eventSubscription),
		cursors:      make(map[string]int64),
		wake:         make(chan string, 256),
	}
	if hub.pollInterval <= 0 {
		hub.pollInterval = defaultEventPollInterval
	}
	if hub.listenRetry <= 0 {
		hub.listenRetry = defaultListenRetry
	}
	if hub.logger == nil {
		hub.logger = slog.Default()
	}
	return hub
}

// Start begins database notification listening and durable gap polling.
func (h *EventHub) Start(ctx context.Context) error {
	if h == nil || h.store == nil || h.store.pool == nil {
		return errors.New("start event hub: postgres store is required")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.cancel != nil {
		return errors.New("start event hub: already started")
	}
	runCtx, cancel := context.WithCancel(ctx)
	h.cancel = cancel
	h.wg.Add(2)
	go h.run(runCtx)
	go h.listen(runCtx)
	return nil
}

// Close stops the listener and catch-up loop.
func (h *EventHub) Close() {
	if h == nil {
		return
	}
	h.mu.Lock()
	cancel := h.cancel
	h.cancel = nil
	h.mu.Unlock()
	if cancel != nil {
		cancel()
		h.wg.Wait()
	}
}

func (h *EventHub) SubscribeChanges(
	ctx context.Context,
	fn func(ports.ChangeEvent),
) (func(), error) {
	if fn == nil {
		return nil, errors.New("subscribe changes: callback is required")
	}
	identity, ok := tenant.FromContext(ctx)
	if !ok {
		return nil, tenant.ErrNoTenant
	}
	latest, err := h.store.LatestSeq(ctx)
	if err != nil {
		return nil, err
	}
	h.mu.Lock()
	if h.cancel == nil {
		h.mu.Unlock()
		return nil, errors.New("subscribe changes: event hub is not started")
	}
	id := h.nextID
	h.nextID++
	h.subs[id] = eventSubscription{orgID: identity.OrgID, identity: identity, fn: fn}
	if _, exists := h.cursors[identity.OrgID]; !exists {
		h.cursors[identity.OrgID] = latest
	}
	h.mu.Unlock()
	h.signal(identity.OrgID)
	var once sync.Once
	unsubscribe := func() {
		once.Do(func() {
			h.mu.Lock()
			delete(h.subs, id)
			if !h.hasOrgSubscriberLocked(identity.OrgID) {
				delete(h.cursors, identity.OrgID)
			}
			h.mu.Unlock()
		})
	}
	go func() {
		<-ctx.Done()
		unsubscribe()
	}()
	return unsubscribe, nil
}

// SubscribeNotifications derives the live notification stream from the same
// durable tenant log. The notification store records a marshaled
// domain.NotificationRecord as the change payload.
func (h *EventHub) SubscribeNotifications(
	ctx context.Context,
	projectID domain.ProjectID,
) (<-chan domain.NotificationEvent, func(), error) {
	events := make(chan domain.NotificationEvent, cloudSubscriberBuffer)
	var closeOnce sync.Once
	var deliveryMu sync.Mutex
	closed := false
	unsubscribeChanges, err := h.SubscribeChanges(ctx, func(change ports.ChangeEvent) {
		var kind domain.NotificationEventKind
		switch change.Type {
		case ports.ChangeEventNotificationCreated:
			kind = domain.NotificationCreated
		case ports.ChangeEventNotificationResolved:
			kind = domain.NotificationResolved
		default:
			return
		}
		var record domain.NotificationRecord
		if err := json.Unmarshal(change.Payload, &record); err != nil {
			h.logger.Error("decode notification change event", "seq", change.Seq, "err", err)
			return
		}
		if projectID != "" && record.ProjectID != projectID {
			return
		}
		deliveryMu.Lock()
		defer deliveryMu.Unlock()
		if closed {
			return
		}
		select {
		case events <- domain.NotificationEvent{Kind: kind, Record: record}:
		default:
			// Notification REST listing is the durable catch-up path. Match the
			// local hub's non-blocking behavior when one client falls behind.
		}
	})
	if err != nil {
		close(events)
		return nil, nil, err
	}
	unsubscribe := func() {
		closeOnce.Do(func() {
			unsubscribeChanges()
			deliveryMu.Lock()
			closed = true
			close(events)
			deliveryMu.Unlock()
		})
	}
	return events, unsubscribe, nil
}

func (h *EventHub) run(ctx context.Context) {
	defer h.wg.Done()
	ticker := time.NewTicker(h.pollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case orgID := <-h.wake:
			h.catchUp(ctx, orgID)
		case <-ticker.C:
			for _, orgID := range h.subscribedOrgs() {
				h.catchUp(ctx, orgID)
			}
		}
	}
}

func (h *EventHub) listen(ctx context.Context) {
	defer h.wg.Done()
	for ctx.Err() == nil {
		conn, err := h.store.pool.Acquire(ctx)
		if err != nil {
			h.logListenFailure(ctx, err)
			continue
		}
		_, err = conn.Exec(ctx, `LISTEN ao_change_events`)
		if err == nil {
			for _, orgID := range h.subscribedOrgs() {
				h.signal(orgID)
			}
			for ctx.Err() == nil {
				notification, waitErr := conn.Conn().WaitForNotification(ctx)
				if waitErr != nil {
					err = waitErr
					break
				}
				h.signal(notification.Payload)
			}
		}
		conn.Release()
		if ctx.Err() == nil {
			h.logListenFailure(ctx, err)
		}
	}
}

func (h *EventHub) logListenFailure(ctx context.Context, err error) {
	if err != nil {
		h.logger.Warn("postgres event listener reconnecting", "err", err)
	}
	timer := time.NewTimer(h.listenRetry)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}

func (h *EventHub) catchUp(ctx context.Context, orgID string) {
	identity, after, ok := h.orgState(orgID)
	if !ok {
		return
	}
	tenantCtx := tenant.WithIdentity(ctx, identity)
	for {
		events, err := h.store.EventsAfter(tenantCtx, after, maxChangeEventBatch)
		if err != nil {
			h.logger.Error("catch up postgres change events", "org_id", orgID, "after", after, "err", err)
			return
		}
		if len(events) == 0 {
			return
		}
		for _, event := range events {
			if event.Seq <= after {
				continue
			}
			h.publish(orgID, event)
			after = event.Seq
			h.mu.Lock()
			if cursor, exists := h.cursors[orgID]; exists && event.Seq > cursor {
				h.cursors[orgID] = event.Seq
			}
			h.mu.Unlock()
		}
		if len(events) < maxChangeEventBatch {
			return
		}
	}
}

func (h *EventHub) publish(orgID string, event ports.ChangeEvent) {
	h.mu.Lock()
	callbacks := make([]func(ports.ChangeEvent), 0)
	for _, sub := range h.subs {
		if sub.orgID == orgID {
			callbacks = append(callbacks, sub.fn)
		}
	}
	h.mu.Unlock()
	for _, callback := range callbacks {
		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					h.logger.Error("postgres event subscriber panicked", "seq", event.Seq, "panic", recovered)
				}
			}()
			callback(event)
		}()
	}
}

func (h *EventHub) orgState(orgID string) (tenant.Identity, int64, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	cursor, ok := h.cursors[orgID]
	if !ok {
		return tenant.Identity{}, 0, false
	}
	for _, sub := range h.subs {
		if sub.orgID == orgID {
			return sub.identity, cursor, true
		}
	}
	return tenant.Identity{}, 0, false
}

func (h *EventHub) subscribedOrgs() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	orgs := make([]string, 0, len(h.cursors))
	for orgID := range h.cursors {
		orgs = append(orgs, orgID)
	}
	return orgs
}

func (h *EventHub) hasOrgSubscriberLocked(orgID string) bool {
	for _, sub := range h.subs {
		if sub.orgID == orgID {
			return true
		}
	}
	return false
}

func (h *EventHub) signal(orgID string) {
	select {
	case h.wake <- orgID:
	default:
		// The periodic durable catch-up makes a dropped wake-up harmless.
	}
}

var (
	_ ports.ChangeEventSubscriber  = (*EventHub)(nil)
	_ ports.NotificationSubscriber = (*EventHub)(nil)
)
