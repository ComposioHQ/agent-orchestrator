//go:build windows

package persistenthost

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
)

func TestDetachedHostProviderDoesNotAllocateConsoleWindow(t *testing.T) {
	dataDir := t.TempDir()
	cfg := Config{
		SessionID: "hidden-provider", DataDir: dataDir, Workdir: t.TempDir(),
		Env:  append(os.Environ(), "AO_CHAT_HOST_PROVIDER_HELPER=1"),
		Argv: []string{os.Args[0], "-test.run=TestProviderHelper"},
	}
	transport, err := ConnectOrStart(context.Background(), cfg)
	if err != nil {
		t.Fatalf("ConnectOrStart: %v", err)
	}
	t.Cleanup(func() {
		_ = transport.Stdin.Close()
		_ = Shutdown(context.Background(), dataDir, cfg.SessionID)
	})

	if _, err := fmt.Fprintln(transport.Stdin, `{"id":1,"method":"console-window"}`); err != nil {
		t.Fatalf("request console state: %v", err)
	}
	var response struct {
		Result struct {
			Attached bool `json:"attached"`
		} `json:"result"`
	}
	if err := json.NewDecoder(bufio.NewReader(transport.Stdout)).Decode(&response); err != nil {
		t.Fatalf("decode console state: %v", err)
	}
	if response.Result.Attached {
		t.Fatal("provider inherited or allocated a Windows console window")
	}
}
