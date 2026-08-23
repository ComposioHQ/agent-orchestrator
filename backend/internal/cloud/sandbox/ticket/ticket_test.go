package ticket

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"
)

const (
	testSession = "sess-42"
	testRuntime = "rt-7"
)

func testKey(t *testing.T, seed byte) Key {
	t.Helper()
	material := bytes.Repeat([]byte{seed}, KeyBytes)
	key, err := NewKey(material)
	if err != nil {
		t.Fatalf("NewKey: %v", err)
	}
	return key
}

// clock is a hand-wound clock so expiry and skew are exercised without sleeping.
type clock struct{ at time.Time }

func (c *clock) now() time.Time { return c.at }

func fixture(t *testing.T) (*Issuer, *Verifier, *clock, *MemoryReplayGuard) {
	t.Helper()
	key := testKey(t, 0xA1)
	c := &clock{at: time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)}
	issuer, err := NewIssuer(key, c.now, nil)
	if err != nil {
		t.Fatalf("NewIssuer: %v", err)
	}
	guard := NewMemoryReplayGuard(c.now)
	binding := Binding{SessionID: testSession, RuntimeID: testRuntime}
	verifier, err := NewVerifier(key, AudienceMux, binding, guard, c.now)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	return issuer, verifier, c, guard
}

func mustIssue(t *testing.T, issuer *Issuer, ttl time.Duration) string {
	t.Helper()
	token, _, err := issuer.Issue(AudienceMux, Binding{SessionID: testSession, RuntimeID: testRuntime}, ttl)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	return token
}

func TestIssuedTicketVerifiesOnce(t *testing.T) {
	issuer, verifier, _, _ := fixture(t)
	token := mustIssue(t, issuer, DefaultTTL)

	ticket, err := verifier.Verify(token)
	if err != nil {
		t.Fatalf("first Verify: %v", err)
	}
	if ticket.Binding.SessionID != testSession || ticket.Binding.RuntimeID != testRuntime {
		t.Fatalf("binding = %+v, want session %q runtime %q", ticket.Binding, testSession, testRuntime)
	}
	if ticket.Audience != AudienceMux {
		t.Fatalf("audience = %q, want %q", ticket.Audience, AudienceMux)
	}
	if ticket.ID == "" {
		t.Fatal("ticket id is empty; support correlation needs it")
	}
}

func TestReplayIsRejected(t *testing.T) {
	issuer, verifier, _, _ := fixture(t)
	token := mustIssue(t, issuer, DefaultTTL)

	if _, err := verifier.Verify(token); err != nil {
		t.Fatalf("first Verify: %v", err)
	}
	if _, err := verifier.Verify(token); !errors.Is(err, ErrReplayed) {
		t.Fatalf("second Verify err = %v, want ErrReplayed", err)
	}
}

// Two tickets minted back to back must be independently spendable: the guard
// keys off the ticket id, not off the binding, or opening a second pane would
// fail.
func TestDistinctTicketsAreIndependent(t *testing.T) {
	issuer, verifier, _, _ := fixture(t)
	first := mustIssue(t, issuer, DefaultTTL)
	second := mustIssue(t, issuer, DefaultTTL)
	if first == second {
		t.Fatal("issuer minted the same ticket twice")
	}
	if _, err := verifier.Verify(first); err != nil {
		t.Fatalf("verify first: %v", err)
	}
	if _, err := verifier.Verify(second); err != nil {
		t.Fatalf("verify second: %v", err)
	}
}

func TestExpiryIsEnforced(t *testing.T) {
	issuer, verifier, c, _ := fixture(t)
	token := mustIssue(t, issuer, 30*time.Second)

	c.at = c.at.Add(30 * time.Second)
	if _, err := verifier.Verify(token); !errors.Is(err, ErrExpired) {
		t.Fatalf("Verify at exact expiry = %v, want ErrExpired", err)
	}
}

