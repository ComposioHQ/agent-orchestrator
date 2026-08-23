package scm

import (
	"fmt"
	"strings"
	"time"
)

// Environment variable names and identities used by the sandbox git wiring.
// The token is passed through the environment of the git child process only.
// It is never placed on a command line: /proc/<pid>/cmdline is world-readable
// inside a container, while /proc/<pid>/environ is not.
const (
	// EnvAskPass is git's hook for supplying a password without a terminal.
	EnvAskPass = "GIT_ASKPASS"
	// EnvUsername and EnvToken are read by the askpass script.
	EnvUsername = "AO_SCM_USERNAME"
	EnvToken    = "AO_SCM_TOKEN" //nolint:gosec // variable name, not a credential
	// CloneUsername is the fixed username GitHub expects alongside an
	// installation access token.
	CloneUsername = "x-access-token"
	// AskPassScriptName is the conventional file name for the helper the
	// compute worker materializes inside the sandbox.
	AskPassScriptName = "ao-scm-askpass"
)

// CloneCredential is the payload the compute worker's bootstrap channel
// delivers into a sandbox. It is deliberately not a JSON document with a
// plaintext token field: transports must call RevealForBootstrap so every
// place the credential is exposed is greppable.
type CloneCredential struct {
	// Repository is the owner/name pair the credential is scoped to.
	Repository string
	// RemoteURL carries the username but never the token, so it is safe to
	// write into .git/config.
	RemoteURL string
	Username  string
	Token     Secret
	ExpiresAt time.Time
	// BotLogin and BotEmail identify the app installation as a git author, so
	// commits made in the sandbox attribute to the app rather than to a human.
	BotLogin string
	BotEmail string
	// Purpose records whether this credential can push.
	Purpose string
}

// NewCloneCredential turns a brokered token into a sandbox bootstrap payload.
// host is the git host, normally github.com; tests pass a fake.
func NewCloneCredential(token BrokeredToken, host string) CloneCredential {
	host = strings.TrimSpace(host)
	if host == "" {
		host = "github.com"
	}
	login := strings.TrimSpace(token.BotLogin)
	return CloneCredential{
		Repository: token.Repository,
		RemoteURL:  fmt.Sprintf("https://%s@%s/%s.git", CloneUsername, host, token.Repository),
		Username:   CloneUsername,
		Token:      token.Token,
		ExpiresAt:  token.ExpiresAt,
		BotLogin:   login,
		BotEmail:   botEmail(login),
		Purpose:    token.Purpose,
	}
}

// botEmail is the noreply address GitHub accepts for an app installation.
func botEmail(login string) string {
	if login == "" {
		return ""
	}
	return login + "@users.noreply.github.com"
}

// Expired reports whether the credential is no longer usable. The compute
// worker checks this before reusing a bootstrap payload for a later push and
// asks the control plane to re-broker when it is true.
func (c CloneCredential) Expired(now time.Time) bool {
	return !now.UTC().Before(c.ExpiresAt)
}

// CanPush reports whether this credential was minted with write permission.
func (c CloneCredential) CanPush() bool { return c.Purpose == "push" }

// RevealedCredential is the plaintext form handed to a transport. Constructing
// one is the explicit act of exposing the token.
type RevealedCredential struct {
	Repository string `json:"repository"`
	RemoteURL  string `json:"remoteUrl"`
	Username   string `json:"username"`
	Token      string `json:"token"`
	ExpiresAt  string `json:"expiresAt"`
	BotLogin   string `json:"botLogin"`
	BotEmail   string `json:"botEmail"`
	Purpose    string `json:"purpose"`
}

// RevealForBootstrap produces the plaintext payload for the sandbox bootstrap
// channel. Callers must send it over an authenticated, encrypted transport and
// must not log it.
func (c CloneCredential) RevealForBootstrap() RevealedCredential {
	return RevealedCredential{
		Repository: c.Repository,
		RemoteURL:  c.RemoteURL,
		Username:   c.Username,
		Token:      c.Token.Reveal(),
		ExpiresAt:  c.ExpiresAt.UTC().Format(time.RFC3339),
		BotLogin:   c.BotLogin,
		BotEmail:   c.BotEmail,
		Purpose:    c.Purpose,
	}
}

// GitEnv is the environment for the git child process that uses this
// credential. It must be applied to that process alone — exporting it into the
// agent's shell would leave the token readable for the life of the sandbox.
//
// credential.helper is explicitly cleared so no inherited or system helper can
// write the token to ~/.git-credentials, and GIT_TERMINAL_PROMPT=0 makes an
// auth failure an error rather than a hang.
func (c CloneCredential) GitEnv(askPassPath string) []string {
	return []string{
		EnvAskPass + "=" + askPassPath,
		EnvUsername + "=" + c.Username,
		EnvToken + "=" + c.Token.Reveal(),
		"GIT_TERMINAL_PROMPT=0",
		"GIT_CONFIG_COUNT=2",
		"GIT_CONFIG_KEY_0=credential.helper",
		"GIT_CONFIG_VALUE_0=",
		"GIT_CONFIG_KEY_1=credential.useHttpPath",
		"GIT_CONFIG_VALUE_1=true",
	}
}

// AskPassScript is the helper git invokes to obtain the credential. It holds
// no secret itself: the token arrives through the environment of the git
// process that spawned it, so the script may be written to the sandbox
// filesystem and left there without leaking anything.
//
// Nothing here persists the credential. When the git process exits, the only
// copy of the token in the sandbox is gone.
func AskPassScript() string {
	return `#!/bin/sh
# AO cloud SCM askpass helper. The credential is supplied through the
# environment of the invoking git process and is never written to disk.
set -eu
case "$1" in
*[Uu]sername*)
	printf '%s\n' "${` + EnvUsername + `:-}"
	;;
*)
	printf '%s\n' "${` + EnvToken + `:-}"
	;;
esac
`
}
