package scm

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestSCMConfigIsAllOrNothing(t *testing.T) {
	if config, err := loadConfig(func(string) string { return "" }); err != nil || config.Enabled() {
		t.Fatalf("disabled config=%#v error=%v", config, err)
	}
	values := map[string]string{
		envAppID: "42", envAppSlug: "ao-cloud",
		envPrivateKey:    base64.StdEncoding.EncodeToString(testRSAPrivateKeyPEM(t)),
		envWebhookSecret: "webhook-secret", envOAuthClientID: "client",
		envOAuthClientSecret: "client-secret",
	}
	config, err := loadConfig(func(name string) string { return values[name] })
	if err != nil || !config.Enabled() {
		t.Fatalf("config=%#v error=%v", config, err)
	}
	delete(values, envOAuthClientSecret)
	if _, err := loadConfig(func(name string) string { return values[name] }); err == nil {
		t.Fatal("partial GitHub App config was accepted")
	}
}

func TestSCMConfigErrorsDoNotEchoSecrets(t *testing.T) {
	secret := "not-base64-secret-material"
	values := map[string]string{envAppID: "42", envAppSlug: "ao", envPrivateKey: secret}
	_, err := loadConfig(func(name string) string { return values[name] })
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("error = %v", err)
	}
}
