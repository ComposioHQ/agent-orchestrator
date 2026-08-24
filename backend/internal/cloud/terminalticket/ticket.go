// Package terminalticket mints and atomically redeems short-lived credentials
// for direct sandbox mux connections. Bearer values are never persisted.
package terminalticket

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"
)

// Scope is one operation a direct terminal connection may perform.
type Scope string

const (
	// ScopeRead allows reading terminal output.
	ScopeRead Scope = "terminal:read"
	// ScopeOperate allows sending terminal input.
	ScopeOperate Scope = "terminal:operate"
	// ScopeObserve allows reading workspace observations.
	ScopeObserve Scope = "workspace:observe"
)

var (
	// ErrInvalid reports malformed tickets or mismatched bindings.
	ErrInvalid = errors.New("invalid terminal ticket")
	// ErrExpired reports a ticket whose lifetime ended.
	ErrExpired = errors.New("terminal ticket expired")
	// ErrConsumed reports a replayed one-time ticket.
	ErrConsumed = errors.New("terminal ticket already consumed")
	// ErrConflict reports a duplicate durable ticket identifier.
	ErrConflict = errors.New("terminal ticket already exists")
)

// Binding ties a ticket to exactly one sandbox session.
type Binding struct{ OrgID, WorkspaceID, SessionID, SandboxID string }

// Validate rejects incomplete bindings.
func (b Binding) Validate() error {
	if strings.TrimSpace(b.OrgID) == "" || strings.TrimSpace(b.WorkspaceID) == "" || strings.TrimSpace(b.SessionID) == "" || strings.TrimSpace(b.SandboxID) == "" {
		return ErrInvalid
	}
	return nil
}

// Record is the durable verifier-only ticket representation.
type Record struct {
	ID                              string
	Binding                         Binding
	Scopes                          []Scope
	Verifier                        string
	IssuedAt, ExpiresAt, ConsumedAt time.Time
}

// Ticket is returned once to an authenticated client at issue time.
type Ticket struct {
	Token     string
	Binding   Binding
	Scopes    []Scope
	ExpiresAt time.Time
}

// Grant is the authorization recovered from a consumed ticket.
type Grant struct {
	Binding   Binding
	Scopes    []Scope
	ExpiresAt time.Time
}

// Store persists verifiers and atomically consumes tickets.
type Store interface {
	Insert(context.Context, Record) error
	Consume(context.Context, string, Binding, time.Time) (Record, error)
	DeleteExpired(context.Context, time.Time) (int, error)
}

// Authority mints opaque tickets and redeems them once.
type Authority struct {
	store   Store
	ttl     time.Duration
	now     func() time.Time
	entropy io.Reader
}

// New builds a terminal ticket authority with a positive lifetime.
func New(store Store, ttl time.Duration) (*Authority, error) {
	if store == nil || ttl <= 0 {
		return nil, errors.New("terminal ticket store and positive lifetime are required")
	}
	return &Authority{store: store, ttl: ttl, now: time.Now, entropy: rand.Reader}, nil
}

// Issue mints and persists a verifier for a new one-time ticket.
func (a *Authority) Issue(ctx context.Context, binding Binding, scopes []Scope) (Ticket, error) {
	if err := binding.Validate(); err != nil {
		return Ticket{}, err
	}
	scopes, err := normalizeScopes(scopes)
	if err != nil {
		return Ticket{}, err
	}
	idBytes := make([]byte, 16)
	secret := make([]byte, 32)
	if _, err = io.ReadFull(a.entropy, idBytes); err != nil {
		return Ticket{}, err
	}
	if _, err = io.ReadFull(a.entropy, secret); err != nil {
		return Ticket{}, err
	}
	token := "ao.ticket." + base64.RawURLEncoding.EncodeToString(secret)
	now := a.now().UTC()
	record := Record{ID: base64.RawURLEncoding.EncodeToString(idBytes), Binding: binding, Scopes: scopes, Verifier: verifier(token), IssuedAt: now, ExpiresAt: now.Add(a.ttl)}
	if err = a.store.Insert(ctx, record); err != nil {
		return Ticket{}, fmt.Errorf("persist terminal ticket: %w", err)
	}
	return Ticket{Token: token, Binding: binding, Scopes: scopes, ExpiresAt: record.ExpiresAt}, nil
}

// Consume atomically redeems a ticket for its exact binding.
func (a *Authority) Consume(ctx context.Context, token string, binding Binding) (Grant, error) {
	if !strings.HasPrefix(token, "ao.ticket.") || binding.Validate() != nil {
		return Grant{}, ErrInvalid
	}
	record, err := a.store.Consume(ctx, verifier(token), binding, a.now().UTC())
	if err != nil {
		return Grant{}, err
	}
	return Grant{Binding: record.Binding, Scopes: record.Scopes, ExpiresAt: record.ExpiresAt}, nil
}

func normalizeScopes(in []Scope) ([]Scope, error) {
	seen := map[Scope]bool{}
	for _, scope := range in {
		switch scope {
		case ScopeRead, ScopeOperate, ScopeObserve:
			seen[scope] = true
		default:
			return nil, ErrInvalid
		}
	}
	if len(seen) == 0 {
		return nil, ErrInvalid
	}
	out := make([]Scope, 0, len(seen))
	for scope := range seen {
		out = append(out, scope)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out, nil
}
func verifier(token string) string {
	sum := sha256.Sum256([]byte(token))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
