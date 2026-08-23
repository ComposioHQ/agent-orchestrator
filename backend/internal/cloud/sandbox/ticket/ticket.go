package ticket

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
)

// Prefix marks an AO sandbox connection ticket. It is distinct from the
// capability prefix (aocap_v1) on purpose: the two credentials authorize
// different planes, and a value presented to the wrong verifier must fail on
// its shape rather than on a lucky mismatch deeper in.
const Prefix = "aotkt_v1"

// AudienceMux is the audience claim carried by a ticket minted for a sandbox's
// published terminal multiplexer. A ticket is refused by any verifier whose
// audience differs, so a future second listener inside the sandbox cannot be
// reached with a mux ticket.
const AudienceMux = "ao.sandbox.mux.v1"

// Subprotocol is the WebSocket subprotocol a mux client offers alongside its
// ticket, and the one the sandbox listener selects in the handshake.
//
// The ticket rides in Sec-WebSocket-Protocol rather than a query parameter
// because a query parameter is written to every access log, proxy log, and
// browser history entry between the client and the sandbox. Browsers cannot set
// arbitrary headers on a WebSocket handshake, so the subprotocol list is the
// only client-settable place a credential can go; this is the standard
// workaround and it is what the control plane publishes in terminal metadata.
const Subprotocol = "ao.mux.v1"

// TicketSubprotocolPrefix is the subprotocol entry that carries the ticket
// itself: "ao.ticket.<ticket>".
const TicketSubprotocolPrefix = "ao.ticket."

// MaxTTL is the longest lifetime a verifier will honour regardless of what the
// issuer claimed. A ticket is made for one imminent connection; anything longer
// is a bug in the issuer or a forgery attempt against a compromised clock, and
// either way the sandbox refuses rather than trusting the control plane's
// arithmetic.
const MaxTTL = 5 * time.Minute

// DefaultTTL is the lifetime the control plane should normally ask for: long
// enough to survive a slow dial and a redirect, short enough that a leaked
// ticket is stale before it can be pasted anywhere.
const DefaultTTL = 60 * time.Second

// Errors a verifier returns. Callers map every one of them to a single opaque
// rejection on the wire: distinguishing "expired" from "forged" for an
// unauthenticated caller tells an attacker which half of the credential they
// got right.
var (
	// ErrMalformed means the presented string is not shaped like a ticket.
	ErrMalformed = errors.New("malformed sandbox ticket")
	// ErrSignature means the MAC did not verify under this sandbox's key.
	ErrSignature = errors.New("sandbox ticket signature does not verify")
	// ErrExpired means the ticket's expiry has passed, or its claimed lifetime
	// exceeds MaxTTL, or it is dated too far in the future to be believed.
	ErrExpired = errors.New("sandbox ticket expired")
	// ErrAudience means the ticket was minted for a different listener.
	ErrAudience = errors.New("sandbox ticket audience mismatch")
	// ErrBinding means the ticket names a different session or runtime than
	// this sandbox.
	ErrBinding = errors.New("sandbox ticket is bound to a different sandbox")
	// ErrReplayed means the ticket verified but has already been used.
	ErrReplayed = errors.New("sandbox ticket already used")
)

// Binding is the placement a ticket authorizes. SessionID is required: a
// ticket that named no session would be usable against any sandbox holding the
// same key, which defeats the point of a per-sandbox key.
type Binding struct {
	SessionID string
	// RuntimeID is the control-plane placement row id. It is optional in the
	// ticket but, when the verifier is configured with one, a ticket that omits
	// it or disagrees is refused — so a ticket minted for a sandbox that has
	// since been replaced under the same session id does not open the new one.
	RuntimeID string
}

