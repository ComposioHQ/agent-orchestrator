package worker

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func testClaims() Claims {
	return Claims{
		OrgID:     "org-1",
		SessionID: "session-1",
		WorkerID:  "session-1:7",
		Epoch:     7,
		Scopes:    []string{"worker:connect", "worker:event"},
	}
}

func TestIssueAndVerifyRoundTrip(t *testing.T) {
	manager := NewTokenManager([]byte("0123456789abcdef0123456789abcdef"))
	token, err := manager.Issue(testClaims(), time.Minute)
	if err != nil {
		t.Fatalf("Issue() error = %v", err)
	}
	if !strings.HasPrefix(token, "aow1.") {
		t.Fatalf("token = %q, want the aow1 prefix", token)
	}
	claims, err := manager.Verify(token)
	if err != nil {
		t.Fatalf("Verify() error = %v", err)
	}
	if claims.OrgID != "org-1" || claims.SessionID != "session-1" || claims.Epoch != 7 {
		t.Errorf("claims = %+v, want the issued identity", claims)
	}
	if !HasScope(claims, "worker:event") || HasScope(claims, "worker:terminal") {
		t.Errorf("scopes = %v, did not round-trip", claims.Scopes)
	}
}

func TestIssueRejectsIncompleteClaims(t *testing.T) {
	manager := NewTokenManager([]byte("key"))
	claims := testClaims()
	claims.Epoch = 0
	if _, err := manager.Issue(claims, time.Minute); err == nil {
		t.Fatal("Issue() with epoch 0 succeeded, want an error")
	}
}

func TestVerifyRejectsExpiredToken(t *testing.T) {
	manager := NewTokenManager([]byte("key"))
	token, err := manager.Issue(testClaims(), time.Minute)
	if err != nil {
		t.Fatalf("Issue() error = %v", err)
	}
	manager.now = func() time.Time { return time.Now().Add(2 * time.Minute) }
	if _, err := manager.Verify(token); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("Verify() error = %v, want ErrInvalidToken", err)
	}
}

func TestVerifyRejectsTamperedPayload(t *testing.T) {
	manager := NewTokenManager([]byte("key"))
	token, err := manager.Issue(testClaims(), time.Minute)
	if err != nil {
		t.Fatalf("Issue() error = %v", err)
	}
	parts := strings.Split(token, ".")
	forged := parts[0] + "." + parts[1][:len(parts[1])-1] + "A." + parts[2]
	if _, err := manager.Verify(forged); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("Verify() error = %v, want ErrInvalidToken", err)
	}
}

func TestVerifyRejectsForeignSigningKey(t *testing.T) {
	issuer := NewTokenManager([]byte("key-one"))
	token, err := issuer.Issue(testClaims(), time.Minute)
	if err != nil {
		t.Fatalf("Issue() error = %v", err)
	}
	other := NewTokenManager([]byte("key-two"))
	if _, err := other.Verify(token); !errors.Is(err, ErrInvalidToken) {
		t.Fatalf("Verify() error = %v, want ErrInvalidToken", err)
	}
}

func TestVerifyRejectsMalformedToken(t *testing.T) {
	manager := NewTokenManager([]byte("key"))
	for _, token := range []string{"", "nope", "aow1.only-two", "aow2.a.b"} {
		if _, err := manager.Verify(token); !errors.Is(err, ErrInvalidToken) {
			t.Errorf("Verify(%q) error = %v, want ErrInvalidToken", token, err)
		}
	}
}

func TestNextWorkerID(t *testing.T) {
	if got := NextWorkerID("session-1", 3); got != "session-1:3" {
		t.Errorf("NextWorkerID() = %q, want session-1:3", got)
	}
}