// An expired ticket must not be spent. Otherwise a stale token could burn the
// guard slot of a legitimate one that happened to share an id.
func TestExpiredTicketIsNotConsumed(t *testing.T) {
	issuer, verifier, c, guard := fixture(t)
	token := mustIssue(t, issuer, 30*time.Second)
	c.at = c.at.Add(time.Minute)
	if _, err := verifier.Verify(token); !errors.Is(err, ErrExpired) {
		t.Fatalf("Verify = %v, want ErrExpired", err)
	}
	if guard.Len() != 0 {
		t.Fatalf("replay guard remembered %d expired tickets, want 0", guard.Len())
	}
}

// The verifier refuses an over-long lifetime even though the MAC is genuine.
// This is the check that survives a buggy or compromised issuer.
func TestOverLongLifetimeIsRefusedEvenWhenSigned(t *testing.T) {
	issuer, verifier, _, _ := fixture(t)
	token := forge(t, issuer, func(c *claims) { c.ExpiresAt = c.IssuedAt + int64((MaxTTL + time.Second).Seconds()) })
	if _, err := verifier.Verify(token); !errors.Is(err, ErrExpired) {
		t.Fatalf("Verify = %v, want ErrExpired for a lifetime beyond MaxTTL", err)
	}
}

// Issue clamps rather than rejecting, so a caller's over-long ttl cannot become
// a ticket the sandbox refuses.
func TestIssueClampsLifetimeToMaxTTL(t *testing.T) {
	issuer, verifier, _, _ := fixture(t)
	token := mustIssue(t, issuer, time.Hour)
	ticket, err := verifier.Verify(token)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if got := ticket.ExpiresAt.Sub(ticket.IssuedAt); got != MaxTTL {
		t.Fatalf("clamped lifetime = %s, want %s", got, MaxTTL)
	}
}

func TestPreDatedTicketIsRefused(t *testing.T) {
	issuer, verifier, _, _ := fixture(t)
	token := forge(t, issuer, func(c *claims) {
		skew := int64((DefaultClockSkew + time.Minute).Seconds())
		c.IssuedAt += skew
		c.ExpiresAt += skew
	})
	if _, err := verifier.Verify(token); !errors.Is(err, ErrExpired) {
		t.Fatalf("Verify = %v, want ErrExpired for a pre-dated ticket", err)
	}
}

func TestTicketFromAnotherSandboxIsRefused(t *testing.T) {
	issuer, _, c, _ := fixture(t)
	token := mustIssue(t, issuer, DefaultTTL)

	// Same key material, different placement: this is the check that keeps a
	// ticket from opening the wrong session's terminal.
	other, err := NewVerifier(testKey(t, 0xA1), AudienceMux, Binding{SessionID: "sess-99"}, NewMemoryReplayGuard(c.now), c.now)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	if _, err := other.Verify(token); !errors.Is(err, ErrBinding) {
		t.Fatalf("Verify = %v, want ErrBinding", err)
	}
}

// A sandbox replaced under the same session id must not be reachable with the
// previous placement's ticket.
func TestTicketFromAPreviousRuntimeIsRefused(t *testing.T) {
	issuer, _, c, _ := fixture(t)
	token := mustIssue(t, issuer, DefaultTTL)
	successor, err := NewVerifier(testKey(t, 0xA1), AudienceMux,
		Binding{SessionID: testSession, RuntimeID: "rt-8"}, NewMemoryReplayGuard(c.now), c.now)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	if _, err := successor.Verify(token); !errors.Is(err, ErrBinding) {
		t.Fatalf("Verify = %v, want ErrBinding", err)
	}
}

func TestForeignKeyIsRefused(t *testing.T) {
	issuer, _, c, _ := fixture(t)
	token := mustIssue(t, issuer, DefaultTTL)
	foreign, err := NewVerifier(testKey(t, 0xB2), AudienceMux,
		Binding{SessionID: testSession, RuntimeID: testRuntime}, NewMemoryReplayGuard(c.now), c.now)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	if _, err := foreign.Verify(token); !errors.Is(err, ErrSignature) {
		t.Fatalf("Verify = %v, want ErrSignature", err)
	}
}

func TestAudienceMismatchIsRefused(t *testing.T) {
	issuer, verifier, _, _ := fixture(t)
	token, _, err := issuer.Issue("ao.sandbox.other.v1", Binding{SessionID: testSession, RuntimeID: testRuntime}, DefaultTTL)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	if _, err := verifier.Verify(token); !errors.Is(err, ErrAudience) {
		t.Fatalf("Verify = %v, want ErrAudience", err)
	}
}

