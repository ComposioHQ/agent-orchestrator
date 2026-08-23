package config

import (
	"encoding/base64"
	"testing"
	"time"
)

func TestLoadRequiresHostedIdentityAndDatabaseSettings(t *testing.T) {
	values := map[string]string{
		"AO_CLOUD_DATABASE_URL":            "postgres://runtime@example.test/ao",
		"AO_CLOUD_GOOGLE_CLIENT_IDS":       "desktop, web ",
		"AO_CLOUD_ALLOWED_EMAILS":          " Person@Example.com,other@example.com ",
		"AO_CLOUD_ACCESS_TOKEN_KEY_BASE64": base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")),
		"AO_CLOUD_ACCESS_TOKEN_TTL":        "10m",
		"AO_CLOUD_REFRESH_TOKEN_TTL":       "720h",
		"AO_CLOUD_TRUST_SOURCE_IP_HEADER":  "true",
		"AO_CLOUD_CREDENTIAL_KMS_KEY_ID":   "test-key",
	}
	cfg, err := load(func(key string) string { return values[key] })
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Address != defaultAddress || len(cfg.GoogleClientIDs) != 2 ||
		cfg.AccessTokenTTL != 10*time.Minute || cfg.RefreshTokenTTL != 30*24*time.Hour ||
		len(cfg.AllowedEmails) != 2 || cfg.AllowedEmails[0] != "person@example.com" || !cfg.TrustSourceIPHeader {
		t.Fatalf("config = %#v", cfg)
	}

	delete(values, "AO_CLOUD_GOOGLE_CLIENT_IDS")
	if _, err := load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("missing Google client IDs were accepted")
	}
	values["AO_CLOUD_GOOGLE_CLIENT_IDS"] = "desktop"
	delete(values, "AO_CLOUD_ALLOWED_EMAILS")
	if _, err := load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("missing allowed emails were accepted")
	}
	values["AO_CLOUD_ALLOWED_EMAILS"] = "person@example.com"
	delete(values, "AO_CLOUD_CREDENTIAL_KMS_KEY_ID")
	if _, err := load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("missing credential KMS key was accepted")
	}
}

func TestLoadRejectsWeakSigningKey(t *testing.T) {
	values := map[string]string{
		"AO_CLOUD_DATABASE_URL":            "postgres://runtime@example.test/ao",
		"AO_CLOUD_GOOGLE_CLIENT_IDS":       "desktop",
		"AO_CLOUD_ALLOWED_EMAILS":          "person@example.com",
		"AO_CLOUD_ACCESS_TOKEN_KEY_BASE64": base64.StdEncoding.EncodeToString([]byte("too-short")),
		"AO_CLOUD_CREDENTIAL_KMS_KEY_ID":   "test-key",
	}
	if _, err := load(func(key string) string { return values[key] }); err == nil {
		t.Fatal("weak access-token key was accepted")
	}
}

// The hosted application API is on unless explicitly turned off, so a
// deployment that says nothing gets the full surface rather than silently
// serving auth only.
func TestAppAPIDefaultsOnAndIsExplicitlyDisableable(t *testing.T) {
	base := map[string]string{
		"AO_CLOUD_DATABASE_URL":            "postgres://runtime@example.test/ao",
		"AO_CLOUD_GOOGLE_CLIENT_IDS":       "desktop",
		"AO_CLOUD_ALLOWED_EMAILS":          "person@example.com",
		"AO_CLOUD_ACCESS_TOKEN_KEY_BASE64": base64.StdEncoding.EncodeToString([]byte("0123456789abcdef0123456789abcdef")),
		"AO_CLOUD_CREDENTIAL_KMS_KEY_ID":   "test-key",
	}
	for name, want := range map[string]struct {
		value   string
		enabled bool
	}{
		"unset":            {"", true},
		"true":             {"true", true},
		"false":            {"false", false},
		"mixed-case false": {" False ", false},
		"unrecognized":     {"maybe", true},
	} {
		t.Run(name, func(t *testing.T) {
			values := make(map[string]string, len(base)+1)
			for key, value := range base {
				values[key] = value
			}
			if want.value != "" {
				values["AO_CLOUD_APP_API"] = want.value
			}
			cfg, err := load(func(key string) string { return values[key] })
			if err != nil {
				t.Fatal(err)
			}
			if cfg.AppAPIEnabled != want.enabled {
				t.Fatalf("AppAPIEnabled = %v, want %v", cfg.AppAPIEnabled, want.enabled)
			}
		})
	}
}
