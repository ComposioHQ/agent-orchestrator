package capability

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func testAuthority(t *testing.T, now *time.Time) (*Authority, *MemoryStore) {
	t.Helper()
	store := NewMemoryStore()
	authority, err := New(store, time.Hour, WithClock(func() time.Time { return *now }), WithMaxTTL(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	return authority, store
}

func workerScope() Scope {
	return Scope{
		OrgID:       "org-1",
		WorkspaceID: "workspace-1",
		SessionID:   "session-1",
		Role:        RoleWorker,
		Operations:  []Operation{OpSandboxHeartbeat, OpSessionActivity},
	}
}

func TestIssueMintsOpaqueTokenAndStoresOnlyAVerifier(t *testing.T) {
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	authority, store := testAuthority(t, &now)

	grant, err := authority.Issue(context.Background(), workerScope(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(grant.Token, tokenPrefix+".") {
		t.Fatalf("token = %q, want %s prefix", grant.Token, tokenPrefix)
	}
	if !grant.ExpiresAt.Equal(now.Add(time.Hour)) {
		t.Fatalf("expiry = %s, want default ttl applied", grant.ExpiresAt)
	}
	record, err := store.ByID(context.Background(), grant.ID)
	if err != nil {
		t.Fatal(err)
	}
	if record.Verifier == "" {
		t.Fatal("verifier not persisted")
	}
	if strings.Contains(grant.Token, record.Verifier) || strings.Contains(record.Verifier, grant.Token) {
		t.Fatal("stored verifier must not contain the bearer secret")
	}
	// The bearer half must be unrecoverable from the row: the only place the
	// secret exists after Issue returns is the caller's Grant.
	_, secret, err := parseToken(grant.Token)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(record.Verifier, secret) {
		t.Fatal("verifier leaks the secret")
	}
}

func TestIssueCapsTTLAtMax(t *testing.T) {
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	authority, _ := testAuthority(t, &now)

	grant, err := authority.Issue(context.Background(), workerScope(), 30*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if !grant.ExpiresAt.Equal(now.Add(24 * time.Hour)) {
		t.Fatalf("expiry = %s, want max ttl", grant.ExpiresAt)
	}
}

func TestVerifyAuthorizesOnlyGrantedOperations(t *testing.T) {
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	authority, _ := testAuthority(t, &now)
	grant, err := authority.Issue(context.Background(), workerScope(), 0)
	if err != nil {
		t.Fatal(err)
	}

	verified, err := authority.Verify(context.Background(), grant.Token, OpSandboxHeartbeat)
	if err != nil {
		t.Fatal(err)
	}
	if verified.Scope.SessionID != "session-1" || verified.ID != grant.ID {
		t.Fatalf("verified = %#v", verified)
	}
	if _, err := authority.Verify(context.Background(), grant.Token, OpSessionSpawn); !errors.Is(err, ErrNotPermitted) {
		t.Fatalf("worker spawn error = %v, want ErrNotPermitted", err)
	}
}

func TestVerifyRejectsMalformedUnknownAndTamperedTokens(t *testing.T) {
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	authority, store := testAuthority(t, &now)
	grant, err := authority.Issue(context.Background(), workerScope(), 0)
	if err != nil {
		t.Fatal(err)
	}
	id, secret, err := parseToken(grant.Token)
	if err != nil {
		t.Fatal(err)
	}

	for name, token := range map[string]string{
		"empty":          "",
		"no prefix":      id + "." + secret,
		"wrong prefix":   "ao_refresh_" + secret,
		"missing secret": tokenPrefix + "." + id,
		"extra segment":  tokenPrefix + "." + id + "." + secret + "." + secret,
		"unknown id":     tokenPrefix + ".AAAAAAAAAAAAAAAAAAAAAA." + secret,
		"wrong secret":   tokenPrefix + "." + id + ".AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	} {
		if _, err := authority.Verify(context.Background(), token, OpSandboxHeartbeat); !errors.Is(err, ErrInvalidToken) {
			t.Fatalf("%s: err = %v, want ErrInvalidToken", name, err)
		}
	}

	// A verifier copied onto a row whose scope was widened must stop matching:
	// the digest binds the scope, not just the secret.
	record, err := store.ByID(context.Background(), grant.ID)
	if err != nil {
		t.Fatal(err)
	}
	record.Scope.Operations = append(record.Scope.Operations, OpSessionSpawn)
	store.records[record.ID] = record
	if _, err := authority.Verify(context.Background(), grant.Token, OpSandboxHeartbeat); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("scope-tampered verify err = %v, want ErrInvalidToken", err)
	}
}

func TestVerifierIsBoundToItsGrantID(t *testing.T) {
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	authority, store := testAuthority(t, &now)
	first, err := authority.Issue(context.Background(), workerScope(), 0)
	if err != nil {
		t.Fatal(err)
	}
	second, err := authority.Issue(context.Background(), workerScope(), 0)
	if err != nil {
		t.Fatal(err)
	}
	firstRecord, err := store.ByID(context.Background(), first.ID)
	if err != nil {
		t.Fatal(err)
	}
	secondRecord, err := store.ByID(context.Background(), second.ID)
	if err != nil {
		t.Fatal(err)
	}
	// Copy the first grant's verifier onto the second row and present the
	// first grant's secret under the second grant's id. Both halves now come
	// from a live grant, so only the id binding can reject it.
	secondRecord.Verifier = firstRecord.Verifier
	store.records[second.ID] = secondRecord
	_, firstSecret, err := parseToken(first.Token)
	if err != nil {
		t.Fatal(err)
	}
	replayed := tokenPrefix + "." + second.ID + "." + firstSecret
	if _, err := authority.Verify(context.Background(), replayed, OpSandboxHeartbeat); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("replayed verifier err = %v, want ErrInvalidToken", err)
	}
}

func TestVerifyRejectsExpiredAndRevokedGrants(t *testing.T) {
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	authority, _ := testAuthority(t, &now)
	expiring, err := authority.Issue(context.Background(), workerScope(), time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	revoked, err := authority.Issue(context.Background(), workerScope(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if err := authority.Revoke(context.Background(), revoked.Token); err != nil {
		t.Fatal(err)
	}
	if _, err := authority.Verify(context.Background(), revoked.Token, OpSandboxHeartbeat); !errors.Is(err, ErrRevoked) {
		t.Fatalf("revoked verify err = %v", err)
	}
	now = now.Add(2 * time.Minute)
	if _, err := authority.Verify(context.Background(), expiring.Token, OpSandboxHeartbeat); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired verify err = %v", err)
	}
}

func TestRevokeIsIdempotentAndKeepsTheFirstInstant(t *testing.T) {
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	authority, store := testAuthority(t, &now)
	grant, err := authority.Issue(context.Background(), workerScope(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := authority.Revoke(context.Background(), grant.Token); err != nil {
		t.Fatal(err)
	}
	first, err := store.ByID(context.Background(), grant.ID)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Minute)
	if err := authority.Revoke(context.Background(), grant.Token); err != nil {
		t.Fatalf("second revoke = %v, want nil", err)
	}
	second, err := store.ByID(context.Background(), grant.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !second.RevokedAt.Equal(first.RevokedAt) {
		t.Fatalf("revoked at moved from %s to %s", first.RevokedAt, second.RevokedAt)
	}
	// Revoking a token for a grant that no longer exists must also converge.
	if _, err := store.DeleteExpired(context.Background(), now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := authority.Revoke(context.Background(), grant.Token); err != nil {
		t.Fatalf("revoke of purged grant = %v, want nil", err)
	}
}

func TestRotatePreservesAbsoluteExpiryAndRetiresPredecessor(t *testing.T) {
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	authority, store := testAuthority(t, &now)
	scope := workerScope()
	scope.Operations = append(scope.Operations, OpCapabilityRotate)
	grant, err := authority.Issue(context.Background(), scope, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(45 * time.Minute)

	successor, err := authority.Rotate(context.Background(), grant.Token)
	if err != nil {
		t.Fatal(err)
	}
	if !successor.ExpiresAt.Equal(grant.ExpiresAt) {
		t.Fatalf("successor expiry = %s, want preserved %s", successor.ExpiresAt, grant.ExpiresAt)
	}
	if successor.Token == grant.Token || successor.ID == grant.ID {
		t.Fatal("rotation must mint a fresh credential")
	}
	if _, err := authority.Verify(context.Background(), grant.Token, OpSandboxHeartbeat); !errors.Is(err, ErrRevoked) {
		t.Fatalf("predecessor verify err = %v, want ErrRevoked", err)
	}
	if _, err := authority.Verify(context.Background(), successor.Token, OpSandboxHeartbeat); err != nil {
		t.Fatalf("successor verify err = %v", err)
	}
	predecessor, err := store.ByID(context.Background(), grant.ID)
	if err != nil {
		t.Fatal(err)
	}
	if predecessor.RotatedToID != successor.ID {
		t.Fatalf("rotated-to = %q, want %q", predecessor.RotatedToID, successor.ID)
	}
}

func TestRotateRequiresTheRotateOperation(t *testing.T) {
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	authority, _ := testAuthority(t, &now)
	grant, err := authority.Issue(context.Background(), workerScope(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := authority.Rotate(context.Background(), grant.Token); !errors.Is(err, ErrNotPermitted) {
		t.Fatalf("rotate err = %v, want ErrNotPermitted", err)
	}
}

func TestRevokeScopeCascadesAndRefusesAnUnscopedSelector(t *testing.T) {
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	authority, _ := testAuthority(t, &now)
	ctx := context.Background()

	mine, err := authority.Issue(ctx, workerScope(), 0)
	if err != nil {
		t.Fatal(err)
	}
	sibling := workerScope()
	sibling.SessionID = "session-2"
	siblingGrant, err := authority.Issue(ctx, sibling, 0)
	if err != nil {
		t.Fatal(err)
	}
	otherOrg := workerScope()
	otherOrg.OrgID = "org-2"
	otherGrant, err := authority.Issue(ctx, otherOrg, 0)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := authority.RevokeScope(ctx, Selector{}); !errors.Is(err, ErrInvalidScope) {
		t.Fatalf("unscoped selector err = %v, want ErrInvalidScope", err)
	}
	if _, err := authority.RevokeScope(ctx, Selector{OrgID: "org-1", SessionID: "session-1"}); !errors.Is(err, ErrInvalidScope) {
		t.Fatalf("session-without-workspace selector err = %v, want ErrInvalidScope", err)
	}

	revoked, err := authority.RevokeScope(ctx, Selector{OrgID: "org-1", WorkspaceID: "workspace-1", SessionID: "session-1"})
	if err != nil {
		t.Fatal(err)
	}
	if revoked != 1 {
		t.Fatalf("session revocation count = %d, want 1", revoked)
	}
	if _, err := authority.Verify(ctx, mine.Token, OpSandboxHeartbeat); !errors.Is(err, ErrRevoked) {
		t.Fatalf("session grant err = %v", err)
	}
	if _, err := authority.Verify(ctx, siblingGrant.Token, OpSandboxHeartbeat); err != nil {
		t.Fatalf("sibling session grant must survive: %v", err)
	}

	revoked, err = authority.RevokeScope(ctx, Selector{OrgID: "org-1", WorkspaceID: "workspace-1"})
	if err != nil {
		t.Fatal(err)
	}
	if revoked != 1 {
		t.Fatalf("workspace revocation count = %d, want 1 (already-revoked grants are not recounted)", revoked)
	}
	if _, err := authority.Verify(ctx, otherGrant.Token, OpSandboxHeartbeat); err != nil {
		t.Fatalf("foreign org grant must survive: %v", err)
	}
}

func TestPurgeExpiredHonorsRetention(t *testing.T) {
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	authority, store := testAuthority(t, &now)
	if _, err := authority.Issue(context.Background(), workerScope(), time.Minute); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Minute)

	purged, err := authority.PurgeExpired(context.Background(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if purged != 0 || store.Len() != 1 {
		t.Fatalf("purged = %d, retained = %d, want the grant kept inside retention", purged, store.Len())
	}
	now = now.Add(2 * time.Hour)
	purged, err = authority.PurgeExpired(context.Background(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if purged != 1 || store.Len() != 0 {
		t.Fatalf("purged = %d, retained = %d, want the grant dropped past retention", purged, store.Len())
	}
}

func TestScopeNormalizationRules(t *testing.T) {
	valid, err := Scope{
		OrgID:       " org-1 ",
		WorkspaceID: "workspace-1",
		SessionID:   "session-1",
		Role:        "Worker",
		Operations:  []Operation{OpSessionActivity, OpSandboxHeartbeat, OpSessionActivity},
	}.Normalize()
	if err != nil {
		t.Fatal(err)
	}
	if valid.OrgID != "org-1" || valid.Role != RoleWorker {
		t.Fatalf("normalized = %#v", valid)
	}
	if len(valid.Operations) != 2 || valid.Operations[0] != OpSandboxHeartbeat || valid.Operations[1] != OpSessionActivity {
		t.Fatalf("operations = %#v, want sorted and deduped", valid.Operations)
	}

	for name, scope := range map[string]Scope{
		"no org":            {WorkspaceID: "w", Role: RoleCoordinator, Operations: []Operation{OpSessionRead}},
		"no workspace":      {OrgID: "o", Role: RoleCoordinator, Operations: []Operation{OpSessionRead}},
		"worker no session": {OrgID: "o", WorkspaceID: "w", Role: RoleWorker, Operations: []Operation{OpSessionRead}},
		"unknown role":      {OrgID: "o", WorkspaceID: "w", Role: "admin", Operations: []Operation{OpSessionRead}},
		"unknown operation": {OrgID: "o", WorkspaceID: "w", Role: RoleCoordinator, Operations: []Operation{"root.shell"}},
		"no operations":     {OrgID: "o", WorkspaceID: "w", Role: RoleCoordinator},
	} {
		if _, err := scope.Normalize(); !errors.Is(err, ErrInvalidScope) {
			t.Fatalf("%s: err = %v, want ErrInvalidScope", name, err)
		}
	}
}

func TestNewRejectsMissingStoreOrLifetime(t *testing.T) {
	if _, err := New(nil, time.Hour); err == nil {
		t.Fatal("nil store accepted")
	}
	if _, err := New(NewMemoryStore(), 0); err == nil {
		t.Fatal("non-positive lifetime accepted")
	}
}

func TestIssueSurfacesEntropyFailure(t *testing.T) {
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	authority, err := New(NewMemoryStore(), time.Hour,
		WithClock(func() time.Time { return now }),
		WithEntropy(bytes.NewReader(nil)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := authority.Issue(context.Background(), workerScope(), 0); err == nil {
		t.Fatal("empty entropy source accepted")
	}
}
