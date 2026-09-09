package persistenthost

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if len(os.Args) >= 6 && os.Args[1] == "chat-host" && os.Args[5] == "--" {
		err := Run(context.Background(), Config{
			SessionID: os.Args[2], DataDir: os.Args[3], Workdir: os.Args[4],
			Env: os.Environ(), Argv: os.Args[6:],
		})
		if err != nil {
			_, _ = fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestProviderHelper(t *testing.T) {
	if os.Getenv("AO_CHAT_HOST_PROVIDER_HELPER") != "1" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var frame struct {
			ID     int64  `json:"id"`
			Method string `json:"method"`
		}
		if json.Unmarshal(scanner.Bytes(), &frame) != nil {
			continue
		}
		if frame.Method == "emit-later" {
			time.Sleep(50 * time.Millisecond)
			_, _ = fmt.Fprintln(os.Stdout, `{"method":"turn/completed","params":{"turn":{"id":"survived"}}}`)
			continue
		}
		if frame.Method == "request-approval" {
			_, _ = fmt.Fprintln(os.Stdout, `{"id":700,"method":"item/commandExecution/requestApproval","params":{"turnId":"turn-live"}}`)
			continue
		}
		if frame.Method == "" && frame.ID == 700 {
			_, _ = fmt.Fprintln(os.Stdout, `{"method":"approval/received","params":{"turnId":"turn-live"}}`)
			continue
		}
		_, _ = fmt.Fprintf(os.Stdout, `{"id":%d,"result":{"pid":%d}}`+"\n", frame.ID, os.Getpid())
	}
	os.Exit(0)
}

func TestHostReconnectsSameProviderAndReplaysDetachedOutput(t *testing.T) {
	dataDir := t.TempDir()
	workdir := t.TempDir()
	cfg := Config{
		SessionID: "project-7",
		DataDir:   dataDir,
		Workdir:   workdir,
		Env:       append(os.Environ(), "AO_CHAT_HOST_PROVIDER_HELPER=1"),
		Argv:      []string{os.Args[0], "-test.run=TestProviderHelper"},
	}
	hostDone := make(chan error, 1)
	go func() { hostDone <- Run(context.Background(), cfg) }()

	d := awaitDescriptor(t, dataDir, cfg.SessionID)
	first, err := attach(context.Background(), d, false)
	if err != nil {
		t.Fatalf("first attach: %v", err)
	}
	if _, err := attach(context.Background(), d, true); !errors.Is(err, ErrAttached) {
		t.Fatalf("concurrent attach error = %v, want ErrAttached", err)
	}
	pid := requestProviderPID(t, first, 7, "pid")
	if _, err := fmt.Fprintln(first.Stdin, `{"id":8,"method":"emit-later"}`); err != nil {
		t.Fatalf("send delayed frame: %v", err)
	}
	if err := first.Stdin.Close(); err != nil {
		t.Fatalf("detach: %v", err)
	}

	var second *Transport
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		second, err = attach(context.Background(), d, true)
		if err == nil {
			break
		}
		if !errors.Is(err, ErrAttached) {
			t.Fatalf("reattach: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	if second == nil {
		t.Fatal("host never released first controller")
	}
	if !second.Reconnected || second.NextRequestID != 8 {
		t.Fatalf("reattach metadata = reconnected:%v next:%d", second.Reconnected, second.NextRequestID)
	}

	_ = second.Stdin.(interface{ SetReadDeadline(time.Time) error }).SetReadDeadline(time.Now().Add(3 * time.Second))
	line, err := bufio.NewReader(second.Stdout).ReadBytes('\n')
	if err != nil || !json.Valid(line) {
		t.Fatalf("replayed output = %q err=%v", line, err)
	}
	var replay struct {
		Method string `json:"method"`
	}
	_ = json.Unmarshal(line, &replay)
	if replay.Method != "turn/completed" {
		t.Fatalf("replayed method = %q", replay.Method)
	}
	if got := requestProviderPID(t, second, 9, "pid-again"); got != pid {
		t.Fatalf("provider pid changed across daemon detach: %d -> %d", pid, got)
	}
	_ = second.Stdin.Close()
	if err := Shutdown(context.Background(), dataDir, cfg.SessionID); err != nil {
		t.Fatalf("shutdown: %v", err)
	}
	select {
	case err := <-hostDone:
		if err != nil {
			t.Fatalf("host exit: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("host did not exit after explicit shutdown")
	}
}

func TestConnectOrStartLaunchesDetachedHost(t *testing.T) {
	dataDir := t.TempDir()
	cfg := Config{
		SessionID: "detached", DataDir: dataDir, Workdir: t.TempDir(),
		Env:  append(os.Environ(), "AO_CHAT_HOST_PROVIDER_HELPER=1"),
		Argv: []string{os.Args[0], "-test.run=TestProviderHelper"},
	}
	transport, err := ConnectOrStart(context.Background(), cfg)
	if err != nil {
		t.Fatalf("ConnectOrStart: %v", err)
	}
	t.Cleanup(func() { _ = Shutdown(context.Background(), dataDir, cfg.SessionID) })
	if transport.Reconnected {
		t.Fatal("new detached host reported reconnect")
	}
	d, err := readDescriptor(dataDir, cfg.SessionID)
	if err != nil {
		t.Fatal(err)
	}
	if d.PID == os.Getpid() {
		t.Fatalf("host pid = test pid %d; process was not detached", d.PID)
	}
	if pid := requestProviderPID(t, transport, 1, "pid"); pid == os.Getpid() || pid == d.PID {
		t.Fatalf("provider pid %d was not a distinct child of detached host %d", pid, d.PID)
	}
	_ = transport.Stdin.Close()
	if err := Shutdown(context.Background(), dataDir, cfg.SessionID); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	path, _ := descriptorPath(dataDir, cfg.SessionID)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("detached host did not remove its descriptor after shutdown")
}

func TestHostReplaysUnansweredServerRequestAfterDetach(t *testing.T) {
	dataDir := t.TempDir()
	cfg := Config{SessionID: "approval", DataDir: dataDir, Workdir: t.TempDir(),
		Env:  append(os.Environ(), "AO_CHAT_HOST_PROVIDER_HELPER=1"),
		Argv: []string{os.Args[0], "-test.run=TestProviderHelper"}}
	done := make(chan error, 1)
	go func() { done <- Run(context.Background(), cfg) }()
	d := awaitDescriptor(t, dataDir, cfg.SessionID)
	first, err := attach(context.Background(), d, false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprintln(first.Stdin, `{"id":5,"method":"request-approval"}`); err != nil {
		t.Fatal(err)
	}
	firstReader := bufio.NewReader(first.Stdout)
	line, err := firstReader.ReadBytes('\n')
	if err != nil || !bytes.Contains(line, []byte(`"id":700`)) {
		t.Fatalf("first server request = %q err=%v", line, err)
	}
	_ = first.Stdin.Close()

	second := awaitAttach(t, d)
	secondReader := bufio.NewReader(second.Stdout)
	line, err = secondReader.ReadBytes('\n')
	if err != nil || !bytes.Contains(line, []byte(`"id":700`)) {
		t.Fatalf("replayed server request = %q err=%v", line, err)
	}
	if _, err := fmt.Fprintln(second.Stdin, `{"id":700,"result":{"decision":"accept"}}`); err != nil {
		t.Fatal(err)
	}
	line, err = secondReader.ReadBytes('\n')
	if err != nil || !bytes.Contains(line, []byte(`"method":"approval/received"`)) {
		t.Fatalf("provider did not continue after replayed approval = %q err=%v", line, err)
	}
	_ = second.Stdin.Close()
	if err := Shutdown(context.Background(), dataDir, cfg.SessionID); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestAttachRejectsBadCapabilityAndVersion(t *testing.T) {
	dataDir := t.TempDir()
	workdir := t.TempDir()
	cfg := Config{SessionID: "project-8", DataDir: dataDir, Workdir: workdir,
		Env:  append(os.Environ(), "AO_CHAT_HOST_PROVIDER_HELPER=1"),
		Argv: []string{os.Args[0], "-test.run=TestProviderHelper"}}
	done := make(chan error, 1)
	go func() { done <- Run(context.Background(), cfg) }()
	d := awaitDescriptor(t, dataDir, cfg.SessionID)
	bad := d
	bad.Token = "wrong"
	if _, err := attach(context.Background(), bad, true); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("bad token error = %v", err)
	}
	bad = d
	bad.Version++
	if _, err := attach(context.Background(), bad, true); !errors.Is(err, ErrIncompatible) {
		t.Fatalf("bad version error = %v", err)
	}
	if err := Shutdown(context.Background(), dataDir, cfg.SessionID); err != nil {
		t.Fatal(err)
	}
	<-done
}

func TestAttachHonorsContextAfterDial(t *testing.T) {
	address, accepted := silentHandshakePeer(t)
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, attachErr := attach(ctx, Descriptor{
			Version: ProtocolVersion,
			Address: address,
			Token:   "token",
		}, true)
		result <- attachErr
	}()

	serverConn := awaitSilentHandshake(t, accepted)
	defer func() { _ = serverConn.Close() }()
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("attach error = %v, want context canceled", err)
		}
	case <-time.After(3 * time.Second):
		_ = serverConn.Close()
		<-result
		t.Fatal("attach ignored its context after connecting")
	}
}

func TestConnectOrStartTimesOutSilentLiveHost(t *testing.T) {
	address, accepted := silentHandshakePeer(t)
	dataDir := t.TempDir()
	const sessionID = "silent-connect"
	if err := writeDescriptor(dataDir, Descriptor{
		Version:   ProtocolVersion,
		SessionID: sessionID,
		Address:   address,
		Token:     "token",
		PID:       os.Getpid(),
	}); err != nil {
		t.Fatal(err)
	}
	workdir := t.TempDir()

	result := make(chan error, 1)
	go func() {
		_, err := ConnectOrStart(context.Background(), Config{
			SessionID: sessionID,
			DataDir:   dataDir,
			Workdir:   workdir,
			Argv:      []string{os.Args[0], "-test.run=TestProviderHelper"},
		})
		result <- err
	}()

	serverConn := awaitSilentHandshake(t, accepted)
	defer func() { _ = serverConn.Close() }()
	select {
	case err := <-result:
		if !errors.Is(err, context.DeadlineExceeded) || !errors.Is(err, ErrOwnershipInconclusive) {
			t.Fatalf("connect error = %v, want deadline exceeded ownership-inconclusive error", err)
		}
	case <-time.After(2 * time.Second):
		_ = serverConn.Close()
		<-result
		t.Fatal("connect to silent live host exceeded the handshake limit")
	}
}

func TestShutdownHonorsContextAfterDial(t *testing.T) {
	address, accepted := silentHandshakePeer(t)
	dataDir := t.TempDir()
	const sessionID = "silent-shutdown"
	if err := writeDescriptor(dataDir, Descriptor{
		Version:   ProtocolVersion,
		SessionID: sessionID,
		Address:   address,
		Token:     "token",
		PID:       os.Getpid(),
	}); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() { result <- Shutdown(ctx, dataDir, sessionID) }()

	serverConn := awaitSilentHandshake(t, accepted)
	defer func() { _ = serverConn.Close() }()
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("shutdown error = %v, want context canceled", err)
		}
	case <-time.After(3 * time.Second):
		_ = serverConn.Close()
		<-result
		t.Fatal("shutdown ignored its context after connecting")
	}
}

