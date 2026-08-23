package sandboxruntime

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCapabilityFileRequires0600(t *testing.T) {
	path := filepath.Join(t.TempDir(), "capability.json")
	raw := []byte(`{"sandboxId":"s","workspaceId":"w","sessionId":"x","controlPlaneRedeemUrl":"https://control.example/redeem"}`)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadCapabilityFile(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadCapabilityFile(path); err == nil {
		t.Fatal("world-readable capability file was accepted")
	}
}

func TestControlPlaneRedeemerRequiresVerifiedTLSURL(t *testing.T) {
	for _, endpoint := range []string{"http://control.example/redeem", "https://token@control.example/redeem", "not a URL"} {
		if _, err := NewControlPlaneRedeemer(endpoint, testTarget()); err == nil {
			t.Fatalf("accepted redemption URL %q", endpoint)
		}
	}
}
