//go:build darwin

package claudecode

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestMacOSKeychainWriteKeepsCredentialOutOfArgv(t *testing.T) {
	const secret = `{"claudeAiOauth":{"accessToken":"top-secret"}}`
	var gotArgs []string
	var gotInput []byte
	store := &macOSClaudeKeychain{
		run: func(_ context.Context, args []string, input []byte) ([]byte, int, error) {
			gotArgs = append([]string(nil), args...)
			gotInput = append([]byte(nil), input...)
			return nil, 0, nil
		},
	}

	if err := store.set(context.Background(), "service", "account", []byte(secret)); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(gotArgs, " "), secret) || strings.Contains(strings.Join(gotArgs, " "), "top-secret") {
		t.Fatalf("secret leaked into argv: %#v", gotArgs)
	}
	if !bytes.Equal(gotArgsBytes(gotArgs), []byte("-i")) {
		t.Fatalf("security argv = %#v, want [-i]", gotArgs)
	}
	if !bytes.Contains(gotInput, []byte("add-generic-password -U")) || !bytes.Contains(gotInput, []byte("746f702d736563726574")) {
		t.Fatalf("stdin command did not contain the hex-encoded credential: %q", gotInput)
	}
}

func gotArgsBytes(args []string) []byte { return []byte(strings.Join(args, " ")) }

func TestMacOSKeychainReadDistinguishesMissingFromFailure(t *testing.T) {
	store := &macOSClaudeKeychain{run: func(_ context.Context, _ []string, _ []byte) ([]byte, int, error) {
		return nil, 44, nil
	}}
	if value, ok, err := store.get(context.Background(), "service", "account"); err != nil || ok || value != nil {
		t.Fatalf("missing read = value %q ok=%v err=%v", value, ok, err)
	}

	store.run = func(_ context.Context, _ []string, _ []byte) ([]byte, int, error) {
		return nil, 36, nil
	}
	if _, _, err := store.get(context.Background(), "service", "account"); err == nil {
		t.Fatal("locked/denied Keychain error was treated as a missing item")
	}
}
