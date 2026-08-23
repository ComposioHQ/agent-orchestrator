package capability

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"io"
	"strings"
)

// tokenPrefix marks an AO capability so a leaked value is recognizable in logs
// and secret scanners, and so a caller cannot accidentally present an AO access
// token or refresh token here. The two credential classes are deliberately
// unmixable: access tokens authenticate a human, capabilities authenticate a
// sandbox.
const tokenPrefix = "aocap_v1"

const (
	idBytes     = 16
	secretBytes = 32
)

// mintToken produces an opaque capability: a public grant id used only to look
// the record up, and a high-entropy secret that is never stored. The two halves
// are joined so a holder sees one opaque string.
func mintToken(entropy io.Reader) (id, secret, token string, err error) {
	if entropy == nil {
		entropy = rand.Reader
	}
	rawID := make([]byte, idBytes)
	if _, err := io.ReadFull(entropy, rawID); err != nil {
		return "", "", "", fmt.Errorf("generate capability id: %w", err)
	}
	rawSecret := make([]byte, secretBytes)
	if _, err := io.ReadFull(entropy, rawSecret); err != nil {
		return "", "", "", fmt.Errorf("generate capability secret: %w", err)
	}
	id = base64.RawURLEncoding.EncodeToString(rawID)
	secret = base64.RawURLEncoding.EncodeToString(rawSecret)
	return id, secret, tokenPrefix + "." + id + "." + secret, nil
}

// parseToken splits an opaque capability without touching any store. It is
// deliberately strict: anything that is not exactly prefix.id.secret is not a
// capability, so a malformed value never reaches a database lookup.
func parseToken(token string) (id, secret string, err error) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 3 || parts[0] != tokenPrefix {
		return "", "", ErrInvalidToken
	}
	id, secret = parts[1], parts[2]
	if id == "" || secret == "" {
		return "", "", ErrInvalidToken
	}
	if _, err := base64.RawURLEncoding.DecodeString(id); err != nil {
		return "", "", ErrInvalidToken
	}
	if _, err := base64.RawURLEncoding.DecodeString(secret); err != nil {
		return "", "", ErrInvalidToken
	}
	return id, secret, nil
}

// verifierFor binds the stored digest to the grant id AND the scope. Binding
// the scope is what stops a verifier lifted from one row and pasted onto
// another (say, a worker row rewritten to name a coordinator scope) from
// authorizing the rewritten scope: the digest would no longer reproduce.
func verifierFor(id string, scope Scope, secret string) string {
	return digest("ao-cloud-capability-verifier-v1", id, scope.fingerprint(), secret)
}
