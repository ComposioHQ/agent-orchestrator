package credentials

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"testing"
)

func TestProviderWireValueIsExactlyClaudeCode(t *testing.T) {
	if ProviderClaudeCode != "claude-code" {
		t.Fatalf("provider = %q", ProviderClaudeCode)
	}
	for _, rejected := range []string{"claude", "Claude", "claude_code", " claude-code", "claude-code "} {
		if _, err := ParseProvider(rejected); err == nil {
			t.Fatalf("accepted noncanonical provider %q", rejected)
		}
	}
	if got, err := ParseProvider("claude-code"); err != nil || got != ProviderClaudeCode {
		t.Fatalf("canonical provider = %q, %v", got, err)
	}
}

func TestDeliveryLookupRequiresWorkerLoadOperationAndBounds(t *testing.T) {
	verified := testVerifiedCapability()
	lookup, err := NewDeliveryLookup(verified, ProviderClaudeCode, "request-1")
	if err != nil || !lookup.valid() {
		t.Fatalf("valid lookup: %#v, %v", lookup, err)
	}
	for name, mutate := range map[string]func(*VerifiedCapability){
		"forged operation":  func(value *VerifiedCapability) { value.Scope.Operations = []Operation{"session.write"} },
		"coordinator":       func(value *VerifiedCapability) { value.Scope.Role = "coordinator" },
		"missing org":       func(value *VerifiedCapability) { value.Scope.OrgID = "" },
		"missing user":      func(value *VerifiedCapability) { value.Scope.UserID = "" },
		"missing workspace": func(value *VerifiedCapability) { value.Scope.WorkspaceID = "" },
		"missing session":   func(value *VerifiedCapability) { value.Scope.SessionID = "" },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := testVerifiedCapability()
			mutate(&candidate)
			if _, err := NewDeliveryLookup(candidate, ProviderClaudeCode, "request-1"); err == nil {
				t.Fatal("forged scope accepted")
			}
		})
	}
	if _, err := NewDeliveryLookup(verified, ProviderClaudeCode, strings.Repeat("x", MaxIdempotencyKeyBytes+1)); err == nil {
		t.Fatal("oversized idempotency key accepted")
	}
}

func TestEncryptedAndTransientValuesAreRedacted(t *testing.T) {
	material := EncryptedMaterial{Ciphertext: []byte("ciphertext-marker"), EncryptedDataKey: []byte("key-marker")}
	if got := fmt.Sprint(material); got != "<redacted credential material>" {
		t.Fatalf("String = %q", got)
	}
	encoded, err := json.Marshal(material)
	if err != nil || string(encoded) != `{"redacted":true}` {
		t.Fatalf("JSON = %s, %v", encoded, err)
	}
	if got := material.LogValue(); got.Kind() != slog.KindString || got.String() != "<redacted credential material>" {
		t.Fatalf("LogValue = %v", got)
	}
	file := SecretFile{Path: "marker-path", Content: []byte("plaintext-marker")}
	if got := fmt.Sprint(file); got != "<redacted secret file>" {
		t.Fatalf("secret file String = %q", got)
	}
}

func testVerifiedCapability() VerifiedCapability {
	return VerifiedCapability{GrantID: "grant-1", Scope: CapabilityScope{
		OrgID: "org-1", UserID: "user-1", WorkspaceID: "workspace-1", SessionID: "session-1",
		Role: RoleWorker, Operations: []Operation{OperationCredentialLoad},
	}}
}
