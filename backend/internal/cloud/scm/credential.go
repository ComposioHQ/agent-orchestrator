package scm

import (
	"encoding/json"
	"log/slog"
	"time"
)

// CloneUsername is GitHub's fixed username for installation-token authentication.
const CloneUsername = "x-access-token"

// Credential is a one-shot secret plus its canonical trusted repository target.
type Credential struct {
	Username   string
	Token      []byte
	ExpiresAt  time.Time
	Repository string
}

func (Credential) String() string { return "[redacted scm credential]" }

// GoString redacts the credential when formatted with Go syntax.
func (Credential) GoString() string { return "scm.Credential{[redacted]}" }

// LogValue redacts the credential in structured logs.
func (Credential) LogValue() slog.Value {
	return slog.StringValue("[redacted scm credential]")
}

// MarshalJSON preserves metadata while redacting the token.
func (c Credential) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]any{"username": c.Username, "token": "[redacted]", "expiresAt": c.ExpiresAt, "repository": c.Repository})
}

// Zero overwrites and releases the in-memory token bytes.
func (c *Credential) Zero() {
	for index := range c.Token {
		c.Token[index] = 0
	}
	c.Token = nil
}