// Claim tampering must fail on the MAC, never slip through because the verifier
// happened to re-serialize the payload before checking it.
func TestTamperedClaimsFailTheSignature(t *testing.T) {
	issuer, verifier, _, _ := fixture(t)
	token := mustIssue(t, issuer, DefaultTTL)
	parts := strings.Split(token, ".")
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	var set claims
	if err := json.Unmarshal(payload, &set); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	set.SessionID = "sess-99"
	rewritten, err := json.Marshal(set)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	tampered := parts[0] + "." + base64.RawURLEncoding.EncodeToString(rewritten) + "." + parts[2]
	if _, err := verifier.Verify(tampered); !errors.Is(err, ErrSignature) {
		t.Fatalf("Verify = %v, want ErrSignature", err)
	}
}

func TestMalformedTicketsAreRejectedBeforeAnyLookup(t *testing.T) {
	_, verifier, _, guard := fixture(t)
	for _, presented := range []string{
		"",
		"not-a-ticket",
		"aocap_v1.abc.def",               // a capability presented to the wrong verifier
		Prefix + ".abc",                  // too few parts
		Prefix + ".abc.def.ghi",          // too many parts
		Prefix + "..def",                 // empty payload
		Prefix + ".abc.",                 // empty MAC
		strings.ToUpper(Prefix) + ".a.b", // prefix is case-sensitive
	} {
		if _, err := verifier.Verify(presented); err == nil {
			t.Fatalf("Verify(%q) succeeded, want rejection", presented)
		}
	}
	if guard.Len() != 0 {
		t.Fatalf("replay guard recorded %d entries for malformed input, want 0", guard.Len())
	}
}

// A forged ticket must not be able to burn a legitimate ticket's replay slot.
func TestUnsignedTicketDoesNotSpendItsID(t *testing.T) {
	issuer, verifier, _, guard := fixture(t)
	token := mustIssue(t, issuer, DefaultTTL)
	parts := strings.Split(token, ".")
	// Same payload (so the same jti), wrong MAC.
	if _, err := verifier.Verify(parts[0] + "." + parts[1] + ".AAAA"); !errors.Is(err, ErrSignature) {
		t.Fatalf("Verify = %v, want ErrSignature", err)
	}
	if guard.Len() != 0 {
		t.Fatalf("replay guard recorded %d entries for a bad MAC, want 0", guard.Len())
	}
	if _, err := verifier.Verify(token); err != nil {
		t.Fatalf("legitimate Verify after a forgery attempt: %v", err)
	}
}

func TestIssueRequiresASession(t *testing.T) {
	issuer, _, _, _ := fixture(t)
	if _, _, err := issuer.Issue(AudienceMux, Binding{}, DefaultTTL); !errors.Is(err, ErrBinding) {
		t.Fatalf("Issue without a session = %v, want ErrBinding", err)
	}
}

func TestVerifierRequiresAReplayGuard(t *testing.T) {
	if _, err := NewVerifier(testKey(t, 1), AudienceMux, Binding{SessionID: testSession}, nil, nil); err == nil {
		t.Fatal("NewVerifier accepted a nil replay guard; single-use would silently stop holding")
	}
}

func TestShortKeyIsRefused(t *testing.T) {
	if _, err := NewKey(bytes.Repeat([]byte{1}, KeyBytes-1)); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("NewKey(short) = %v, want ErrInvalidKey", err)
	}
	if _, err := NewIssuer(Key{}, nil, nil); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("NewIssuer(zero key) = %v, want ErrInvalidKey", err)
	}
}

func TestKeyRoundTripsThroughTheBootstrapEncoding(t *testing.T) {
	key, err := GenerateKey(nil)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	parsed, err := ParseKey(key.Encode())
	if err != nil {
		t.Fatalf("ParseKey: %v", err)
	}
	issuer, err := NewIssuer(key, nil, nil)
	if err != nil {
		t.Fatalf("NewIssuer: %v", err)
	}
	token, _, err := issuer.Issue(AudienceMux, Binding{SessionID: testSession}, DefaultTTL)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	verifier, err := NewVerifier(parsed, AudienceMux, Binding{SessionID: testSession}, NewMemoryReplayGuard(nil), nil)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	if _, err := verifier.Verify(token); err != nil {
		t.Fatalf("Verify across the encoded key: %v", err)
	}
}