func TestShutdownTimesOutSilentLiveHost(t *testing.T) {
	address, accepted := silentHandshakePeer(t)
	dataDir := t.TempDir()
	const sessionID = "silent-shutdown-timeout"
	if err := writeDescriptor(dataDir, Descriptor{
		Version:   ProtocolVersion,
		SessionID: sessionID,
		Address:   address,
		Token:     "token",
		PID:       os.Getpid(),
	}); err != nil {
		t.Fatal(err)
	}

	result := make(chan error, 1)
	go func() { result <- Shutdown(context.Background(), dataDir, sessionID) }()

	serverConn := awaitSilentHandshake(t, accepted)
	defer func() { _ = serverConn.Close() }()
	select {
	case err := <-result:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("shutdown error = %v, want context deadline exceeded", err)
		}
	case <-time.After(2 * time.Second):
		_ = serverConn.Close()
		<-result
		t.Fatal("shutdown of silent live host exceeded the handshake limit")
	}
}

func TestAttachedTransportOutlivesHandshakeContext(t *testing.T) {
	dataDir := t.TempDir()
	cfg := Config{SessionID: "context-detached", DataDir: dataDir, Workdir: t.TempDir(),
		Env:  append(os.Environ(), "AO_CHAT_HOST_PROVIDER_HELPER=1"),
		Argv: []string{os.Args[0], "-test.run=TestProviderHelper"}}
	done := make(chan error, 1)
	go func() { done <- Run(context.Background(), cfg) }()
	d := awaitDescriptor(t, dataDir, cfg.SessionID)

	ctx, cancel := context.WithCancel(context.Background())
	transport, err := attach(ctx, d, true)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	if pid := requestProviderPID(t, transport, 1, "still-connected"); pid <= 0 {
		t.Fatalf("provider pid after handshake cancellation = %d", pid)
	}

	_ = transport.Stdin.Close()
	if err := Shutdown(context.Background(), dataDir, cfg.SessionID); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

type silentHandshake struct {
	conn net.Conn
	err  error
}

func silentHandshakePeer(t *testing.T) (string, <-chan silentHandshake) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	accepted := make(chan silentHandshake, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr == nil {
			_, acceptErr = bufio.NewReader(conn).ReadBytes('\n')
		}
		accepted <- silentHandshake{conn: conn, err: acceptErr}
	}()
	return listener.Addr().String(), accepted
}

