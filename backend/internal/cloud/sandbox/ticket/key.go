package ticket

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
)

// KeyBytes is the length of a sandbox ticket key. It matches the HMAC-SHA256
// block-independent security level; a shorter key is rejected rather than
// stretched, so a misconfigured deployment fails at boot instead of running
// with a weak signer.
const KeyBytes = 32

// ErrInvalidKey means a key is missing or too short to sign with.
var ErrInvalidKey = errors.New("invalid sandbox ticket key")

// Key is the shared secret between the control plane (which mints tickets) and
// one sandbox (which verifies them).
//
// It deliberately implements Stringer and slog.LogValuer to redact itself.
// This key travels through configuration, gets passed to constructors, and ends
// up inside structs that a debugging session may print; every one of those is a
// path by which a signing key reaches a log aggregator. Making the redaction a
// property of the type rather than a rule contributors must remember is what
// keeps TestKeyNeverRendersItsMaterial meaningful.
type Key struct {
	material []byte
}

// NewKey wraps raw key material.
func NewKey(material []byte) (Key, error) {
	if len(material) < KeyBytes {
		return Key{}, fmt.Errorf("%w: need at least %d bytes, got %d", ErrInvalidKey, KeyBytes, len(material))
	}
	owned := make([]byte, len(material))
	copy(owned, material)
	return Key{material: owned}, nil
}

// GenerateKey mints a fresh key. entropy may be nil for crypto/rand.
func GenerateKey(entropy io.Reader) (Key, error) {
	if entropy == nil {
		entropy = rand.Reader
	}
	material := make([]byte, KeyBytes)
	if _, err := io.ReadFull(entropy, material); err != nil {
		return Key{}, fmt.Errorf("generate sandbox ticket key: %w", err)
	}
	return Key{material: material}, nil
}

// ParseKey decodes the standard-base64 form used to carry a key through the
// bootstrap environment.
func ParseKey(encoded string) (Key, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encoded))
	if err != nil {
		return Key{}, fmt.Errorf("%w: not valid base64", ErrInvalidKey)
	}
	return NewKey(raw)
}

// Encode renders the key for delivery through the bootstrap environment. It is
// the one intentional way to get the material back out, and its name says so:
// an author writing Encode into a log line is making a visible choice, where
// String or %v would have leaked silently.
func (k Key) Encode() string { return base64.StdEncoding.EncodeToString(k.material) }

// Valid reports whether the key can sign.
func (k Key) Valid() bool { return len(k.material) >= KeyBytes }

// String redacts. See the type comment.
func (k Key) String() string { return redactedKey }

// LogValue redacts under slog, including when the key is a field of a struct
// that is logged with %+v-style handlers.
func (k Key) LogValue() slog.Value { return slog.StringValue(redactedKey) }

const redactedKey = "[redacted sandbox ticket key]"
