package browserruntime

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"testing"
	"time"
)

func TestBrokerExecuteRoundTrip(t *testing.T) {
	broker := New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = broker.Serve(ctx, ln) }()
	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	enc := json.NewEncoder(conn)
	dec := json.NewDecoder(conn)
	if err := enc.Encode(wireMessage{Type: "hello", Version: ProtocolVersion}); err != nil {
		t.Fatal(err)
	}
	waitConnected(t, broker)

	resultCh := make(chan Result, 1)
	errCh := make(chan error, 1)
	go func() {
		result, err := broker.Execute(context.Background(), "session-1", "snapshot", map[string]interface{}{"interactive": true})
		if err != nil {
			errCh <- err
			return
		}
		resultCh <- result
	}()

	var command wireMessage
	if err := dec.Decode(&command); err != nil {
		t.Fatal(err)
	}
	if command.Type != "command" || command.SessionID != "session-1" || command.Action != "snapshot" {
		t.Fatalf("command = %#v", command)
	}
	if err := enc.Encode(wireMessage{
		Type:      "result",
		RequestID: command.RequestID,
		OK:        true,
		Result:    json.RawMessage(`{"text":"button Save [ref=e1]"}`),
	}); err != nil {
		t.Fatal(err)
	}

	select {
	case err := <-errCh:
		t.Fatal(err)
	case result := <-resultCh:
		value := result.Value.(map[string]interface{})
		if value["text"] != "button Save [ref=e1]" {
			t.Fatalf("result = %#v", result.Value)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for result")
	}
}

func TestBrokerMapsRuntimeError(t *testing.T) {
	broker := New(slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = broker.Serve(ctx, ln) }()
	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	enc := json.NewEncoder(conn)
	dec := json.NewDecoder(conn)
	_ = enc.Encode(wireMessage{Type: "hello", Version: ProtocolVersion})
	waitConnected(t, broker)

	errCh := make(chan error, 1)
	go func() {
		_, err := broker.Execute(context.Background(), "session-1", "click", map[string]interface{}{"ref": "e1"})
		errCh <- err
	}()
	var command wireMessage
	if err := dec.Decode(&command); err != nil {
		t.Fatal(err)
	}
	_ = enc.Encode(wireMessage{
		Type:      "result",
		RequestID: command.RequestID,
		Error:     &CommandError{Code: "STALE_REFERENCE", Message: "snapshot again"},
	})

	select {
	case err := <-errCh:
		var commandErr CommandError
		if !errors.As(err, &commandErr) || commandErr.Code != "STALE_REFERENCE" {
			t.Fatalf("error = %#v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for error")
	}
}

func TestBrokerUnavailableWithoutElectron(t *testing.T) {
	broker := New(nil)
	if _, err := broker.Execute(context.Background(), "session-1", "snapshot", nil); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("error = %v, want ErrUnavailable", err)
	}
}

func TestBrokerMarksDispatchedCommandOutcomeUnknownOnDisconnect(t *testing.T) {
	broker := New(nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = broker.Serve(ctx, ln) }()
	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	enc, dec := json.NewEncoder(conn), json.NewDecoder(conn)
	_ = enc.Encode(wireMessage{Type: "hello", Version: ProtocolVersion})
	waitConnected(t, broker)

	errCh := make(chan error, 1)
	go func() {
		_, executeErr := broker.Execute(context.Background(), "session-1", "click", nil)
		errCh <- executeErr
	}()
	var command wireMessage
	if err := dec.Decode(&command); err != nil {
		t.Fatal(err)
	}
	_ = conn.Close()

	select {
	case executeErr := <-errCh:
		if !errors.Is(executeErr, ErrOutcomeUnknown) {
			t.Fatalf("error = %v, want ErrOutcomeUnknown", executeErr)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for disconnect result")
	}
}

func TestBrokerRejectsInvalidRuntimeToken(t *testing.T) {
	broker := New(nil, "expected-token")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = broker.Serve(ctx, ln) }()

	invalid, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(invalid).Encode(wireMessage{
		Type:    "hello",
		Version: ProtocolVersion,
		Token:   "wrong-token",
	}); err != nil {
		t.Fatal(err)
	}
	_ = invalid.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := invalid.Read(make([]byte, 1)); err == nil {
		t.Fatal("invalid runtime connection remained open")
	}
	_ = invalid.Close()
	if broker.Status().Connected {
		t.Fatal("broker accepted an invalid runtime token")
	}

	valid, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = valid.Close() }()
	if err := json.NewEncoder(valid).Encode(wireMessage{
		Type:    "hello",
		Version: ProtocolVersion,
		Token:   "expected-token",
	}); err != nil {
		t.Fatal(err)
	}
	waitConnected(t, broker)
}

