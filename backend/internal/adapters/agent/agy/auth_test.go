package agy

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAgyADCCredentialConfiguredFromExplicitFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "adc.json")
	if err := os.WriteFile(path, []byte(`{"type":"authorized_user"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", path)
	if !agyADCCredentialConfigured() {
		t.Fatal("expected explicit Application Default Credentials to be detected")
	}
}

func TestAgyADCCredentialConfiguredRejectsMissingFile(t *testing.T) {
	t.Setenv("GOOGLE_APPLICATION_CREDENTIALS", filepath.Join(t.TempDir(), "missing.json"))
	if agyADCCredentialConfigured() {
		t.Fatal("missing Application Default Credentials must not authorize AGY")
	}
}
