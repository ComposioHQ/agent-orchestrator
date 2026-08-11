package httpapi

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Untrivial-ai/ao-cloud/internal/domain"
)

func TestParseEventSequence(t *testing.T) {
	tests := []struct {
		value string
		want  int64
		valid bool
	}{
		{value: "", want: 0, valid: true},
		{value: "42", want: 42, valid: true},
		{value: "9007199254740991", want: maxEventSequence, valid: true},
		{value: "-1"},
		{value: "9007199254740992"},
		{value: "not-a-number"},
	}
	for _, test := range tests {
		t.Run(test.value, func(t *testing.T) {
			got, err := parseEventSequence(test.value)
			if (err == nil) != test.valid {
				t.Fatalf("parseEventSequence(%q) error = %v", test.value, err)
			}
			if err == nil && got != test.want {
				t.Fatalf("parseEventSequence(%q) = %d, want %d", test.value, got, test.want)
			}
		})
	}
}

func TestWriteSSEEvent(t *testing.T) {
	recorder := httptest.NewRecorder()
	createdAt := time.Date(2026, 8, 11, 10, 0, 0, 0, time.UTC)
	err := writeSSEEvent(recorder, domain.ClientEvent{
		SessionID: "session-1",
		Sequence:  7,
		Type:      "chat.user_message",
		Payload:   json.RawMessage(`{"text":"hello"}`),
		CreatedAt: createdAt,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := "id: 7\ndata: {\"sessionId\":\"session-1\",\"sequence\":7,\"type\":\"chat.user_message\",\"payload\":{\"text\":\"hello\"},\"createdAt\":\"2026-08-11T10:00:00Z\"}\n\n"
	if recorder.Body.String() != want {
		t.Fatalf("SSE body = %q, want %q", recorder.Body.String(), want)
	}
}
