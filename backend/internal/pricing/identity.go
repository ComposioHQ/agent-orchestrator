// Package pricing owns shared lookup identity rules for usage pricing.
package pricing

import "strings"

// CanonicalProviderID normalizes a reported provider for exact catalog lookup.
func CanonicalProviderID(raw string) string {
	providerID := strings.ToLower(strings.TrimSpace(raw))
	if providerID == "z.ai" {
		return "zai"
	}
	return providerID
}

// TrustedClaudeBillingProvider narrows one routing string to a billing identity
// AO is willing to record for a Claude session. Anthropic, z.ai, Bedrock and
// Vertex are the four routes Claude Code can take that AO can name; anything
// else is a string of unknown provenance, and recording it is worse than
// recording nothing, because billing_provider_id is write-once and an
// unrecognised value there is unreachable by every later repair.
//
// Codex is deliberately not narrowed this way. Its rollout reports the provider
// its own config selected, which is a durable fact about who billed the session
// even when no catalog can price it, and blanking it would let the model
// fallback bill an OpenRouter or Azure session at OpenAI list rates.
func TrustedClaudeBillingProvider(raw string) string {
	providerID := CanonicalProviderID(raw)
	switch providerID {
	case "anthropic", "zai", "bedrock", "vertex_ai":
		return providerID
	default:
		return ""
	}
}

// CanonicalModelID normalizes a reported model for exact provider-local lookup.
// It removes at most one exact canonical provider prefix.
func CanonicalModelID(providerID, raw string) string {
	modelID := strings.ToLower(strings.TrimSpace(raw))
	prefix := CanonicalProviderID(providerID)
	if prefix != "" {
		modelID = strings.TrimPrefix(modelID, prefix+"/")
	}
	return modelID
}