// claims is the ticket payload. Field names are short because the encoded
// payload travels in a WebSocket subprotocol header, which some proxies bound
// tightly.
type claims struct {
	ID        string `json:"jti"`
	Audience  string `json:"aud"`
	SessionID string `json:"sid"`
	RuntimeID string `json:"rid,omitempty"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

// Ticket is a verified ticket's contents, returned by Verify so a caller can
// log the ticket id (which is not secret) for support correlation.
type Ticket struct {
	ID        string
	Audience  string
	Binding   Binding
	IssuedAt  time.Time
	ExpiresAt time.Time
}

// Issuer mints tickets for one sandbox. The control plane holds one per live
// sandbox, keyed by the same material it delivered to that sandbox at launch.
type Issuer struct {
	key     Key
	now     func() time.Time
	entropy io.Reader
}

// NewIssuer builds an issuer over a sandbox's key. now and entropy may be nil.
func NewIssuer(key Key, now func() time.Time, entropy io.Reader) (*Issuer, error) {
	if !key.Valid() {
		return nil, ErrInvalidKey
	}
	if now == nil {
		now = time.Now
	}
	if entropy == nil {
		entropy = rand.Reader
	}
	return &Issuer{key: key, now: now, entropy: entropy}, nil
}

// Issue mints a single-use ticket for one connection. A zero or over-long ttl
// is clamped rather than rejected: the caller's mistake must not become a
// ticket the sandbox will refuse, which would surface as an unexplained
// terminal failure instead of a clamped lifetime.
func (i *Issuer) Issue(audience string, binding Binding, ttl time.Duration) (string, Ticket, error) {
	audience = strings.TrimSpace(audience)
	if audience == "" {
		return "", Ticket{}, fmt.Errorf("%w: audience is required", ErrAudience)
	}
	binding = binding.normalize()
	if binding.SessionID == "" {
		return "", Ticket{}, fmt.Errorf("%w: a ticket must name its session", ErrBinding)
	}
	if ttl <= 0 {
		ttl = DefaultTTL
	}
	if ttl > MaxTTL {
		ttl = MaxTTL
	}
	raw := make([]byte, 16)
	if _, err := io.ReadFull(i.entropy, raw); err != nil {
		return "", Ticket{}, fmt.Errorf("generate sandbox ticket id: %w", err)
	}
	issuedAt := i.now().UTC().Truncate(time.Second)
	set := claims{
		ID:        base64.RawURLEncoding.EncodeToString(raw),
		Audience:  audience,
		SessionID: binding.SessionID,
		RuntimeID: binding.RuntimeID,
		IssuedAt:  issuedAt.Unix(),
		ExpiresAt: issuedAt.Add(ttl).Unix(),
	}
	payload, err := json.Marshal(set)
	if err != nil {
		return "", Ticket{}, fmt.Errorf("encode sandbox ticket: %w", err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	token := Prefix + "." + encoded + "." + sign(i.key, encoded)
	return token, set.ticket(), nil
}

// ReplayGuard records which ticket ids have been spent. Verify consults it only
// AFTER the MAC verifies, so unauthenticated traffic can neither fill it nor
// learn anything from it.
type ReplayGuard interface {
	// Consume records a ticket id as spent and returns ErrReplayed if it was
	// already spent. expiresAt lets an implementation forget the entry once the
	// ticket could no longer be accepted anyway.
	Consume(id string, expiresAt time.Time) error
}

// Verifier checks tickets inside one sandbox.
type Verifier struct {
	key      Key
	audience string
	binding  Binding
	guard    ReplayGuard
	now      func() time.Time
	// clockSkew tolerates an issuer clock that runs ahead of the sandbox's.
	// It applies ONLY to the issued-at check. Expiry is deliberately strict:
	// widening the expiry window is the one direction that makes a captured
	// ticket live longer, which is the property the whole design is buying.
	clockSkew time.Duration
}

// DefaultClockSkew is the issued-at tolerance. Sandboxes and the control plane
// both run NTP-synced hosts; a minute absorbs ordinary drift without letting a
// ticket be pre-dated into a meaningfully longer life.
const DefaultClockSkew = time.Minute

// NewVerifier builds the sandbox-side verifier. guard is required: a verifier
// without one would silently stop being single-use, which is exactly the kind
// of security property that decays into a comment. now may be nil.
func NewVerifier(key Key, audience string, binding Binding, guard ReplayGuard, now func() time.Time) (*Verifier, error) {
	if !key.Valid() {
		return nil, ErrInvalidKey
	}
	audience = strings.TrimSpace(audience)
	if audience == "" {
		return nil, fmt.Errorf("%w: audience is required", ErrAudience)
	}
	binding = binding.normalize()
	if binding.SessionID == "" {
		return nil, fmt.Errorf("%w: a verifier must know its own session", ErrBinding)
	}
	if guard == nil {
		return nil, errors.New("sandbox ticket verifier requires a replay guard")
	}
	if now == nil {
		now = time.Now
	}
	return &Verifier{key: key, audience: audience, binding: binding, guard: guard, now: now, clockSkew: DefaultClockSkew}, nil
}

// Verify authenticates one presented ticket and spends it.
//
// The ordering below is load-bearing and is asserted by tests, not just
// intended: signature first, then the cheap claim checks, then the replay
// guard last. Consuming before the MAC verified would let an attacker who
// merely observed a ticket id burn a legitimate user's ticket.
func (v *Verifier) Verify(presented string) (Ticket, error) {
	encoded, mac, err := split(presented)
	if err != nil {
		return Ticket{}, err
	}
	if !hmac.Equal([]byte(mac), []byte(sign(v.key, encoded))) {
		return Ticket{}, ErrSignature
	}
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return Ticket{}, ErrMalformed
	}
	var set claims
	if err := json.Unmarshal(payload, &set); err != nil {
		return Ticket{}, ErrMalformed
	}
	if set.ID == "" || set.SessionID == "" || set.IssuedAt == 0 || set.ExpiresAt == 0 {
		return Ticket{}, ErrMalformed
	}
	if set.Audience != v.audience {
		return Ticket{}, ErrAudience
	}
	if set.SessionID != v.binding.SessionID {
		return Ticket{}, ErrBinding
	}
	if v.binding.RuntimeID != "" && set.RuntimeID != v.binding.RuntimeID {
		return Ticket{}, ErrBinding
	}
	ticket := set.ticket()
	now := v.now().UTC()
	if !ticket.ExpiresAt.After(now) {
		return Ticket{}, ErrExpired
	}
	if ticket.IssuedAt.After(now.Add(v.clockSkew)) {
		return Ticket{}, ErrExpired
	}
	if ticket.ExpiresAt.Sub(ticket.IssuedAt) > MaxTTL {
		return Ticket{}, ErrExpired
	}
	if err := v.guard.Consume(ticket.ID, ticket.ExpiresAt); err != nil {
		return Ticket{}, err
	}
	return ticket, nil
}

func (b Binding) normalize() Binding {
	return Binding{
		SessionID: strings.TrimSpace(b.SessionID),
		RuntimeID: strings.TrimSpace(b.RuntimeID),
	}
}

func (c claims) ticket() Ticket {
	return Ticket{
		ID:        c.ID,
		Audience:  c.Audience,
		Binding:   Binding{SessionID: c.SessionID, RuntimeID: c.RuntimeID},
		IssuedAt:  time.Unix(c.IssuedAt, 0).UTC(),
		ExpiresAt: time.Unix(c.ExpiresAt, 0).UTC(),
	}
}

// split parses the three-part token without touching a key or a store, so a
// value that is not a ticket at all never reaches the MAC computation.
func split(presented string) (encoded, mac string, err error) {
	parts := strings.Split(strings.TrimSpace(presented), ".")
	if len(parts) != 3 || parts[0] != Prefix || parts[1] == "" || parts[2] == "" {
		return "", "", ErrMalformed
	}
	return parts[1], parts[2], nil
}

// sign is HMAC-SHA256 over the ENCODED payload, not over re-serialized claims.
// Signing the bytes the verifier actually parsed removes any question of
// canonical JSON: there is exactly one byte string under the MAC and it is the
// one that travelled.
func sign(key Key, encoded string) string {
	mac := hmac.New(sha256.New, key.material)
	_, _ = mac.Write([]byte("ao-sandbox-ticket-v1"))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(encoded))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
