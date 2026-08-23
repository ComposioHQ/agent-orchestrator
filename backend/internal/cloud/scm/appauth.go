package scm

import (
	"crypto/rsa"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// appJWTLifetime is how long a signed app JWT stays valid. GitHub rejects
// anything over ten minutes; nine leaves room for clock skew on both ends.
const appJWTLifetime = 9 * time.Minute

// appJWTBackdate compensates for control-plane clocks running slightly ahead
// of GitHub's. GitHub rejects an `iat` in its future.
const appJWTBackdate = 60 * time.Second

// AppCredentials holds the GitHub App identity used to mint installation
// tokens. The private key is supplied by the caller from Secrets Manager or
// the process environment; this type never reads a file and never logs.
type AppCredentials struct {
	appID      int64
	slug       string
	privateKey *rsa.PrivateKey
	now        func() time.Time
}

// NewAppCredentials parses a PEM-encoded RSA private key and validates the app
// identity. The PEM bytes are not retained beyond parsing.
func NewAppCredentials(appID int64, slug string, privateKeyPEM []byte) (*AppCredentials, error) {
	if appID <= 0 {
		return nil, errors.New("cloud scm: github app id must be positive")
	}
	slug = strings.TrimSpace(slug)
	if slug == "" {
		return nil, errors.New("cloud scm: github app slug is required")
	}
	if len(privateKeyPEM) == 0 {
		return nil, errors.New("cloud scm: github app private key is required")
	}
	key, err := jwt.ParseRSAPrivateKeyFromPEM(privateKeyPEM)
	if err != nil {
		// The parse error can echo key bytes on some inputs. Report only the
		// failure category.
		return nil, errors.New("cloud scm: github app private key is not a valid PEM RSA key")
	}
	if key.N.BitLen() < 2048 {
		return nil, errors.New("cloud scm: github app private key must be at least 2048 bits")
	}
	return &AppCredentials{appID: appID, slug: slug, privateKey: key, now: time.Now}, nil
}

// AppID returns the numeric GitHub App id.
func (c *AppCredentials) AppID() int64 { return c.appID }

// Slug returns the GitHub App slug, used to build install URLs and to derive
// the bot login used for comment attribution.
func (c *AppCredentials) Slug() string { return c.slug }

// BotLogin is the account GitHub attributes to actions taken with an
// installation token. Attribution logic compares against this instead of the
// `/user` login, which installation tokens cannot read.
func (c *AppCredentials) BotLogin() string { return c.slug + "[bot]" }

// JWT signs a short-lived app-level assertion. It authenticates app-level
// endpoints only; repository access always requires an installation token.
func (c *AppCredentials) JWT() (string, error) {
	now := c.now().UTC()
	issued := now.Add(-appJWTBackdate)
	claims := jwt.RegisteredClaims{
		Issuer:    strconv.FormatInt(c.appID, 10),
		IssuedAt:  jwt.NewNumericDate(issued),
		ExpiresAt: jwt.NewNumericDate(issued.Add(appJWTLifetime)),
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodRS256, claims).SignedString(c.privateKey)
	if err != nil {
		return "", fmt.Errorf("cloud scm: sign github app assertion: %w", err)
	}
	return signed, nil
}