func awaitSilentHandshake(t *testing.T, accepted <-chan silentHandshake) net.Conn {
	t.Helper()
	select {
	case result := <-accepted:
		if result.err != nil {
			t.Fatalf("accept silent handshake: %v", result.err)
		}
		return result.conn
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for silent handshake")
		return nil
	}
}

func TestReconcileKeepsDurableSessionAndStopsOrphan(t *testing.T) {
	dataDir := t.TempDir()
	workdir := t.TempDir()
	start := func(sessionID string) <-chan error {
		done := make(chan error, 1)
		cfg := Config{SessionID: sessionID, DataDir: dataDir, Workdir: workdir,
			Env:  append(os.Environ(), "AO_CHAT_HOST_PROVIDER_HELPER=1"),
			Argv: []string{os.Args[0], "-test.run=TestProviderHelper"}}
		go func() { done <- Run(context.Background(), cfg) }()
		_ = awaitDescriptor(t, dataDir, sessionID)
		return done
	}
	keepDone := start("keep")
	orphanDone := start("orphan")

	if err := Reconcile(context.Background(), dataDir, map[string]struct{}{"keep": {}}); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	select {
	case err := <-orphanDone:
		if err != nil {
			t.Fatalf("orphan host exit: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("orphan host survived reconciliation")
	}

	d := awaitDescriptor(t, dataDir, "keep")
	transport, err := attach(context.Background(), d, true)
	if err != nil {
		t.Fatalf("kept host is not attachable: %v", err)
	}
	_ = transport.Stdin.Close()
	if err := Shutdown(context.Background(), dataDir, "keep"); err != nil {
		t.Fatalf("shutdown kept host: %v", err)
	}
	<-keepDone
}

func TestHostLaunchLockFencesConcurrentProvider(t *testing.T) {
	dataDir := t.TempDir()
	cfg := Config{SessionID: "fenced", DataDir: dataDir, Workdir: t.TempDir(),
		Env:  append(os.Environ(), "AO_CHAT_HOST_PROVIDER_HELPER=1"),
		Argv: []string{os.Args[0], "-test.run=TestProviderHelper"}}
	firstDone := make(chan error, 1)
	go func() { firstDone <- Run(context.Background(), cfg) }()
	d := awaitDescriptor(t, dataDir, cfg.SessionID)
	if err := Run(context.Background(), cfg); !errors.Is(err, ErrHostExists) {
		t.Fatalf("second Run error = %v, want ErrHostExists", err)
	}
	if err := Shutdown(context.Background(), dataDir, cfg.SessionID); err != nil {
		t.Fatal(err)
	}
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
	if processalive := d.PID; processalive <= 0 {
		t.Fatalf("host descriptor pid = %d", processalive)
	}
}

func TestAcquireHostLockReclaimsDeadOwner(t *testing.T) {
	dataDir := t.TempDir()
	sessionID := "stale-lock"
	dir, err := hostDir(dataDir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path, err := lockPath(dataDir, sessionID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("2147483647\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	release, err := acquireHostLock(dataDir, sessionID)
	if err != nil {
		t.Fatalf("acquire stale host lock: %v", err)
	}
	release()
}

func TestConnectOrStartWaitsForOldControllerToDetach(t *testing.T) {
	dataDir := t.TempDir()
	cfg := Config{SessionID: "overlap", DataDir: dataDir, Workdir: t.TempDir(),
		Env:  append(os.Environ(), "AO_CHAT_HOST_PROVIDER_HELPER=1"),
		Argv: []string{os.Args[0], "-test.run=TestProviderHelper"}}
	done := make(chan error, 1)
	go func() { done <- Run(context.Background(), cfg) }()
	d := awaitDescriptor(t, dataDir, cfg.SessionID)
	old, err := attach(context.Background(), d, false)
	if err != nil {
		t.Fatal(err)
	}
	connected := make(chan *Transport, 1)
	connectErr := make(chan error, 1)
	go func() {
		transport, err := ConnectOrStart(context.Background(), cfg)
		if err != nil {
			connectErr <- err
			return
		}
		connected <- transport
	}()
	select {
	case <-connected:
		t.Fatal("replacement attached while old controller still owned the host")
	case err := <-connectErr:
		t.Fatalf("replacement failed during expected overlap: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	_ = old.Stdin.Close()
	var replacement *Transport
	select {
	case replacement = <-connected:
	case err := <-connectErr:
		t.Fatalf("replacement attach: %v", err)
	case <-time.After(3 * time.Second):
		t.Fatal("replacement did not attach after old controller detached")
	}
	_ = replacement.Stdin.Close()
	if err := Shutdown(context.Background(), dataDir, cfg.SessionID); err != nil {
		t.Fatal(err)
	}
	<-done
}

func awaitDescriptor(t *testing.T, dataDir, sessionID string) Descriptor {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		d, err := readDescriptor(dataDir, sessionID)
		if err == nil {
			return d
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("chat host descriptor not published")
	return Descriptor{}
}

func awaitAttach(t *testing.T, d Descriptor) *Transport {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		transport, err := attach(context.Background(), d, true)
		if err == nil {
			return transport
		}
		if !errors.Is(err, ErrAttached) {
			t.Fatalf("attach: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("host never released detached controller")
	return nil
}

func requestProviderPID(t *testing.T, transport *Transport, id int64, method string) int {
	t.Helper()
	if _, err := fmt.Fprintf(transport.Stdin, `{"id":%d,"method":%q}`+"\n", id, method); err != nil {
		t.Fatalf("provider request: %v", err)
	}
	line, err := bufio.NewReader(transport.Stdout).ReadBytes('\n')
	if err != nil {
		t.Fatalf("provider response: %v", err)
	}
	var response struct {
		ID     int64 `json:"id"`
		Result struct {
			PID int `json:"pid"`
		} `json:"result"`
	}
	if err := json.Unmarshal(line, &response); err != nil {
		t.Fatalf("decode provider response %q: %v", line, err)
	}
	if response.ID != id || response.Result.PID <= 0 {
		t.Fatalf("provider response = id:%d pid:%s", response.ID, strconv.Itoa(response.Result.PID))
	}
	return response.Result.PID
}
