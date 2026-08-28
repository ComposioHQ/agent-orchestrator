package codexappserver

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/aoagents/agent-orchestrator/backend/internal/adapters/chatdriver/codexappserver/codexproto"
	"github.com/aoagents/agent-orchestrator/backend/internal/domain"
	"github.com/aoagents/agent-orchestrator/backend/internal/ports"
)

func TestAccountFactoryUsesManagedHomeAndFileCredentialStore(t *testing.T) {
	serverReads, clientWrites := io.Pipe()
	clientReads, serverWrites := io.Pipe()
	var gotArgs []string
	var gotEnv []string
	factory := NewAccountFactory(fakePlugin{bin: "codex"}, slog.New(slog.DiscardHandler))
	factory.spawn = func(_ context.Context, _, _ string, env, args []string) (*process, error) {
		gotArgs, gotEnv = append([]string(nil), args...), append([]string(nil), env...)
		return &process{stdin: clientWrites, stdout: clientReads, stop: func() error { return serverWrites.Close() }}, nil
	}
	go serveAccountTestProtocol(serverReads, serverWrites, map[string]any{
		"initialize":   map[string]any{},
		"account/read": map[string]any{"account": map[string]any{"type": "chatgpt", "email": "person@example.com", "planType": "pro"}, "requiresOpenaiAuth": true},
	})
	home := t.TempDir()
	if err := os.Chmod(home, 0o700); err != nil {
		t.Fatal(err)
	}
	client, err := factory.Open(context.Background(), ports.CodexAccountProfile{Home: home, Managed: true})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	account, err := client.Read(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(gotArgs, []string{"-c", `cli_auth_credentials_store="file"`, "app-server"}) {
		t.Fatalf("args = %#v", gotArgs)
	}
	if !slices.ContainsFunc(gotEnv, func(value string) bool {
		return len(value) > len("CODEX_HOME=") && value[:len("CODEX_HOME=")] == "CODEX_HOME="
	}) {
		t.Fatalf("env does not contain CODEX_HOME: %#v", gotEnv)
	}
	if account.Authentication != domain.AgentAuthenticationAuthorized || account.Method != domain.CodexAuthMethodChatGPT || account.Email == nil || *account.Email != "person@example.com" {
		t.Fatalf("account = %#v", account)
	}
}

func TestAccountReadMapsExplicitSignedOutAndNotApplicable(t *testing.T) {
	for _, test := range []struct {
		name     string
		requires bool
		want     domain.AgentAuthenticationState
	}{
		{"signed out", true, domain.AgentAuthenticationUnauthorized},
		{"not applicable", false, domain.AgentAuthenticationNotApplicable},
	} {
		t.Run(test.name, func(t *testing.T) {
			serverReads, clientWrites := io.Pipe()
			clientReads, serverWrites := io.Pipe()
			factory := NewAccountFactory(fakePlugin{bin: "codex"}, nil)
			factory.spawn = func(context.Context, string, string, []string, []string) (*process, error) {
				return &process{stdin: clientWrites, stdout: clientReads, stop: func() error { return serverWrites.Close() }}, nil
			}
			go serveAccountTestProtocol(serverReads, serverWrites, map[string]any{"initialize": map[string]any{}, "account/read": map[string]any{"requiresOpenaiAuth": test.requires}})
			client, err := factory.Open(context.Background(), ports.CodexAccountProfile{Home: t.TempDir()})
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			account, err := client.Read(context.Background(), false)
			if err != nil {
				t.Fatal(err)
			}
			if account.Authentication != test.want {
				t.Fatalf("authentication = %q, want %q", account.Authentication, test.want)
			}
		})
	}
}

func TestAccountFactoryExistingProfileDoesNotOverrideCredentialStore(t *testing.T) {
	serverReads, clientWrites := io.Pipe()
	clientReads, serverWrites := io.Pipe()
	var gotArgs, gotEnv []string
	home := t.TempDir()
	factory := NewAccountFactory(fakePlugin{bin: "codex"}, nil)
	factory.spawn = func(_ context.Context, _, workdir string, env, args []string) (*process, error) {
		if workdir != home {
			t.Fatalf("workdir = %q, want %q", workdir, home)
		}
		gotArgs, gotEnv = append([]string(nil), args...), append([]string(nil), env...)
		return &process{stdin: clientWrites, stdout: clientReads, stop: func() error { return serverWrites.Close() }}, nil
	}
	go serveAccountTestProtocol(serverReads, serverWrites, map[string]any{"initialize": map[string]any{}})
	client, err := factory.Open(context.Background(), ports.CodexAccountProfile{Home: home})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if !slices.Equal(gotArgs, []string{"app-server"}) {
		t.Fatalf("args = %#v", gotArgs)
	}
	if slices.ContainsFunc(gotArgs, func(value string) bool { return value == `cli_auth_credentials_store="file"` }) {
		t.Fatalf("existing profile credential store was overridden: %#v", gotArgs)
	}
	if !slices.Contains(gotEnv, "CODEX_HOME="+home) {
		t.Fatalf("env does not explicitly select existing home: %#v", gotEnv)
	}
}

func TestInspectCodexSchemaDirectoryMapsSupportedUnsupportedAndUnreadable(t *testing.T) {
	dir := t.TempDir()
	allMethods := []string{
		codexproto.MethodAccountRead,
		codexproto.MethodAccountLoginStart,
		codexproto.MethodAccountLoginCancel,
		codexproto.MethodAccountLoginCompleted,
		codexproto.MethodAccountUpdated,
	}
	data, err := json.Marshal(map[string]any{"methods": allMethods})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "schema.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	capabilities := inspectCodexSchemaDirectory(dir)
	if capabilities.AccountRead.State != domain.CodexCapabilitySupported || capabilities.BrowserLogin.State != domain.CodexCapabilitySupported {
		t.Fatalf("supported capabilities = %#v", capabilities)
	}
	if err := os.WriteFile(path, []byte(`{"methods":["account/read"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	capabilities = inspectCodexSchemaDirectory(dir)
	if capabilities.AccountRead.State != domain.CodexCapabilitySupported || capabilities.BrowserLogin.State != domain.CodexCapabilityUnsupported {
		t.Fatalf("read-only capabilities = %#v", capabilities)
	}
	if err := os.WriteFile(path, []byte(`not-json "account/read"`), 0o600); err != nil {
		t.Fatal(err)
	}
	capabilities = inspectCodexSchemaDirectory(dir)
	if capabilities.AccountRead.State != domain.CodexCapabilityUnknown || capabilities.BrowserLogin.State != domain.CodexCapabilityUnknown {
		t.Fatalf("unreadable capabilities = %#v", capabilities)
	}
}

func TestSafeCodexAccountEmailRejectsControlCharacters(t *testing.T) {
	unsafe := "person@example.com\nsecret"
	if safeCodexAccountEmail(&unsafe) != nil {
		t.Fatal("unsafe account email was retained")
	}
	safe := " person@example.com "
	got := safeCodexAccountEmail(&safe)
	if got == nil || *got != "person@example.com" {
		t.Fatalf("safe email = %#v", got)
	}
}

func serveAccountTestProtocol(reader io.Reader, writer io.Writer, responses map[string]any) {
	scanner := bufio.NewScanner(reader)
	for scanner.Scan() {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if json.Unmarshal(scanner.Bytes(), &request) != nil || len(request.ID) == 0 {
			continue
		}
		result, ok := responses[request.Method]
		if !ok {
			result = map[string]any{}
		}
		response, _ := json.Marshal(map[string]any{"id": request.ID, "result": result})
		_, _ = writer.Write(append(response, '\n'))
	}
}
