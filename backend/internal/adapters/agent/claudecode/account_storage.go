package claudecode

import (
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
	if len(root["claudeAiOauth"]) == 0 || string(root["claudeAiOauth"]) == "null" {
		return nil, errors.New("Claude credential is missing claudeAiOauth")
	}
	for key := range claudeSharedCredentialFields {
		delete(root, key)
	}
	return root, nil
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
