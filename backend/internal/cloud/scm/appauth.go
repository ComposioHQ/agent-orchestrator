package scm

import (
	"crypto/rsa"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	appJWTLifetime = 9 * time.Minute
	appJWTBackdate = time.Minute
)

// AppCredentials owns the parsed GitHub App signing key and public app identity.
type AppCredentials struct {
	appID      int64
	slug       string
	privateKey *rsa.PrivateKey
	now        func() time.Time
}

// NewAppCredentials validates the app identity and parses a PEM RSA key.
func NewAppCredentials(appID int64, slug string, privateKeyPEM []byte) (*AppCredentials, error) {
	if appID <= 0 {
		return nil, errors.New("cloud scm: github app id must be positive")
	}
	slug = strings.TrimSpace(slug)
	if slug == "" {
		return nil, errors.New("cloud scm: github app slug is required")
	}
	key, err := jwt.ParseRSAPrivateKeyFromPEM(privateKeyPEM)
	if err != nil {
		return nil, errors.New("cloud scm: github app private key is not a valid PEM RSA key")
	}
	if key.N.BitLen() < 2048 {
		return nil, errors.New("cloud scm: github app private key must be at least 2048 bits")
	}
	return &AppCredentials{appID: appID, slug: slug, privateKey: key, now: time.Now}, nil
}

// AppID returns the numeric GitHub App identifier.
func (c *AppCredentials) AppID() int64 { return c.appID }

// Slug returns the configured GitHub App slug.
func (c *AppCredentials) Slug() string { return c.slug }

// JWT signs a short-lived app assertion with bounded clock skew.
func (c *AppCredentials) JWT() (string, error) {
	now := c.now().UTC()
	issuedAt := now.Add(-appJWTBackdate)
	claims := jwt.RegisteredClaims{
		Issuer:    strconv.FormatInt(c.appID, 10),
		IssuedAt:  jwt.NewNumericDate(issuedAt),
		ExpiresAt: jwt.NewNumericDate(issuedAt.Add(appJWTLifetime)),
	}
	return jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(c.privateKey)
}