// The key type redacts itself under every rendering path a debugging session is
// likely to reach for.
func TestKeyNeverRendersItsMaterial(t *testing.T) {
	key := testKey(t, 0xC3)
	material := key.Encode()

	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, nil))
	logger.Info("boot", "key", key)
	holder := struct {
		Name string
		Key  Key
	}{Name: "listener", Key: key}
	logger.Info("boot", "holder", fmt.Sprintf("%+v", holder))

	rendered := []string{
		buf.String(),
		key.String(),
		fmt.Sprintf("%v", key),
		fmt.Sprintf("%+v", key),
		fmt.Sprintf("%s", key),
		fmt.Sprintf("%+v", holder),
	}
	for _, line := range rendered {
		if strings.Contains(line, material) {
			t.Fatalf("key material leaked into %q", line)
		}
	}
}

func TestReplayGuardForgetsExpiredEntries(t *testing.T) {
	c := &clock{at: time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)}
	guard := NewMemoryReplayGuard(c.now)
	for i := 0; i < 100; i++ {
		if err := guard.Consume(fmt.Sprintf("t-%d", i), c.at.Add(time.Second)); err != nil {
			t.Fatalf("Consume: %v", err)
		}
	}
	if guard.Len() != 100 {
		t.Fatalf("guard holds %d, want 100", guard.Len())
	}
	// Entries are held for at least one full ticket lifetime past the sweep, so
	// nothing is forgotten while it could still be replayed.
	c.at = c.at.Add(pruneInterval + time.Second)
	if err := guard.Consume("later", c.at.Add(time.Minute)); err != nil {
		t.Fatalf("Consume: %v", err)
	}
	if guard.Len() != 101 {
		t.Fatalf("guard forgot entries that are still replayable: holds %d, want 101", guard.Len())
	}
	c.at = c.at.Add(2 * MaxTTL)
	if err := guard.Consume("last", c.at.Add(time.Minute)); err != nil {
		t.Fatalf("Consume: %v", err)
	}
	if guard.Len() != 1 {
		t.Fatalf("guard holds %d after everything expired, want 1", guard.Len())
	}
}

func TestSubprotocolRoundTrip(t *testing.T) {
	presented, speaksMux := FromSubprotocols(Subprotocols("aotkt_v1.a.b"))
	if !speaksMux {
		t.Fatal("client offer did not advertise the mux subprotocol")
	}
	if presented != "aotkt_v1.a.b" {
		t.Fatalf("extracted ticket = %q", presented)
	}

	if _, speaks := FromSubprotocols([]string{TicketSubprotocolPrefix + "x"}); speaks {
		t.Fatal("a ticket-only offer must not count as speaking the mux protocol")
	}
	// Only the first ticket entry is honoured, so header ordering cannot decide
	// which ticket gets spent.
	first, _ := FromSubprotocols([]string{Subprotocol, TicketSubprotocolPrefix + "one", TicketSubprotocolPrefix + "two"})
	if first != "one" {
		t.Fatalf("extracted ticket = %q, want the first offered", first)
	}
}

// forge re-signs deliberately malformed claims with the issuer's real key: it
// models a buggy or compromised control plane, which is the threat the
// verifier's independent claim checks exist for.
func forge(t *testing.T, issuer *Issuer, mutate func(*claims)) string {
	t.Helper()
	token, _, err := issuer.Issue(AudienceMux, Binding{SessionID: testSession, RuntimeID: testRuntime}, DefaultTTL)
	if err != nil {
		t.Fatalf("Issue: %v", err)
	}
	parts := strings.Split(token, ".")
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatalf("decode payload: %v", err)
	}
	var set claims
	if err := json.Unmarshal(payload, &set); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	mutate(&set)
	rewritten, err := json.Marshal(set)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	encoded := base64.RawURLEncoding.EncodeToString(rewritten)
	return Prefix + "." + encoded + "." + sign(issuer.key, encoded)
}
