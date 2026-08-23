package scm

import (
	"encoding/json"
	"log/slog"
	"time"
)

const CloneUsername = "x-access-token"

type Credential struct {
	Username   string
	Token      []byte
	ExpiresAt  time.Time
	Repository string
}

func (Credential) String() string   { return "[redacted scm credential]" }
func (Credential) GoString() string { return "scm.Credential{[redacted]}" }
func (Credential) LogValue() slog.Value {
	return slog.StringValue("[redacted scm credential]")
}
func (c Credential) MarshalJSON() ([]byte, error) {
	return json.Marshal(map[string]any{"username": c.Username, "token": "[redacted]", "expiresAt": c.ExpiresAt, "repository": c.Repository})
}
func (c *Credential) Zero() {
	for index := range c.Token {
		c.Token[index] = 0
	}
	c.Token = nil
}
