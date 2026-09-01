package main

// PROTOTYPE (AO_CLOUD_TERMINAL_STREAM=1): WebSocket implementation of the
// duplex terminal stream the transport supervisor uses when enabled.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/aoagents/agent-orchestrator/cloud/internal/workertransport"
	"github.com/coder/websocket"
)

type terminalStreamFrame struct {
	Type string `json:"type"`
	Data []byte `json:"data,omitempty"`
}

type wsTerminalStream struct {
	conn *websocket.Conn
}

func (s *wsTerminalStream) ReadInput(ctx context.Context) ([]byte, error) {
	for {
		_, data, err := s.conn.Read(ctx)
		if err != nil {
			return nil, err
		}
		var frame terminalStreamFrame
		if json.Unmarshal(data, &frame) != nil || frame.Type != "input" {
			continue
		}
		return frame.Data, nil
	}
}

func (s *wsTerminalStream) WriteOutput(ctx context.Context, data []byte) error {
	frame, err := json.Marshal(terminalStreamFrame{Type: "output", Data: data})
	if err != nil {
		return err
	}
	return s.conn.Write(ctx, websocket.MessageText, frame)
}

func (s *wsTerminalStream) Close() {
	_ = s.conn.Close(websocket.StatusNormalClosure, "closed")
}

// dialTerminalStream opens the persistent duplex terminal socket, presenting
// the same rotating worker credential every worker HTTP call attaches.
func (c *client) dialTerminalStream(
	ctx context.Context,
	terminalID string,
) (workertransport.TerminalStream, error) {
	streamURL := strings.Replace(c.baseURL, "http", "ws", 1) +
		"/worker/terminals/" + url.PathEscape(terminalID) + "/stream"
	header := http.Header{}
	if token := c.currentToken(); token != "" {
		header.Set("Authorization", "Worker "+token)
	}
	conn, _, err := websocket.Dial(ctx, streamURL, &websocket.DialOptions{
		HTTPHeader: header,
	})
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(1 << 20)
	return &wsTerminalStream{conn: conn}, nil
}
