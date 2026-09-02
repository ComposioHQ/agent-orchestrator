//go:build !darwin

package claudecode

import "context"

type unsupportedClaudeKeychain struct{}

// NewKeychain returns an unsupported credential store on non-macOS platforms.
func NewKeychain() Keychain { return unsupportedClaudeKeychain{} }

func (unsupportedClaudeKeychain) Supported() bool { return false }

func (unsupportedClaudeKeychain) Get(context.Context, string, string) ([]byte, bool, error) {
	return nil, false, ErrKeychainUnavailable
}

func (unsupportedClaudeKeychain) Set(context.Context, string, string, []byte) error {
	return ErrKeychainUnavailable
}

func (unsupportedClaudeKeychain) Delete(context.Context, string, string) error {
	return ErrKeychainUnavailable
}
