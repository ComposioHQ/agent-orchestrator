package credentials

import (
	"bytes"
	"testing"
)

func TestClaudeCodeProviderValidatesAndMaterializesVerbatim0600(t *testing.T) {
	provider := ClaudeCodeProvider{}
	secret := claudeSecret("provider-secret")
	credentialType, err := provider.Inspect(secret)
	if err != nil || credentialType != TypeOAuthToken {
		t.Fatalf("inspection = %q, %v", credentialType, err)
	}
	files, err := provider.Materialize(secret)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0].Path != ".claude/.credentials.json" || files[0].Mode != 0o600 || !bytes.Equal(files[0].Content, secret) {
		t.Fatalf("files = %#v", files)
	}
	files[0].Erase()
	if !allZero(files[0].Content) {
		t.Fatal("file secret could not be erased")
	}
	for _, malformed := range [][]byte{nil, []byte(`{"accessToken":"leak"}`), []byte(`not-json-provider-secret`)} {
		_, err := provider.Inspect(malformed)
		if err == nil || (len(malformed) > 0 && bytes.Contains([]byte(err.Error()), malformed)) {
			t.Fatalf("malformed credential error was absent or reflected input: %v", err)
		}
	}
}

type secondProvider struct{ ClaudeCodeProvider }

func (secondProvider) Harness() Harness { return "codex" }

func TestHarnessCredentialProviderRegistryIsExtensibleAndRejectsDuplicates(t *testing.T) {
	registry, err := NewProviderRegistry(ClaudeCodeProvider{}, secondProvider{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := registry.Provider("codex"); err != nil {
		t.Fatal(err)
	}
	if _, err := NewProviderRegistry(ClaudeCodeProvider{}, ClaudeCodeProvider{}); err == nil {
		t.Fatal("duplicate provider was accepted")
	}
}
