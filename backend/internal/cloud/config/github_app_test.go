package config

import (
	"encoding/base64"
	"strings"
	"testing"
)

const testPEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK\n-----END RSA PRIVATE KEY-----"

func TestLoadGitHubAppIsOptionalAsAGroup(t *testing.T) {
	cfg, err := loadGitHubApp(func(string) string { return "" })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Configured() || cfg.WebhooksConfigured() {
		t.Fatalf("empty environment produced %#v", cfg)
	}
}

func TestLoadGitHubAppRejectsPartialConfiguration(t *testing.T) {
	cases := []map[string]string{
		{"AO_CLOUD_GITHUB_APP_ID": "42"},
		{"AO_CLOUD_GITHUB_APP_SLUG": "ao-cloud"},
		{"AO_CLOUD_GITHUB_APP_PRIVATE_KEY": testPEM},
		{"AO_CLOUD_GITHUB_APP_ID": "42", "AO_CLOUD_GITHUB_APP_SLUG": "ao-cloud"},
	}
	for _, values := range cases {
		if _, err := loadGitHubApp(func(key string) string { return values[key] }); err == nil {
			t.Fatalf("partial configuration %#v was accepted", values)
		}
	}
}

func TestLoadGitHubAppRequiresOAuthPairTogether(t *testing.T) {
	values := map[string]string{
		"AO_CLOUD_GITHUB_APP_ID":          "42",
		"AO_CLOUD_GITHUB_APP_SLUG":        "ao-cloud",
		"AO_CLOUD_GITHUB_APP_PRIVATE_KEY": testPEM,
		"AO_CLOUD_GITHUB_APP_CLIENT_ID":   "client",
	}
	if _, err := loadGitHubApp(func(key string) string { return values[key] }); err == nil {
		t.Fatal("a client id without a secret was accepted")
	}
	values["AO_CLOUD_GITHUB_APP_CLIENT_SECRET"] = "secret"
	if _, err := loadGitHubApp(func(key string) string { return values[key] }); err != nil {
		t.Fatal(err)
	}
}

func TestLoadGitHubAppAcceptsBase64AndEscapedKeys(t *testing.T) {
	base := map[string]string{
		"AO_CLOUD_GITHUB_APP_ID":                 "42",
		"AO_CLOUD_GITHUB_APP_SLUG":               " ao-cloud ",
		"AO_CLOUD_GITHUB_APP_WEBHOOK_SECRET":     " s3cret ",
		"AO_CLOUD_GITHUB_APP_PRIVATE_KEY_BASE64": base64.StdEncoding.EncodeToString([]byte(testPEM)),
	}
	cfg, err := loadGitHubApp(func(key string) string { return base[key] })
	if err != nil {
		t.Fatal(err)
	}
	if string(cfg.PrivateKeyPEM) != testPEM || cfg.AppSlug != "ao-cloud" || string(cfg.WebhookSecret) != "s3cret" {
		t.Fatalf("config = %#v", cfg)
	}
	if !cfg.Configured() || !cfg.WebhooksConfigured() {
		t.Fatalf("config = %#v", cfg)
	}

	// Task definitions routinely mangle real newlines into literal "\n".
	escaped := map[string]string{
		"AO_CLOUD_GITHUB_APP_ID":          "42",
		"AO_CLOUD_GITHUB_APP_SLUG":        "ao-cloud",
		"AO_CLOUD_GITHUB_APP_PRIVATE_KEY": strings.ReplaceAll(testPEM, "\n", `\n`),
	}
	cfg, err = loadGitHubApp(func(key string) string { return escaped[key] })
	if err != nil {
		t.Fatal(err)
	}
	if string(cfg.PrivateKeyPEM) != testPEM {
		t.Fatalf("escaped newlines were not restored: %q", cfg.PrivateKeyPEM)
	}
	// Without a webhook secret the endpoint must stay disabled rather than
	// accept unverified deliveries.
	if cfg.WebhooksConfigured() {
		t.Fatal("webhooks reported configured without a secret")
	}
}

func TestLoadGitHubAppRejectsBadValues(t *testing.T) {
	cases := []map[string]string{
		{"AO_CLOUD_GITHUB_APP_ID": "not-a-number", "AO_CLOUD_GITHUB_APP_SLUG": "ao-cloud", "AO_CLOUD_GITHUB_APP_PRIVATE_KEY": testPEM},
		{"AO_CLOUD_GITHUB_APP_ID": "-1", "AO_CLOUD_GITHUB_APP_SLUG": "ao-cloud", "AO_CLOUD_GITHUB_APP_PRIVATE_KEY": testPEM},
		{"AO_CLOUD_GITHUB_APP_ID": "42", "AO_CLOUD_GITHUB_APP_SLUG": "ao-cloud", "AO_CLOUD_GITHUB_APP_PRIVATE_KEY_BASE64": "!!!not-base64!!!"},
	}
	for _, values := range cases {
		if _, err := loadGitHubApp(func(key string) string { return values[key] }); err == nil {
			t.Fatalf("bad configuration %#v was accepted", values)
		}
	}
}

func TestLoadGitHubAppErrorsDoNotEchoKeyMaterial(t *testing.T) {
	values := map[string]string{
		"AO_CLOUD_GITHUB_APP_ID":                 "42",
		"AO_CLOUD_GITHUB_APP_PRIVATE_KEY_BASE64": "not-base64-" + strings.Repeat("Z", 8) + "!",
	}
	_, err := loadGitHubApp(func(key string) string { return values[key] })
	if err == nil {
		t.Fatal("invalid base64 was accepted")
	}
	if strings.Contains(err.Error(), "ZZZZ") {
		t.Fatalf("error echoed the supplied value: %v", err)
	}
}