func TestBrokerPrefersDesktopOverHeadlessProvider(t *testing.T) {
	broker := New(nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = broker.Serve(ctx, ln) }()

	headless, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = headless.Close() }()
	_ = json.NewEncoder(headless).Encode(wireMessage{Type: "hello", Version: ProtocolVersion, Provider: "headless-electron"})
	waitProvider(t, broker, "headless-electron")

	desktop, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = desktop.Close() }()
	_ = json.NewEncoder(desktop).Encode(wireMessage{Type: "hello", Version: ProtocolVersion, Provider: "electron"})
	waitProvider(t, broker, "electron")

	rejected, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	_ = json.NewEncoder(rejected).Encode(wireMessage{Type: "hello", Version: ProtocolVersion, Provider: "headless-electron"})
	_ = rejected.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := rejected.Read(make([]byte, 1)); err == nil {
		t.Fatal("headless provider replaced an active desktop provider")
	}
	if got := broker.Status().Provider; got != "electron" {
		t.Fatalf("provider = %q, want electron", got)
	}
}

func TestBrokerCancellationSendsCancelFrame(t *testing.T) {
	broker := New(nil)
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _ = broker.Serve(ctx, ln) }()
	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = conn.Close() }()
	enc, dec := json.NewEncoder(conn), json.NewDecoder(conn)
	_ = enc.Encode(wireMessage{Type: "hello", Version: ProtocolVersion})
	waitConnected(t, broker)

	requestCtx, cancel := context.WithCancel(context.Background())
	errCh := make(chan error, 1)
	go func() {
		_, err := broker.Execute(requestCtx, "session-1", "wait", nil)
		errCh <- err
	}()
	var command wireMessage
	if err := dec.Decode(&command); err != nil {
		t.Fatal(err)
	}
	cancel()
	var cancelMessage wireMessage
	if err := dec.Decode(&cancelMessage); err != nil {
		t.Fatal(err)
	}
	if cancelMessage.Type != "cancel" || cancelMessage.RequestID != command.RequestID {
		t.Fatalf("cancel message = %#v, command = %#v", cancelMessage, command)
	}
	if err := <-errCh; !errors.Is(err, context.Canceled) {
		t.Fatalf("Execute error = %v", err)
	}
}

func TestBrokerWriteObservesContext(t *testing.T) {
	broker := New(nil)
	server, client := net.Pipe()
	defer func() {
		_ = server.Close()
		_ = client.Close()
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	started := time.Now()
	err := broker.write(ctx, client, wireMessage{Type: "command", RequestID: "blocked"})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("write error = %v", err)
	}
	if time.Since(started) > time.Second {
		t.Fatal("context cancellation did not bound browser write")
	}
}

func waitConnected(t *testing.T, broker *Broker) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for !broker.Status().Connected {
		if time.Now().After(deadline) {
			t.Fatal("browser runtime did not connect")
		}
		time.Sleep(time.Millisecond)
	}
}

func waitProvider(t *testing.T, broker *Broker, provider string) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		status := broker.Status()
		if status.Connected && status.Provider == provider {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("broker provider did not become %q", provider)
}
