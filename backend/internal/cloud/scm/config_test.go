package scm

import (
	"encoding/base64"
	"errors"
	"strings"
	"testing"
)

const testConfigPEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----"

func testConfigPEMBase64() string {
	return base64.StdEncoding.EncodeToString([]byte(testConfigPEM))
}

func TestLoadConfigIsOptionalAsAGroup(t *testing.T) {
	config, err := loadConfig(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if config.Enabled() || config.WebhooksEnabled() {
		t.Fatalf("an empty environment produced %#v", config)
	}
}

// The Secrets Manager document is the deployment contract. These field names
// are fixed; renaming one silently disables cloud SCM in production.
func TestLoadConfigReadsTheSecretsManagerDocument(t *testing.T) {
	values := map[string]string{
		EnvGitHubSecret: `{
			"githubAppId": 4242,
			"githubAppPrivateKeyBase64": "` + testConfigPEMBase64() + `",
			"githubWebhookSecret": "s3cret"
		}`,
		envAppSlug: " ao-cloud ",
	}
	config, err := loadConfig(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	if config.AppID != 4242 || config.AppSlug != "ao-cloud" ||
		string(config.PrivateKeyPEM) != testConfigPEM || string(config.WebhookSecret) != "s3cret" {
		t.Fatalf("config = %#v", config)
	}
	if !config.Enabled() || !config.WebhooksEnabled() {
		t.Fatalf("config = %#v", config)
	}
}

func TestLoadConfigAcceptsAStringAppIDInTheSecret(t *testing.T) {
	values := map[string]string{
		EnvGitHubSecret: `{"githubAppId":"4242","githubAppPrivateKeyBase64":"` + testConfigPEMBase64() + `"}`,
		envAppSlug:      "ao-cloud",
	}
	config, err := loadConfig(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	if config.AppID != 4242 {
		t.Fatalf("app id = %d", config.AppID)
	}
	// Without a webhook secret the delivery endpoint stays unmounted rather
	// than accepting unverified deliveries.
	if config.WebhooksEnabled() {
		t.Fatal("webhooks reported enabled without a secret")
	}
}

func TestLoadConfigFallsBackToIndividualVariables(t *testing.T) {
	values := map[string]string{
		envAppID:               "4242",
		envAppSlug:             "ao-cloud",
		envAppPrivateKeyBase64: testConfigPEMBase64(),
		envWebhookSecret:       "s3cret",
	}
	config, err := loadConfig(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	if !config.Enabled() || !config.WebhooksEnabled() || string(config.PrivateKeyPEM) != testConfigPEM {
		t.Fatalf("config = %#v", config)
	}
}

func TestSecretDocumentWinsOverIndividualVariables(t *testing.T) {
	values := map[string]string{
		EnvGitHubSecret:        `{"githubAppId":4242,"githubAppPrivateKeyBase64":"` + testConfigPEMBase64() + `","githubWebhookSecret":"from-secret"}`,
		envAppID:               "1",
		envAppPrivateKeyBase64: base64.StdEncoding.EncodeToString([]byte("stale")),
		envWebhookSecret:       "from-env",
		envAppSlug:             "ao-cloud",
	}
	config, err := loadConfig(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	if config.AppID != 4242 || string(config.WebhookSecret) != "from-secret" ||
		string(config.PrivateKeyPEM) != testConfigPEM {
		t.Fatalf("config = %#v", config)
	}
}

func TestLoadConfigRejectsPartialConfiguration(t *testing.T) {
	cases := []map[string]string{
		{envAppID: "4242"},
		{envAppSlug: "ao-cloud"},
		{envAppPrivateKeyBase64: testConfigPEMBase64()},
		{envAppID: "4242", envAppSlug: "ao-cloud"},
		{envAppID: "4242", envAppPrivateKeyBase64: testConfigPEMBase64()},
	}
	for _, values := range cases {
		if _, err := loadConfig(func(key string) string { return values[key] }); err == nil {
			t.Fatalf("partial configuration %#v was accepted", values)
		}
	}
}

func TestLoadConfigRequiresTheOAuthPairTogether(t *testing.T) {
	values := map[string]string{
		envAppID:               "4242",
		envAppSlug:             "ao-cloud",
		envAppPrivateKeyBase64: testConfigPEMBase64(),
		envOAuthClientID:       "client",
	}
	if _, err := loadConfig(func(key string) string { return values[key] }); err == nil {
		t.Fatal("a client id without a secret was accepted")
	}
	values[envOAuthClientSecret] = "secret"
	if _, err := loadConfig(func(key string) string { return values[key] }); err != nil {
		t.Fatal(err)
	}
}

func TestLoadConfigRejectsBadValues(t *testing.T) {
	cases := []map[string]string{
		{envAppID: "not-a-number", envAppSlug: "ao-cloud", envAppPrivateKeyBase64: testConfigPEMBase64()},
		{envAppID: "-1", envAppSlug: "ao-cloud", envAppPrivateKeyBase64: testConfigPEMBase64()},
		{envAppID: "4242", envAppSlug: "ao-cloud", envAppPrivateKeyBase64: "!!!not-base64!!!"},
		{EnvGitHubSecret: "{not json"},
	}
	for _, values := range cases {
		if _, err := loadConfig(func(key string) string { return values[key] }); err == nil {
			t.Fatalf("bad configuration %#v was accepted", values)
		}
	}
}

// The private key and the secret document are credential material. A
// configuration error must name the variable, never echo its value.
func TestLoadConfigErrorsNeverEchoCredentialMaterial(t *testing.T) {
	marker := strings.Repeat("Z", 16)
	cases := []map[string]string{
		{
			envAppID:               "4242",
			envAppSlug:             "ao-cloud",
			envAppPrivateKeyBase64: "not-base64-" + marker + "!",
		},
		{EnvGitHubSecret: `{"githubAppPrivateKeyBase64": "` + marker + `"`},
	}
	for _, values := range cases {
		_, err := loadConfig(func(key string) string { return values[key] })
		if err == nil {
			t.Fatalf("invalid configuration %#v was accepted", values)
		}
		if strings.Contains(err.Error(), marker) {
			t.Fatalf("error echoed the supplied value: %v", err)
		}
	}
}

func TestValidateAcceptsAFullyEmptyConfig(t *testing.T) {
	if err := (Config{}).Validate(); err != nil {
		t.Fatalf("an empty config is a valid off state, got %v", err)
	}
}

func TestNewBundleRejectsAnUnconfiguredApp(t *testing.T) {
	if _, err := NewBundle(BundleOptions{Store: nil}); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("error = %v", err)
	}
}
