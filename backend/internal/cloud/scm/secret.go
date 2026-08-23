package scm

import "log/slog"

// Secret wraps credential material so the ordinary ways a value escapes a Go
// process — fmt verbs, JSON encoding, structured logging — all yield a
// placeholder. Reveal is the single, greppable way to obtain the plaintext.
type Secret struct {
	value string
}

// NewSecret wraps credential material.
func NewSecret(value string) Secret { return Secret{value: value} }

// Reveal returns the plaintext. Call it only where the credential is handed to
// the provider or to a sandbox bootstrap channel.
func (s Secret) Reveal() string { return s.value }

// Empty reports whether any credential material is present.
func (s Secret) Empty() bool { return s.value == "" }

// String satisfies fmt.Stringer with a redacted placeholder.
func (s Secret) String() string { return "[redacted]" }

// GoString satisfies the %#v verb with a redacted placeholder.
func (s Secret) GoString() string { return "scm.Secret{[redacted]}" }

// MarshalJSON keeps secrets out of any response body or persisted document.
func (s Secret) MarshalJSON() ([]byte, error) { return []byte(`"[redacted]"`), nil }

// LogValue keeps secrets out of slog output even when a struct is logged whole.
func (s Secret) LogValue() slog.Value { return slog.StringValue("[redacted]") }
