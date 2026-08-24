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

type Scope string

const (
	ScopeRead    Scope = "terminal:read"
	ScopeOperate Scope = "terminal:operate"
	ScopeObserve Scope = "workspace:observe"
)

var (
	ErrInvalid  = errors.New("invalid terminal ticket")
	ErrExpired  = errors.New("terminal ticket expired")
	ErrConsumed = errors.New("terminal ticket already consumed")
	ErrConflict = errors.New("terminal ticket already exists")
)

type Binding struct{ OrgID, WorkspaceID, SessionID, SandboxID string }

func (b Binding) Validate() error {
	if strings.TrimSpace(b.OrgID) == "" || strings.TrimSpace(b.WorkspaceID) == "" || strings.TrimSpace(b.SessionID) == "" || strings.TrimSpace(b.SandboxID) == "" {
		return ErrInvalid
	}
	return nil
}

type Record struct {
	ID                              string
	Binding                         Binding
	Scopes                          []Scope
	Verifier                        string
	IssuedAt, ExpiresAt, ConsumedAt time.Time
}
type Ticket struct {
	Token     string
	Binding   Binding
	Scopes    []Scope
	ExpiresAt time.Time
}
type Grant struct {
	Binding   Binding
	Scopes    []Scope
	ExpiresAt time.Time
}

type Store interface {
	Insert(context.Context, Record) error
	Consume(context.Context, string, Binding, time.Time) (Record, error)
	DeleteExpired(context.Context, time.Time) (int, error)
}

type Authority struct {
	store   Store
	ttl     time.Duration
	now     func() time.Time
	entropy io.Reader
}

func New(store Store, ttl time.Duration) (*Authority, error) {
	if store == nil || ttl <= 0 {
		return nil, errors.New("terminal ticket store and positive lifetime are required")
	}
	return &Authority{store: store, ttl: ttl, now: time.Now, entropy: rand.Reader}, nil
}

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
