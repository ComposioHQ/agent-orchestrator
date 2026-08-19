package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const accessTokenPrefix = "aoa1"

// AccessTokenManager issues short-lived AO access tokens after Google identity
// exchange. Tokens identify a user, never snapshot organization membership;
// authorization is checked against PostgreSQL for each request.
type AccessTokenManager struct {
	key      []byte
	issuer   string
	audience string
	ttl      time.Duration
	now      func() time.Time
}

type AccessClaims struct {
	Issuer    string `json:"iss"`
	Audience  string `json:"aud"`
	Subject   string `json:"sub"`
	IssuedAt  int64  `json:"iat"`
	ExpiresAt int64  `json:"exp"`
}

func NewAccessTokenManager(
	key []byte,
	issuer string,
	audience string,
	ttl time.Duration,
) (*AccessTokenManager, error) {
	if len(key) < 32 {
		return nil, errors.New("AO access-token signing key must be at least 32 bytes")
	}
	issuer = strings.TrimSpace(issuer)
	audience = strings.TrimSpace(audience)
	if issuer == "" || audience == "" {
		return nil, errors.New("AO access-token issuer and audience are required")
	}
	if ttl <= 0 {
		return nil, errors.New("AO access-token lifetime must be positive")
	}
	return &AccessTokenManager{
		key:      append([]byte(nil), key...),
		issuer:   issuer,
		audience: audience,
		ttl:      ttl,
		now:      time.Now,
	}, nil
}

func (m *AccessTokenManager) Issue(userID string) (string, time.Time, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return "", time.Time{}, errors.New("access-token subject is required")
	}
	now := m.now().UTC()
	expiresAt := now.Add(m.ttl)
	payload, err := json.Marshal(AccessClaims{
		Issuer:    m.issuer,
		Audience:  m.audience,
		Subject:   userID,
		IssuedAt:  now.Unix(),
		ExpiresAt: expiresAt.Unix(),
	})
	if err != nil {
		return "", time.Time{}, err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	signature := base64.RawURLEncoding.EncodeToString(m.sign(encoded))
	return accessTokenPrefix + "." + encoded + "." + signature, expiresAt, nil
}

func (m *AccessTokenManager) Verify(token string) (AccessClaims, error) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 || parts[0] != accessTokenPrefix {
		return AccessClaims{}, ErrInvalidToken
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(signature, m.sign(parts[1])) {
		return AccessClaims{}, ErrInvalidToken
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return AccessClaims{}, ErrInvalidToken
	}
	var claims AccessClaims
	if err := json.Unmarshal(payload, &claims); err != nil ||
		claims.Issuer != m.issuer ||
		claims.Audience != m.audience ||
		strings.TrimSpace(claims.Subject) == "" ||
		claims.IssuedAt > m.now().UTC().Add(time.Minute).Unix() ||
		claims.ExpiresAt <= m.now().UTC().Unix() {
		return AccessClaims{}, ErrInvalidToken
	}
	return claims, nil
}

func (m *AccessTokenManager) sign(payload string) []byte {
	mac := hmac.New(sha256.New, m.key)
	_, _ = mac.Write([]byte(accessTokenPrefix + "." + payload))
	return mac.Sum(nil)
}

func IsAccessToken(token string) bool {
	return strings.HasPrefix(strings.TrimSpace(token), accessTokenPrefix+".")
}

func NewRefreshToken() (string, []byte, error) {
	token, _, err := NewOpaqueToken()
	if err != nil {
		return "", nil, err
	}
	token = "ao_refresh_" + strings.TrimPrefix(token, "ao_local_")
	return token, HashToken(token), nil
}
