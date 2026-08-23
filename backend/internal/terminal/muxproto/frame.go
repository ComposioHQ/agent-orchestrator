package muxproto

// Channel names and message types are the shared terminal JSON contract. Keep
// these values aligned with internal/terminal/protocol.go; sandbox runtimes use
// this package directly instead of importing daemon terminal machinery.
const (
	ChannelTerminal  = "terminal"
	ChannelSubscribe = "subscribe"
	ChannelSessions  = "sessions"
	ChannelSystem    = "system"

	TypeOpen      = "open"
	TypeData      = "data"
	TypeResize    = "resize"
	TypeClose     = "close"
	TypeSubscribe = "subscribe"
	TypePing      = "ping"
	TypeOpened    = "opened"
	TypeExited    = "exited"
	TypeError     = "error"
	TypeSnapshot  = "snapshot"
	TypePong      = "pong"

	RoleSecondary = "secondary"
)

// ClientFrame is one client-to-mux frame. Terminal data is base64 encoded.
type ClientFrame struct {
	Channel string `json:"ch"`
	ID      string `json:"id,omitempty"`
	Type    string `json:"type"`
	Data    string `json:"data,omitempty"`
	Cols    uint16 `json:"cols,omitempty"`
	Rows    uint16 `json:"rows,omitempty"`
	Force   bool   `json:"force,omitempty"`
	Role    string `json:"role,omitempty"`
}

// ServerFrame is one mux-to-client frame. Session snapshots are intentionally
// absent from the sandbox runtime: durable session events remain in the
// control plane and never originate in disposable compute.
type ServerFrame struct {
	Channel string `json:"ch"`
	ID      string `json:"id,omitempty"`
	Type    string `json:"type"`
	Data    string `json:"data,omitempty"`
	Cols    uint16 `json:"cols,omitempty"`
	Rows    uint16 `json:"rows,omitempty"`
	Error   string `json:"error,omitempty"`
}
