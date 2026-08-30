package cli

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func TestCodexLoginRunsFixedNativeLoginMethods(t *testing.T) {
	tests := []struct {
		name      string
		selection string
		secret    string
		wantArgs  []string
		wantStdin string
	}{
		{name: "ChatGPT browser", selection: "1\n", wantArgs: []string{"-c", `cli_auth_credentials_store="file"`, "login"}},
		{name: "device code", selection: "2\n", wantArgs: []string{"-c", `cli_auth_credentials_store="file"`, "login", "--device-auth"}},
		{name: "API key", selection: "3\n", secret: "sk-test-secret", wantArgs: []string{"-c", `cli_auth_credentials_store="file"`, "login", "--with-api-key"}, wantStdin: "sk-test-secret\n"},
		{name: "access token", selection: "4\n", secret: "token-test-secret", wantArgs: []string{"-c", `cli_auth_credentials_store="file"`, "login", "--with-access-token"}, wantStdin: "token-test-secret\n"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var stdout bytes.Buffer
			var gotName string
			var gotArgs []string
			var gotStdin string
			deps := Deps{
				In:       strings.NewReader(tt.selection),
				Out:      &stdout,
				Err:      &stdout,
				LookPath: func(string) (string, error) { return "/usr/local/bin/codex", nil },
				ReadSecret: func(io.Reader) ([]byte, error) {
					return []byte(tt.secret), nil
				},
				ValidateOpenAIAPIKey: func(context.Context, []byte) error { return nil },
				RunInteractiveCommand: func(_ context.Context, name string, args []string, stdin io.Reader, _, _ io.Writer) error {
					gotName = name
					gotArgs = append([]string(nil), args...)
					if stdin != nil {
						data, _ := io.ReadAll(stdin)
						gotStdin = string(data)
					}
					return nil
				},
			}

			cmd := newCodexLoginCommand(&commandContext{deps: deps.withDefaults()})
			cmd.SetIn(deps.In)
			cmd.SetOut(deps.Out)
			cmd.SetErr(deps.Err)
			if err := cmd.Execute(); err != nil {
				t.Fatalf("Execute: %v", err)
			}

			if gotName != "/usr/local/bin/codex" {
				t.Errorf("executable = %q, want resolved Codex", gotName)
			}
			if !slices.Equal(gotArgs, tt.wantArgs) {
				t.Errorf("args = %q, want %q", gotArgs, tt.wantArgs)
			}
			if gotStdin != tt.wantStdin {
				t.Errorf("stdin = %q, want %q", gotStdin, tt.wantStdin)
			}
			if tt.secret != "" && strings.Contains(stdout.String(), tt.secret) {
				t.Fatalf("secret leaked into output: %q", stdout.String())
			}
			for _, arg := range gotArgs {
				if tt.secret != "" && strings.Contains(arg, tt.secret) {
					t.Fatalf("secret leaked into argv: %q", gotArgs)
				}
			}
		})
	}
}

func TestCodexLoginRejectsInvalidAPIKeyBeforeSavingIt(t *testing.T) {
	const secret = "sk-invalid-secret"
	validated := false
	run := false
	var stdout bytes.Buffer
	deps := Deps{
		In:       strings.NewReader("3\n"),
		Out:      &stdout,
		Err:      &stdout,
		LookPath: func(string) (string, error) { return "/codex", nil },
		ReadSecret: func(io.Reader) ([]byte, error) {
			return []byte(secret), nil
		},
		ValidateOpenAIAPIKey: func(_ context.Context, key []byte) error {
			validated = true
			if string(key) != secret {
				t.Fatalf("validated key = %q, want test secret", key)
			}
			return errors.New("OpenAI rejected this API key")
		},
		RunInteractiveCommand: func(context.Context, string, []string, io.Reader, io.Writer, io.Writer) error {
			run = true
			return nil
		},
	}

	cmd := newCodexLoginCommand(&commandContext{deps: deps.withDefaults()})
	cmd.SetIn(deps.In)
	cmd.SetOut(deps.Out)
	cmd.SetErr(deps.Err)
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), "OpenAI rejected this API key") {
		t.Fatalf("Execute error = %v, want rejected-key error", err)
	}
	if !validated {
		t.Fatal("API key was not validated")
	}
	if run {
		t.Fatal("Codex login ran after validation failed")
	}
	if strings.Contains(stdout.String(), secret) || strings.Contains(err.Error(), secret) {
		t.Fatal("invalid API key leaked into output or error")
	}
}

func TestValidateOpenAIAPIKeyUsesBearerAuthAndRejectsUnauthorized(t *testing.T) {
	const secret = "sk-validation-secret"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer "+secret {
			t.Errorf("Authorization = %q, want bearer test key", got)
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	t.Cleanup(server.Close)

	err := validateOpenAIAPIKeyAt(context.Background(), server.Client(), server.URL, []byte(secret))
	if err == nil || !strings.Contains(err.Error(), "OpenAI rejected this API key") {
		t.Fatalf("validation error = %v, want rejected-key error", err)
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatal("validation error leaked the API key")
	}
}

