package claudecode

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	"golang.org/x/text/unicode/norm"
)

const claudeCanonicalKeychainService = "Claude Code-credentials"

var claudeSharedCredentialFields = map[string]struct{}{
	"mcpOAuth": {}, "mcpOAuthClientConfig": {}, "mcpXaaIdp": {},
	"mcpXaaIdpConfig": {}, "pluginSecrets": {},
}

func claudeKeychainServiceName(configDir string) string {
	digest := sha256.Sum256([]byte(norm.NFC.String(configDir)))
	return claudeCanonicalKeychainService + "-" + hex.EncodeToString(digest[:4])
}

func claudeAccountCredentialFields(data []byte) (map[string]json.RawMessage, error) {
	var root map[string]json.RawMessage
	if err := json.Unmarshal(data, &root); err != nil {
		return nil, err
	}
	present, err := claudeAccountCredentialPresent(root["claudeAiOauth"])
	if err != nil {
		return nil, err
	}
	if !present {
		return nil, errors.New("claude credential is missing claudeAiOauth")
	}
	for key := range claudeSharedCredentialFields {
		delete(root, key)
	}
	return root, nil
}

func claudeAccountCredentialPresent(raw json.RawMessage) (bool, error) {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return false, nil
	}
	var credential map[string]json.RawMessage
	if err := json.Unmarshal(raw, &credential); err != nil {
		return false, err
	}
	return len(credential) > 0, nil
}

func mergeClaudeCredentialFields(account map[string]json.RawMessage, live []byte) ([]byte, error) {
	var current map[string]json.RawMessage
	if len(live) > 0 {
		if err := json.Unmarshal(live, &current); err != nil {
			return nil, err
		}
	}
	merged := make(map[string]json.RawMessage, len(account)+len(claudeSharedCredentialFields))
	for key, value := range account {
		merged[key] = value
	}
	for key := range claudeSharedCredentialFields {
		if value, ok := current[key]; ok {
			merged[key] = value
		}
	}
	return json.Marshal(merged)
}

func claudeSharedCredentialProjection(live []byte) ([]byte, error) {
	var current map[string]json.RawMessage
	if err := json.Unmarshal(live, &current); err != nil {
		return nil, err
	}
	shared := make(map[string]json.RawMessage, len(claudeSharedCredentialFields))
	for key := range claudeSharedCredentialFields {
		if value, ok := current[key]; ok {
			shared[key] = value
		}
	}
	return json.Marshal(shared)
}
