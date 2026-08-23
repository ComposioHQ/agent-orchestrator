package scm

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"testing"
	"time"
)

const testTokenMaterial = "ghs_super_secret_installation_token"

func testBrokeredToken() BrokeredToken {
	return BrokeredToken{
		Token:                  NewSecret(testTokenMaterial),
		ExpiresAt:              time.Now().UTC().Add(time.Hour),
		Repository:             "acme/widgets",
		ExternalRepositoryID:   900,
		InstallationID:         "installation-55",
		ExternalInstallationID: 55,
		Purpose:                "clone",
		BotLogin:               "ao-cloud[bot]",
	}
}

func TestSecretDoesNotLeakThroughTheUsualExits(t *testing.T) {
	secret := NewSecret(testTokenMaterial)

	if got := fmt.Sprintf("%v %s %#v", secret, secret, secret); strings.Contains(got, testTokenMaterial) {
		t.Fatalf("fmt exposed the credential: %s", got)
	}
	encoded, err := json.Marshal(map[string]any{"token": secret})
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte(testTokenMaterial)) {
		t.Fatalf("json exposed the credential: %s", encoded)
	}
	var logged bytes.Buffer
	slog.New(slog.NewTextHandler(&logged, nil)).Info("brokered", "token", secret)
	if strings.Contains(logged.String(), testTokenMaterial) {
		t.Fatalf("slog exposed the credential: %s", logged.String())
	}
	// A whole struct logged by accident must be safe too.
	logged.Reset()
	slog.New(slog.NewTextHandler(&logged, nil)).Info("brokered", "credential", NewCloneCredential(testBrokeredToken(), "github.com"))
	if strings.Contains(logged.String(), testTokenMaterial) {
		t.Fatalf("slog exposed the credential inside a struct: %s", logged.String())
	}
	if secret.Reveal() != testTokenMaterial {
		t.Fatal("Reveal did not return the credential")
	}
}

func TestCloneCredentialKeepsTheTokenOutOfDurableSurfaces(t *testing.T) {
	credential := NewCloneCredential(testBrokeredToken(), "github.com")

	if strings.Contains(credential.RemoteURL, testTokenMaterial) {
		t.Fatalf("remote URL embeds the credential: %s", credential.RemoteURL)
	}
	if credential.RemoteURL != "https://x-access-token@github.com/acme/widgets.git" {
		t.Fatalf("remote URL = %s", credential.RemoteURL)
	}
	if strings.Contains(AskPassScript(), testTokenMaterial) {
		t.Fatal("the askpass script embeds the credential")
	}
	if credential.BotEmail != "ao-cloud[bot]@users.noreply.github.com" {
		t.Fatalf("bot email = %s", credential.BotEmail)
	}
}

func TestCloneCredentialGitEnvCarriesTheTokenAndDisarmsPersistence(t *testing.T) {
	credential := NewCloneCredential(testBrokeredToken(), "github.com")
	env := credential.GitEnv("/tmp/ao-scm-askpass")

	values := map[string]string{}
	for _, entry := range env {
		key, value, found := strings.Cut(entry, "=")
		if !found {
			t.Fatalf("malformed env entry %q", entry)
		}
		values[key] = value
	}
	if values[EnvToken] != testTokenMaterial {
		t.Fatal("the git child process cannot see the credential")
	}
	if values[EnvUsername] != CloneUsername || values[EnvAskPass] != "/tmp/ao-scm-askpass" {
		t.Fatalf("env = %#v", values)
	}
	if values["GIT_TERMINAL_PROMPT"] != "0" {
		t.Fatal("git could hang on an interactive prompt")
	}
	// credential.helper must be cleared, or a system helper could write the
	// token to ~/.git-credentials and outlive the clone.
	if values["GIT_CONFIG_KEY_0"] != "credential.helper" || values["GIT_CONFIG_VALUE_0"] != "" {
		t.Fatalf("credential.helper is not cleared: %#v", values)
	}
	if values["GIT_CONFIG_COUNT"] != "2" {
		t.Fatalf("GIT_CONFIG_COUNT = %q", values["GIT_CONFIG_COUNT"])
	}
}

func TestCloneCredentialExpiryAndPushScope(t *testing.T) {
	token := testBrokeredToken()
	credential := NewCloneCredential(token, "github.com")
	if credential.Expired(token.ExpiresAt.Add(-time.Minute)) {
		t.Fatal("a live credential reported as expired")
	}
	if !credential.Expired(token.ExpiresAt) {
		t.Fatal("a credential at its expiry instant was still considered live")
	}
	if credential.CanPush() {
		t.Fatal("a clone credential claimed push scope")
	}
	token.Purpose = "push"
	if !NewCloneCredential(token, "github.com").CanPush() {
		t.Fatal("a push credential did not claim push scope")
	}
}

func TestRevealForBootstrapIsTheOnlyPlaintextPath(t *testing.T) {
	credential := NewCloneCredential(testBrokeredToken(), "github.com")
	revealed := credential.RevealForBootstrap()
	if revealed.Token != testTokenMaterial {
		t.Fatal("the bootstrap payload does not carry the credential")
	}
	// Marshaling the CloneCredential itself must stay redacted, so a transport
	// that forgets to call RevealForBootstrap fails loudly rather than quietly
	// sending a placeholder-free secret.
	encoded, err := json.Marshal(credential)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte(testTokenMaterial)) {
		t.Fatalf("marshaling CloneCredential exposed the credential: %s", encoded)
	}
}

func TestNewCloneCredentialDefaultsHost(t *testing.T) {
	credential := NewCloneCredential(testBrokeredToken(), "  ")
	if !strings.Contains(credential.RemoteURL, "github.com") {
		t.Fatalf("remote URL = %s", credential.RemoteURL)
	}
}