func TestCodexLoginMenuGuidesUsersThroughEverySupportedMethod(t *testing.T) {
	var stdout bytes.Buffer
	deps := Deps{
		In:                   strings.NewReader("x\n"),
		Out:                  &stdout,
		Err:                  &stdout,
		LookPath:             func(string) (string, error) { return "/codex", nil },
		ValidateOpenAIAPIKey: func(context.Context, []byte) error { return nil },
	}
	cmd := newCodexLoginCommand(&commandContext{deps: deps.withDefaults()})
	cmd.SetIn(deps.In)
	cmd.SetOut(deps.Out)
	cmd.SetErr(deps.Err)
	if err := cmd.Execute(); err == nil {
		t.Fatal("Execute error = nil, want invalid selection error")
	}
	wantInOrder := []string{
		"Sign in to Codex",
		"Choose how you want to authenticate this profile.",
		"PERSONAL ACCOUNT",
		"ChatGPT in browser",
		"Recommended",
		"Continue using your ChatGPT account",
		"Device code",
		"Sign in on another device",
		"DEVELOPER CREDENTIALS",
		"OpenAI API key",
		"validated before being saved",
		"Access token",
		"advanced or managed environments",
		"Ctrl+C to cancel",
		"Secret input stays hidden",
	}
	remaining := stdout.String()
	for _, fragment := range wantInOrder {
		index := strings.Index(remaining, fragment)
		if index < 0 {
			t.Fatalf("menu missing or misordered %q:\n%s", fragment, stdout.String())
		}
		remaining = remaining[index+len(fragment):]
	}
}

func TestCodexLoginReportsCredentialVerificationAndCompletion(t *testing.T) {
	var stdout bytes.Buffer
	deps := Deps{
		In:       strings.NewReader("3\n"),
		Out:      &stdout,
		Err:      &stdout,
		LookPath: func(string) (string, error) { return "/codex", nil },
		ReadSecret: func(io.Reader) ([]byte, error) {
			return []byte("sk-test-secret"), nil
		},
		ValidateOpenAIAPIKey: func(context.Context, []byte) error { return nil },
		RunInteractiveCommand: func(context.Context, string, []string, io.Reader, io.Writer, io.Writer) error {
			return nil
		},
	}
	cmd := newCodexLoginCommand(&commandContext{deps: deps.withDefaults()})
	cmd.SetIn(deps.In)
	cmd.SetOut(deps.Out)
	cmd.SetErr(deps.Err)
	if err := cmd.Execute(); err != nil {
		t.Fatalf("Execute: %v", err)
	}

	for _, message := range []string{"Verifying API key with OpenAI", "API key verified", "Codex sign-in complete"} {
		if !strings.Contains(stdout.String(), message) {
			t.Fatalf("output missing progress message %q:\n%s", message, stdout.String())
		}
	}
}

func TestCodexLoginKeepsPipedOutputPlainWhenColorIsForced(t *testing.T) {
	t.Setenv("NO_COLOR", "")
	t.Setenv("FORCE_COLOR", "1")
	var stdout bytes.Buffer
	deps := Deps{
		In:       strings.NewReader("x\n"),
		Out:      &stdout,
		Err:      &stdout,
		LookPath: func(string) (string, error) { return "/codex", nil },
	}
	cmd := newCodexLoginCommand(&commandContext{deps: deps.withDefaults()})
	cmd.SetIn(deps.In)
	cmd.SetOut(deps.Out)
	cmd.SetErr(deps.Err)
	if err := cmd.Execute(); err == nil {
		t.Fatal("Execute error = nil, want invalid selection error")
	}
	if strings.Contains(stdout.String(), "\x1b[") {
		t.Fatalf("piped output contains terminal styling:\n%s", stdout.String())
	}
}

func TestCodexLoginPreservesSecretBufferedWithMenuSelection(t *testing.T) {
	var gotStdin string
	deps := Deps{
		In:                   strings.NewReader("3\nsk-buffered-secret\n"),
		Out:                  io.Discard,
		Err:                  io.Discard,
		LookPath:             func(string) (string, error) { return "/codex", nil },
		ValidateOpenAIAPIKey: func(context.Context, []byte) error { return nil },
		RunInteractiveCommand: func(_ context.Context, _ string, _ []string, stdin io.Reader, _, _ io.Writer) error {
			data, _ := io.ReadAll(stdin)
			gotStdin = string(data)
			return nil
		},
	}
	cmd := newCodexLoginCommand(&commandContext{deps: deps.withDefaults()})
	cmd.SetIn(deps.In)
	cmd.SetOut(deps.Out)
	cmd.SetErr(deps.Err)
	if err := cmd.Execute(); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if gotStdin != "sk-buffered-secret\n" {
		t.Fatalf("Codex stdin = %q, want the buffered secret", gotStdin)
	}
}
