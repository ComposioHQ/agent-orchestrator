package capability

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

// Store is the durable half of the authority, kept narrow on purpose: the
// capability package owns the credential rules and the persistence adapter
// owns nothing but rows. Implementations must be safe for concurrent use.
type Store interface {
	ports.ComputeCapabilityStore[Record, Selector]
}

// Authority is the capability issuance and verification service.
type Authority struct {
	store      Store
	defaultTTL time.Duration
	maxTTL     time.Duration
	now        func() time.Time
	entropy    io.Reader
}

// Option adjusts an Authority. Tests use them to pin time and entropy.
type Option func(*Authority)

// WithClock replaces the authority's time source.
func WithClock(now func() time.Time) Option {
	return func(a *Authority) {
		if now != nil {
			a.now = now
		}
	}
}

// WithEntropy replaces the authority's randomness source.
func WithEntropy(entropy io.Reader) Option {
	return func(a *Authority) {
		if entropy != nil {
			a.entropy = entropy
		}
	}
}

// WithMaxTTL caps how long any single grant may live regardless of the ttl a
// caller asks for.
func WithMaxTTL(ttl time.Duration) Option {
	return func(a *Authority) {
		if ttl > 0 {
			a.maxTTL = ttl
		}
	}
}

// New builds an authority over a store. defaultTTL is used whenever a caller
// passes a non-positive ttl to Issue.
func New(store Store, defaultTTL time.Duration, opts ...Option) (*Authority, error) {
	if store == nil {
		return nil, errors.New("capability store is required")
	}
	if defaultTTL <= 0 {
		return nil, errors.New("capability lifetime must be positive")
	}
	authority := &Authority{
		store:      store,
		defaultTTL: defaultTTL,
		maxTTL:     defaultTTL,
		now:        time.Now,
		entropy:    rand.Reader,
	}
	for _, opt := range opts {
		opt(authority)
	}
	if authority.maxTTL < defaultTTL {
		authority.maxTTL = defaultTTL
	}
	return authority, nil
}

// Issue mints a fresh capability for one scope. The returned Grant carries the
// only copy of the bearer token that will ever exist; the store keeps a
// scope-bound one-way verifier.
func (a *Authority) Issue(ctx context.Context, scope Scope, ttl time.Duration) (Grant, error) {
	normalized, err := scope.Normalize()
	if err != nil {
		return Grant{}, err
	}
	if ttl <= 0 {
		ttl = a.defaultTTL
	}
	if ttl > a.maxTTL {
		ttl = a.maxTTL
	}
	id, secret, token, err := mintToken(a.entropy)
	if err != nil {
		return Grant{}, err
	}
	issuedAt := a.now().UTC()
	record := Record{
		ID:        id,
		Scope:     normalized,
		Verifier:  verifierFor(id, normalized, secret),
		IssuedAt:  issuedAt,
		ExpiresAt: issuedAt.Add(ttl),
	}
	if err := a.store.Insert(ctx, record); err != nil {
		return Grant{}, fmt.Errorf("persist capability: %w", err)
	}
	return Grant{
		ID:        record.ID,
		Token:     token,
		Scope:     normalized,
		IssuedAt:  record.IssuedAt,
		ExpiresAt: record.ExpiresAt,
	}, nil
}

// Verified is what a successful verification yields: the grant id (for audit)
// and the scope the caller may act within. Handlers must authorize against
// this scope and never against ids supplied in the request body.
type Verified struct {
	ID        string
	Scope     Scope
	ExpiresAt time.Time
}

// Verify authenticates an opaque capability and authorizes one operation.
//
// A missing grant is reported as ErrInvalidToken rather than ErrNotFound so an
// attacker cannot use the error to enumerate live grant ids.
func (a *Authority) Verify(ctx context.Context, token string, op Operation) (Verified, error) {
	id, secret, err := parseToken(token)
	if err != nil {
		return Verified{}, err
	}
	record, err := a.store.ByID(ctx, id)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return Verified{}, ErrInvalidToken
		}
		return Verified{}, err
	}
	expected := verifierFor(record.ID, record.Scope, secret)
	if !hmac.Equal([]byte(expected), []byte(record.Verifier)) {
		return Verified{}, ErrInvalidToken
	}
	if err := record.Live(a.now().UTC()); err != nil {
		return Verified{}, err
	}
	if !record.Scope.Allows(op) {
		return Verified{}, fmt.Errorf("%w: %s", ErrNotPermitted, op)
	}
	return Verified{ID: record.ID, Scope: record.Scope, ExpiresAt: record.ExpiresAt}, nil
}

// Rotate exchanges a live capability for a successor with the same scope and
// the SAME absolute expiry, then revokes the predecessor. Preserving the
// original expiry (the rule the refresh-token rotation already follows) stops
// a compromised sandbox from extending its own access indefinitely by rotating
// on a timer.
//
// Rotation requires the OpCapabilityRotate operation, so a grant can be minted
// deliberately non-rotatable.
func (a *Authority) Rotate(ctx context.Context, token string) (Grant, error) {
	verified, err := a.Verify(ctx, token, OpCapabilityRotate)
	if err != nil {
		return Grant{}, err
	}
	now := a.now().UTC()
	remaining := verified.ExpiresAt.Sub(now)
	if remaining <= 0 {
		return Grant{}, ErrExpired
	}
	successor, err := a.Issue(ctx, verified.Scope, remaining)
	if err != nil {
		return Grant{}, err
	}
	if err := a.store.Revoke(ctx, verified.ID, now, successor.ID); err != nil {
		return Grant{}, fmt.Errorf("revoke rotated capability: %w", err)
	}
	return successor, nil
}

// Revoke retires one capability presented as a token. It is idempotent:
// revoking an already-revoked or already-expired grant succeeds, because
// cascade delete retries must converge rather than fail.
func (a *Authority) Revoke(ctx context.Context, token string) error {
	id, _, err := parseToken(token)
	if err != nil {
		return err
	}
	if err := a.store.Revoke(ctx, id, a.now().UTC(), ""); err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		return err
	}
	return nil
}

// RevokeID retires one capability by its grant id. Cascade delete uses this
// when it holds records rather than bearer tokens.
func (a *Authority) RevokeID(ctx context.Context, id string) error {
	if err := a.store.Revoke(ctx, id, a.now().UTC(), ""); err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil
		}
		return err
	}
	return nil
}

// RevokeScope retires every live grant beneath a selector and reports how many
// it changed. This is the first step of session and workspace cascade delete:
// credentials die before the sandbox does, so a sandbox that survives the
// provider call cannot keep acting.
func (a *Authority) RevokeScope(ctx context.Context, selector Selector) (int, error) {
	if err := selector.Validate(); err != nil {
		return 0, err
	}
	return a.store.RevokeScope(ctx, selector, a.now().UTC())
}

// PurgeExpired drops grant rows that stopped being useful before the retention
// cutoff. It is safe to run on the same schedule as the sandbox reaper.
func (a *Authority) PurgeExpired(ctx context.Context, retain time.Duration) (int, error) {
	if retain < 0 {
		retain = 0
	}
	return a.store.DeleteExpired(ctx, a.now().UTC().Add(-retain))
}
