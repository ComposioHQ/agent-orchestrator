package scm

import (
	"crypto/rsa"
	"strconv"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestAppCredentialsSignsBoundedGitHubJWT(t *testing.T) {
	credentials, err := NewAppCredentials(42, "ao-cloud", testRSAPrivateKeyPEM(t))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	credentials.now = func() time.Time { return now }
	signed, err := credentials.JWT()
	if err != nil {
		t.Fatal(err)
	}
	claims := &jwt.RegisteredClaims{}
	parsed, err := jwt.ParseWithClaims(signed, claims, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodRS256 {
			t.Fatalf("method = %s", token.Method.Alg())
		}
		return &rsa.PublicKey{N: credentials.privateKey.N, E: credentials.privateKey.E}, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodRS256.Alg()}))
	if err != nil || !parsed.Valid {
		t.Fatalf("valid = %v, error = %v", parsed.Valid, err)
	}
	if claims.Issuer != strconv.FormatInt(credentials.AppID(), 10) {
		t.Fatalf("issuer = %q", claims.Issuer)
	}
	if got := claims.ExpiresAt.Sub(claims.IssuedAt.Time); got != appJWTLifetime {
		t.Fatalf("lifetime = %s", got)
	}
	if !claims.IssuedAt.Equal(now.Add(-appJWTBackdate)) {
		t.Fatalf("issued at = %s", claims.IssuedAt.Time)
	}
}

func TestAppCredentialsRejectsInvalidIdentityAndKey(t *testing.T) {
	for _, input := range []struct {
		id   int64
		slug string
		key  []byte
	}{
		{id: 0, slug: "app", key: testRSAPrivateKeyPEM(t)},
		{id: 1, slug: "", key: testRSAPrivateKeyPEM(t)},
		{id: 1, slug: "app", key: []byte("not a key")},
	} {
		if _, err := NewAppCredentials(input.id, input.slug, input.key); err == nil {
			t.Fatalf("accepted id=%d slug=%q", input.id, input.slug)
		}
	}
}
