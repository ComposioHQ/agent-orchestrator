package scm

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestNewAppCredentialsRejectsUnusableConfiguration(t *testing.T) {
	valid := testPrivateKeyPEM(t)
	weak, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	weakPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(weak)})

	cases := []struct {
		name  string
		appID int64
		slug  string
		key   []byte
	}{
		{name: "no app id", appID: 0, slug: "ao-cloud", key: valid},
		{name: "no slug", appID: 1, slug: "  ", key: valid},
		{name: "no key", appID: 1, slug: "ao-cloud", key: nil},
		{name: "not a pem key", appID: 1, slug: "ao-cloud", key: []byte("-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----")},
		{name: "key too small", appID: 1, slug: "ao-cloud", key: weakPEM},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := NewAppCredentials(testCase.appID, testCase.slug, testCase.key); err == nil {
				t.Fatal("unusable app configuration was accepted")
			}
		})
	}
}

func TestAppCredentialsErrorNeverEchoesKeyMaterial(t *testing.T) {
	material := "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKsuperSecret\n-----END RSA PRIVATE KEY-----"
	_, err := NewAppCredentials(1, "ao-cloud", []byte(material))
	if err == nil {
		t.Fatal("a malformed key was accepted")
	}
	if strings.Contains(err.Error(), "superSecret") {
		t.Fatalf("error echoed key material: %v", err)
	}
}

func TestAppJWTIsShortLivedAndBackdated(t *testing.T) {
	credentials := testCredentials(t)
	// A fixed instant keeps the claim assertions exact; claim-time validation
	// is disabled below so the test does not depend on the wall clock.
	now := time.Date(2026, 8, 22, 12, 0, 0, 0, time.UTC)
	credentials.now = func() time.Time { return now }

	signed, err := credentials.JWT()
	if err != nil {
		t.Fatal(err)
	}
	var claims jwt.RegisteredClaims
	parsed, err := jwt.ParseWithClaims(signed, &claims, func(token *jwt.Token) (any, error) {
		if token.Method.Alg() != jwt.SigningMethodRS256.Alg() {
			t.Fatalf("assertion signed with %s", token.Method.Alg())
		}
		return &testKey.PublicKey, nil
	}, jwt.WithoutClaimsValidation())
	if err != nil || !parsed.Valid {
		t.Fatalf("assertion did not verify: %v", err)
	}
	if claims.Issuer != "4242" {
		t.Fatalf("issuer = %q", claims.Issuer)
	}
	// GitHub rejects an iat in its own future and an exp more than ten
	// minutes out.
	if !claims.IssuedAt.Before(now) {
		t.Fatalf("iat = %v is not backdated", claims.IssuedAt)
	}
	if lifetime := claims.ExpiresAt.Sub(claims.IssuedAt.Time); lifetime > 10*time.Minute {
		t.Fatalf("assertion lifetime = %v", lifetime)
	}
	if claims.ExpiresAt.After(now.Add(10 * time.Minute)) {
		t.Fatalf("assertion expires at %v, beyond GitHub's ceiling", claims.ExpiresAt)
	}
}

func TestBotLoginDerivesFromSlug(t *testing.T) {
	if login := testCredentials(t).BotLogin(); login != "ao-cloud[bot]" {
		t.Fatalf("bot login = %q", login)
	}
}
